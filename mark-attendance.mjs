#!/usr/bin/env node
// Marks Zoom-class attendance into the MSDSM coursewise attendance sheet.
//
// Pipeline:
//   0. If not already in the configured Zoom meeting (and not reading from
//      --participants-file), join it muted/video-off, and leave again at
//      the end -- but only if we're the one who joined. A meeting already
//      running when this starts is left exactly as found. See
//      lib/zoomMeeting.mjs for how join/leave/mute are actually driven.
//   1. Read the schedule .xlsx (Drive, view-only) -> figure out which
//      subject(s) plausibly correspond to "the class we're in / just
//      finished", from today's date + current time vs the configured slots.
//   2. Read the live Zoom participant list -- via a macOS Accessibility
//      read of the open Participants window, not "Copy Participant List"
//      (that menu option turned out to be host/co-host only). See
//      lib/participants.mjs for the mechanics and why they're reliable.
//   3. Match each participant against the subject's roster tab(s) in the
//      attendance sheet (roll number > exact name > confident fuzzy name;
//      anything else is reported, not guessed).
//   4. Write "Present" into the right session column for confident matches
//      only, and only into currently-blank cells (idempotent).
//
// Usage:
//   node mark-attendance.mjs                       # dry run (default) -- prints the plan, writes nothing
//   node mark-attendance.mjs --apply                # actually writes to the sheet
//   node mark-attendance.mjs --subject ME           # override auto-detected subject (abbreviation or "DSM 107")
//   node mark-attendance.mjs --session 5            # override auto-picked session column
//   node mark-attendance.mjs --participants-file p.txt   # read participant list from a file, skipping Zoom entirely
//   node mark-attendance.mjs --no-leave             # don't auto-leave even if we're the one who joined
//   node mark-attendance.mjs --config path/to/config.json
//   node mark-attendance.mjs --apply --unattended   # for the scheduled launchd job -- see below

import { google } from "googleapis";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";

import { getGoogleAuthClient } from "./lib/googleAuth.mjs";
import { fetchScheduleWorkbook, parseTimetable, parseLegend, findCandidateSessions, countSessionOccurrences } from "./lib/schedule.mjs";
import { listSubjectTabs, loadTab, pickActiveTab, writePresent } from "./lib/attendanceSheet.mjs";
import { loadParticipants } from "./lib/participants.mjs";
import { matchParticipant } from "./lib/match.mjs";
import { isInMeeting, joinMeeting, leaveMeeting, ensureParticipantsPanelOpen, ensureMutedAndVideoOff } from "./lib/zoomMeeting.mjs";
import { makeRunId, logRun, logParticipants } from "./lib/analytics.mjs";
import { sendNotification } from "./lib/notify.mjs";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const NO_LEAVE = args.includes("--no-leave");
// --unattended is for the scheduled launchd job only (see
// docs/background-automation.md's pattern + scripts/attendance's own
// launchd files): no readline prompt exists in that context (no TTY), so
// instead of blocking forever on rl.question() when the schedule is
// ambiguous or nothing's on today, it logs the outcome, emails a report via
// lib/notify.mjs, and exits cleanly -- exactly the "skip and log" behavior
// the interactive manual-prompt gives a human, minus the human.
const UNATTENDED = args.includes("--unattended");
const flagValue = (name) => {
  const idx = args.indexOf(name);
  return idx !== -1 ? args[idx + 1] : undefined;
};
const SUBJECT_OVERRIDE = flagValue("--subject");
const SESSION_OVERRIDE = flagValue("--session") ? parseInt(flagValue("--session"), 10) : null;
const PARTICIPANTS_FILE = flagValue("--participants-file");
const CONFIG_PATH = flagValue("--config") ?? new URL("./config.json", import.meta.url).pathname;

