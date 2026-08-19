// Getting the Zoom participant list.
//
// Originally this was meant to rely on Zoom's built-in "Participants panel
// -> ... -> Copy Participant List", read off the clipboard. Verified live
// against a real meeting that that menu option doesn't exist for a plain
// participant (only host/co-host get it) -- so that path is unusable here
// by default, not just theoretically fragile.
//
// What DOES work, verified against the same live meeting: reading the
// participant names directly off the Participants window's accessibility
// tree via System Events. Two non-obvious things had to be true for this to
// be reliable, both confirmed by testing, not assumed:
//
//   1. Zoom must be the frontmost application when queried. Its floating
//      panel windows (Participants, in particular) stop appearing in the
//      accessibility tree entirely once Zoom loses focus -- `activate`
//      brings them back immediately. Skipping this makes the window lookup
//      fail intermittently depending on what app last had focus, which
//      looks like a flaky bug if you don't know to check for it.
//   2. The participant list is virtualized (an AXOutline, like a table
//      view) -- only rows currently scrolled into view have a real static
//      text child; rows outside the viewport throw "Invalid index" when
//      queried. Reading it once only gets whoever happened to be visible.
//      The fix is to drive scroll bar's `value` (0.0-1.0) through a spread
//      of positions and take the union of names seen at each stop.
//
// This still degrades gracefully: if accessibility access isn't granted, or
// Zoom's window layout changes in a future version and this breaks, the
// error is explicit and --participants-file lets you paste a manually
// typed/copied list instead of blocking the whole tool on this one step.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const READ_ROWS_SCRIPT = path.join(os.tmpdir(), "attendance-sync-read-rows.applescript");
const SET_SCROLL_SCRIPT = path.join(os.tmpdir(), "attendance-sync-set-scroll.applescript");

// Written to disk once rather than passed as -e strings: these are
// non-trivial AppleScript with their own control flow, easier to keep
// correct as real files (and to inspect/tweak by hand if Zoom's UI ever
// shifts) than to fight shell quoting for.
const READ_ROWS_SOURCE = `
tell application "System Events"
  tell process "zoom.us"
    set targetWindow to missing value
    repeat with w in windows
      try
        if (name of w as string) starts with "Participants" then
          set targetWindow to w
          exit repeat
        end if
      end try
    end repeat
    if targetWindow is missing value then return "__NOT_FOUND__"
    set outlineRows to rows of outline 1 of scroll area 1 of targetWindow
    set out to ""
    repeat with r in outlineRows
      try
        set uiEl to UI element 1 of r
        set txt to value of static text 1 of uiEl
        set out to out & txt & linefeed
      end try
    end repeat
  end tell
end tell
return out
`.trim();

const SET_SCROLL_SOURCE = `
on run argv
  set targetVal to (item 1 of argv) as real
  tell application "System Events"
    tell process "zoom.us"
      set targetWindow to missing value
      repeat with w in windows
        try
          if (name of w as string) starts with "Participants" then
            set targetWindow to w
            exit repeat
          end if
        end try
      end repeat
      if targetWindow is missing value then return "__NOT_FOUND__"
      try
        set sb to scroll bar 1 of scroll area 1 of targetWindow
        set value of sb to targetVal
      end try
    end tell
  end tell
end run
`.trim();

// Positions to sample the scrollbar at -- dense enough to overlap (each
// step should re-see some names from the previous one) so a viewport-sized
// gap in the middle of a long list can't slip through unseen.
const SCROLL_POSITIONS = [0, 0.12, 0.24, 0.36, 0.48, 0.6, 0.72, 0.84, 1.0];

function ensureScriptsWritten() {
  fs.writeFileSync(READ_ROWS_SCRIPT, READ_ROWS_SOURCE);
  fs.writeFileSync(SET_SCROLL_SCRIPT, SET_SCROLL_SOURCE);
}

function runOsascript(scriptPath, args = []) {
  return execFileSync("osascript", [scriptPath, ...args], { encoding: "utf8" });
}

function readVisibleRows() {
  const out = runOsascript(READ_ROWS_SCRIPT);
  if (out.trim() === "__NOT_FOUND__") {
    throw new Error(
      'Zoom\'s Participants window isn\'t open (or accessibility can\'t see it). Open it: click "Participants" in the Zoom meeting toolbar, then re-run.'
    );
  }
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

export function readParticipantsViaAccessibility() {
  ensureScriptsWritten();

  try {
    execFileSync("osascript", ["-e", 'tell application "zoom.us" to activate']);
  } catch {
    throw new Error("Couldn't activate Zoom -- is it running? (zoom.us must be running with a meeting in progress.)");
  }
  // Give the just-activated window a moment to actually register with the
  // accessibility tree before the first query.
  execFileSync("sleep", ["0.4"]);

  const allNames = new Set();
  let sawAnyWindow = false;
  for (const pos of SCROLL_POSITIONS) {
    try {
      runOsascript(SET_SCROLL_SCRIPT, [String(pos)]);
    } catch {
      // A single scroll step failing (e.g. list too short to need scrolling,
      // no scroll bar at all) isn't fatal -- still try reading rows at
      // whatever position we're at.
    }
    const rows = readVisibleRows();
    sawAnyWindow = true;
    for (const r of rows) allNames.add(r);
  }

  if (!sawAnyWindow || allNames.size === 0) {
    throw new Error("Read the Participants window but found no names -- panel may have closed mid-read. Re-run, or use --participants-file as a fallback.");
  }
  return [...allNames];
}

// Zoom names sometimes carry role/device tags in parens ("(Host)",
// "(co-host)", "(iPad)") and sometimes a roll number / application
// reference prefix or suffix if that's how a student set their display name
// (a real, encouraged convention at IIM Indore for exactly this purpose).
export function parseParticipantList(rawText) {
  const lines = rawText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  return lines
    .map((line) => {
      const cleaned = line.replace(/\s*\([^)]*\)\s*/g, " ").trim();
      return { raw: line, cleaned };
    })
    .filter((p) => p.cleaned.length > 0);
}

export function loadParticipants({ participantsFile }) {
  let rawLines;
  if (participantsFile) {
    rawLines = fs.readFileSync(participantsFile, "utf8");
  } else {
    rawLines = readParticipantsViaAccessibility().join("\n");
  }
  const participants = parseParticipantList(rawLines);
  if (participants.length === 0) {
    throw new Error(participantsFile ? `No participant names found in ${participantsFile}.` : "No participant names found via accessibility read.");
  }
  return participants;
}