function expandHome(p) {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

function loadConfig() {
  const configDir = path.dirname(CONFIG_PATH);
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  raw.googleOAuth.clientSecretFile = path.resolve(configDir, raw.googleOAuth.clientSecretFile);
  raw.googleOAuth.tokenFile = expandHome(raw.googleOAuth.tokenFile);
  raw.logging.runsLogFile = expandHome(raw.logging.runsLogFile);
  raw.logging.participantsLogFile = expandHome(raw.logging.participantsLogFile);
  raw.notifications.tokenFile = expandHome(raw.notifications.tokenFile);
  return raw;
}

function resolveSubjectArg(rawArg, subjectCodeMap) {
  const s = rawArg.trim();
  if (/^DSM\s*\d{3}$/i.test(s)) return `DSM ${s.match(/\d{3}/)[0]}`;
  return subjectCodeMap[s.toUpperCase()] ?? null;
}

// Fetches + parses the schedule once, needed both for subject auto-detection
// and for computing the authoritative session number (see
// countSessionOccurrences in lib/schedule.mjs) -- skipped entirely only when
// both --subject and --session are given explicitly, since nothing in this
// run would use it.
async function loadTimetable(config, drive) {
  console.log("Reading schedule sheet...");
  const workbook = await fetchScheduleWorkbook(drive, config.scheduleFile.id);
  const timetableRows = parseTimetable(workbook, config.scheduleFile.sheetName, config.scheduleFile.legendMarker);

  const legend = parseLegend(workbook, config.scheduleFile.sheetName, config.scheduleFile.legendMarker);
  for (const [abbrev, code] of Object.entries(legend)) {
    if (config.subjectCodeMap[abbrev] && config.subjectCodeMap[abbrev] !== code) {
      console.warn(`WARNING: config.json's subjectCodeMap["${abbrev}"] = "${config.subjectCodeMap[abbrev]}" but the schedule's own legend says "${code}" -- update config.json if the schedule changed.`);
    }
  }
  return timetableRows;
}

// Returns { subjectCode, detection: "override"|"auto-live"|"auto-recent"|"manual-prompt"|"skipped-no-schedule"|"skipped-ambiguous", scheduleSlot, skipInfo }
// -- scheduleSlot (label/rawCell/tier) is null for "override", populated
// otherwise, for the run log to capture exactly how the subject was decided
// without having to re-derive it from prose. subjectCode is null only for
// the two "skipped-*" outcomes (--unattended only -- see below); skipInfo
// carries what a human/notification needs to explain why.
async function pickSubject(config, timetableRows, rl) {
  if (SUBJECT_OVERRIDE) {
    const resolved = resolveSubjectArg(SUBJECT_OVERRIDE, config.subjectCodeMap);
    if (!resolved) throw new Error(`--subject "${SUBJECT_OVERRIDE}" isn't a known abbreviation or "DSM <N>" code.`);
    console.log(`Using --subject override: ${resolved}`);
    return { subjectCode: resolved, detection: "override", scheduleSlot: null };
  }

  const { todayRow, candidates, allToday, tier } = findCandidateSessions(timetableRows, config, new Date());
  if (!todayRow) {
    if (UNATTENDED) {
      console.log("Today's date isn't in the schedule sheet -- skipping (unattended).");
      return { subjectCode: null, detection: "skipped-no-schedule", scheduleSlot: null, skipInfo: { reason: "Today's date isn't in the schedule sheet." } };
    }
    throw new Error("Today's date isn't in the schedule sheet. Pass --subject to skip auto-detection.");
  }
  if (candidates.length === 1) {
    const c = candidates[0];
    const tierDesc = tier === "live" ? "is happening right now" : "ended a while ago but is the most recent class today";
    console.log(`Auto-detected: ${c.subjectCode} (${c.slot.label}, "${c.rawCell}") ${tierDesc}.`);
    return { subjectCode: c.subjectCode, detection: `auto-${tier}`, scheduleSlot: { label: c.slot.label, rawCell: c.rawCell, tier } };
  }

  console.log("\nCouldn't auto-detect a single current class. Today's scheduled classes:");
  if (allToday.length === 0) console.log("  (none found -- check schedule sheet, or pass --subject explicitly)");
  for (const c of allToday) console.log(`  ${c.slot.label} (${c.slot.start}-${c.slot.end}): ${c.subjectCode}  [raw: "${c.rawCell}"]`);
  if (candidates.length > 1) console.log(`\n${candidates.length} classes are equally "${tier}" right now -- ambiguous.`);

  if (UNATTENDED) {
    // Two distinct "can't auto-pick" outcomes, kept separately labeled so
    // logs/emails don't call a quiet moment "ambiguous":
    //   - true ambiguity: findCandidateSessions() returned >1 slot in the
    //     same tier at once (ties within one tier aren't resolved
    //     automatically -- see findCandidateSessions).
    //   - nothing live: candidates.length === 0 -- no slot fell in either
    //     the live or recent-grace window at this moment (the normal case
    //     for most of the 18 scheduled firings/day, since each subject only
    //     actually meets on some of them).
    // Either way: no readline prompt exists in this context (no TTY --
    // launchd), so don't guess. Log + notify + exit clean, exactly like
    // "skip and log" would for a human choosing not to guess.
    const isAmbiguous = candidates.length > 1;
    const reason = isAmbiguous
      ? `${candidates.length} classes (${candidates.map((c) => c.subjectCode).join(", ")}) are equally "${tier}" right now.`
      : "No scheduled class slot is currently live or within its recent-grace window.";
    console.log(`Skipping (unattended): ${reason}`);
    return { subjectCode: null, detection: isAmbiguous ? "skipped-ambiguous" : "skipped-none-live", scheduleSlot: null, skipInfo: { reason, allToday: allToday.map((c) => ({ label: c.slot.label, subjectCode: c.subjectCode, rawCell: c.rawCell })) } };
  }

  const answer = await rl.question("\nEnter the subject code/abbreviation to use (or Ctrl+C to abort): ");
  const resolved = resolveSubjectArg(answer, config.subjectCodeMap);
  if (!resolved) throw new Error(`"${answer}" isn't a known abbreviation or "DSM <N>" code.`);
  return { subjectCode: resolved, detection: "manual-prompt", scheduleSlot: null };
}

async function main() {
  const config = loadConfig();
  const authClient = await getGoogleAuthClient(config.googleOAuth.clientSecretFile, config.googleOAuth.tokenFile);
  const sheets = google.sheets({ version: "v4", auth: authClient });
  const drive = google.drive({ version: "v3", auth: authClient });

  // No readline in --unattended (no TTY under launchd, and pickSubject
  // never calls rl.question() in that mode anyway -- see there).
  const rl = UNATTENDED ? null : readline.createInterface({ input: process.stdin, output: process.stdout });

  const runId = makeRunId();
  const runStartedAt = Date.now();
  let joinedByUs = false;

  try {
    // Schedule detection happens BEFORE touching Zoom at all, deliberately
    // reordered from an earlier version that joined the meeting first: an
    // --unattended run firing on a holiday/no-class day (or into an
    // ambiguous window) should never even open Zoom. Skip the schedule
    // fetch entirely only when nothing in this run would use it (both
    // subject and session pinned explicitly).
    const timetableRows = SUBJECT_OVERRIDE && SESSION_OVERRIDE != null ? null : await loadTimetable(config, drive);

    const { subjectCode, detection: subjectDetection, scheduleSlot, skipInfo } = await pickSubject(config, timetableRows, rl);

    if (subjectCode === null) {
      // --unattended skip path (see pickSubject): nothing to do, and
      // nothing was touched (no Zoom join, no sheet write). Still logged +
      // emailed, so a quiet day shows up in runs.jsonl/your inbox rather
      // than just... not running.
      logRun(config.logging.runsLogFile, {
        runId,
        term: config.term,
        apply: APPLY,
        subjectCode: null,
        subjectDetection,
        skipInfo,
        durationMs: Date.now() - runStartedAt,
      });
      const skipLabel = { "skipped-no-schedule": "no schedule entry for today", "skipped-none-live": "no class live right now", "skipped-ambiguous": "ambiguous" }[subjectDetection];
      await sendNotification(config, {
        subject: `Attendance: skipped (${skipLabel})`,
        bodyLines: [skipInfo.reason, "", "Nothing was written; Zoom was never joined.", skipInfo.allToday ? `\nToday's scheduled classes:\n${skipInfo.allToday.map((c) => `  ${c.label}: ${c.subjectCode} [${c.rawCell}]`).join("\n")}` : ""],
      });
      return;
    }

    // Only touch Zoom once we know there's an actual session to mark --
    // --participants-file needs no meeting open. If a meeting's already
    // running (the common case: running this right after class), leave it
    // exactly as we found it -- no join, no leave.
    if (!PARTICIPANTS_FILE) {
      if (!isInMeeting()) {
        console.log(`Not currently in a meeting -- joining ${config.zoom.meetingLink} ...`);
        await joinMeeting(config.zoom.meetingLink, { timeoutSeconds: config.zoom.joinTimeoutSeconds });
        joinedByUs = true;
        ensureMutedAndVideoOff();
        console.log("Joined (muted, video off).");
      }
      ensureParticipantsPanelOpen();
    }

    // The session number is derived from the schedule (how many times this
    // subject has met, chronologically, up to today), not from the
    // attendance sheet's own fill state -- see countSessionOccurrences in
    // lib/schedule.mjs for why: a fill-based "which column looks partially
    // done" heuristic can't distinguish "today's column, partly filled so
    // far" from "a past column with a genuine permanent absentee," and will
    // silently pick the wrong one. --session still wins if given explicitly.
    const sessionDetection = SESSION_OVERRIDE != null ? "override" : "schedule-occurrence-count";
    const sessionNumber = SESSION_OVERRIDE ?? countSessionOccurrences(timetableRows, subjectCode, config, new Date());
    console.log(`Session number: ${sessionNumber}${SESSION_OVERRIDE != null ? " (--session override)" : ` (${subjectCode} has met ${sessionNumber} time(s) up to today, per the schedule)`}`);

    console.log(`\nLoading roster tab(s) for ${subjectCode}...`);
    const tabsBySubject = await listSubjectTabs(sheets, config.attendanceSheet.id, Object.values(config.subjectCodeMap));
    const tabTitles = tabsBySubject[subjectCode] ?? [];
    if (tabTitles.length === 0) {
      throw new Error(`No attendance-sheet tab found starting with "${subjectCode}". Tabs found: ${JSON.stringify(tabsBySubject)}`);
    }
    console.log(`  tab(s): ${tabTitles.join(", ")}`);

    const tabs = [];
    for (const title of tabTitles) tabs.push(await loadTab(sheets, config.attendanceSheet.id, title, config.attendanceSheet.columns));

    // Multiple tabs for one subject are a session-number-range split of the
    // SAME roster, not independent rosters (confirmed against real data --
    // see lib/attendanceSheet.mjs' pickActiveTab) -- so exactly one tab is
    // "active" for this run, and matching happens against that tab alone to
    // avoid double-counting the same student appearing in every tab.
    const { tab, targetCol } = pickActiveTab(tabs, sessionNumber);
    console.log(`  active tab: "${tab.tabTitle}" -> Session ${targetCol.sessionNumber} (${tab.students.length} students)`);

    const participantSource = PARTICIPANTS_FILE ? "file" : "zoom-accessibility";
    console.log(`\nReading participant list${PARTICIPANTS_FILE ? ` from ${PARTICIPANTS_FILE}` : " from Zoom (accessibility read)"}...`);
    const participants = loadParticipants({ participantsFile: PARTICIPANTS_FILE });
    console.log(`  ${participants.length} participant(s) found.`);

    // One record per participant seen, whatever the outcome -- this is what
    // makes "was student X really matched present on date Y, and how
    // confidently" answerable later without re-deriving it from terminal
    // scrollback. Built inline for excluded/unmatched/duplicate (nothing
    // more to learn about those after this point); matched participants get
    // their alreadyMarked/written fields filled in below, once known.
    const participantRecords = [];
    const baseRecord = (p) => ({ runId, subjectCode, tab: tab.tabTitle, sessionNumber: targetCol.sessionNumber, participantRaw: p.raw, participantCleaned: p.cleaned });

    const matched = [];
    const unmatched = [];
    const excluded = [];
    const seenRows = new Map(); // rowIndex -> raw participant name first matched to it
    for (const p of participants) {
      if (p.excludeReason) {
        // Not a name guess -- Zoom's own (Host)/(Co-host) role tag, or a
        // "Prof"/"Dr" title prefix. See lib/participants.mjs for why both
        // signals are used and why neither is a hardcoded name list.
        excluded.push({ participant: p.raw, reason: p.excludeReason });
        participantRecords.push({ ...baseRecord(p), outcome: "excluded", excludeReason: p.excludeReason });
        continue;
      }
      const result = matchParticipant(p, tab.students, config.matching);
      if (result.method === "unmatched") {
        unmatched.push({ participant: p.raw, reason: result.reason });
        participantRecords.push({ ...baseRecord(p), outcome: "unmatched", unmatchedReason: result.reason });
        continue;
      }
      if (seenRows.has(result.student.rowIndex)) {
        // e.g. same student joined from two devices -- logged, not silently
        // dropped, since "who joined twice" is its own useful signal.
        participantRecords.push({
          ...baseRecord(p),
          outcome: "duplicate-device",
          matchMethod: result.method,
          matchScore: result.score,
          matchedStudentName: result.student.name,
          matchedStudentRoll: result.student.rollNumber,
          firstSeenAsParticipant: seenRows.get(result.student.rowIndex),
        });
        continue;
      }
      seenRows.set(result.student.rowIndex, p.raw);
      matched.push({ participant: p, student: result.student, method: result.method, score: result.score });
    }

    console.log(`\nMatched ${matched.length}/${participants.length} participant(s):`);
    for (const m of matched) console.log(`  [${m.method}${m.score < 1 ? ` ${m.score.toFixed(2)}` : ""}] "${m.participant.raw}" -> ${m.student.name} (${m.student.rollNumber})`);
    if (excluded.length > 0) {
      console.log(`\n${excluded.length} excluded as non-student (nothing to do):`);
      for (const e of excluded) console.log(`  "${e.participant}" -- ${e.reason}`);
    }
    if (unmatched.length > 0) {
      console.log(`\n${unmatched.length} participant(s) NOT matched (not written -- review manually):`);
      for (const u of unmatched) console.log(`  "${u.participant}" -- ${u.reason}`);
    }

    for (const m of matched) {
      const cellValue = String(tab.students.find((s) => s.rowIndex === m.student.rowIndex).values[targetCol.index] ?? "").trim();
      m.alreadyMarked = Boolean(cellValue);
    }
    const rowsToMark = matched.map((m) => m.student.rowIndex);
    const alreadyMarkedCount = matched.filter((m) => m.alreadyMarked).length;
    console.log(`\n${tab.tabTitle}: Session ${targetCol.sessionNumber} -- ${rowsToMark.length} matched student(s), ${alreadyMarkedCount} already marked (skipped), ${rowsToMark.length - alreadyMarkedCount} to write.`);

    let written = 0;
    let writtenRowIndices = [];
    if (APPLY) {
      ({ written, writtenRowIndices } = await writePresent(sheets, config.attendanceSheet.id, tab, targetCol, rowsToMark, config.attendanceSheet.presentValue));
      console.log(`\nWrote "${config.attendanceSheet.presentValue}" for ${written} student(s).`);
    } else {
      console.log("\nDry run only -- nothing written. Re-run with --apply to write these to the sheet.");
    }
    const writtenSet = new Set(writtenRowIndices);

    for (const m of matched) {
      participantRecords.push({
        ...baseRecord(m.participant),
        outcome: "matched",
        matchMethod: m.method,
        matchScore: m.score,
        matchedStudentName: m.student.name,
        matchedStudentRoll: m.student.rollNumber,
        matchedRowIndex: m.student.rowIndex,
        alreadyMarked: m.alreadyMarked,
        wouldWrite: !m.alreadyMarked,
        written: writtenSet.has(m.student.rowIndex),
      });
    }

    logRun(config.logging.runsLogFile, {
      runId,
      term: config.term,
      apply: APPLY,
      subjectCode,
      subjectDetection,
      scheduleSlot,
      tab: tab.tabTitle,
      sessionNumber: targetCol.sessionNumber,
      sessionDetection,
      participantSource,
      participantsFile: PARTICIPANTS_FILE ?? null,
      participantsCount: participants.length,
      matchedCount: matched.length,
      excludedCount: excluded.length,
      unmatchedCount: unmatched.length,
      duplicateCount: participantRecords.filter((r) => r.outcome === "duplicate-device").length,
      alreadyMarkedCount,
      writtenCount: written,
      zoomAutoJoined: joinedByUs,
      durationMs: Date.now() - runStartedAt,
    });
    logParticipants(config.logging.participantsLogFile, participantRecords);

    if (UNATTENDED) {
      const summary = `${subjectCode} ${tab.tabTitle} Session ${targetCol.sessionNumber}: ${matched.length}/${participants.length} matched, ${written} written, ${unmatched.length} unmatched, ${excluded.length} excluded.`;
      await sendNotification(config, {
        subject: `Attendance: ${APPLY ? "marked" : "dry-run"} ${subjectCode} S${targetCol.sessionNumber} (${written} written)`,
        bodyLines: [
          summary,
          "",
          unmatched.length > 0 ? `NOT matched (review manually):\n${unmatched.map((u) => `  "${u.participant}" -- ${u.reason}`).join("\n")}` : "Everyone present was matched.",
          "",
          `Detection: ${subjectDetection}${scheduleSlot ? ` (${scheduleSlot.label}, "${scheduleSlot.rawCell}")` : ""}; joined Zoom: ${joinedByUs}.`,
        ],
      });
    }
  } finally {
    rl?.close();
    if (joinedByUs && !NO_LEAVE) {
      console.log("\nLeaving the meeting (we're the ones who joined it)...");
      try {
        await leaveMeeting();
      } catch (err) {
        console.error(`Couldn't confirm leaving the meeting: ${err.message}`);
      }
    }
  }
}

main().catch(async (err) => {
  console.error("\nFAILED:", err.message);
  if (UNATTENDED) {
    try {
      const config = loadConfig();
      await sendNotification(config, { subject: "Attendance: scheduled run FAILED", bodyLines: [err.message, "", "Nothing further was attempted -- run manually to investigate:", "  node mark-attendance.mjs"] });
    } catch {
      // loadConfig()/sendNotification() failing here shouldn't mask the
      // original error or change the exit code below.
    }
  }
  process.exit(1);
});
