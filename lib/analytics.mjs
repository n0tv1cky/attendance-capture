// Structured, queryable logging for every run -- built specifically so a
// question like "was this student really matched as present on this date,
// and how confidently" has a definitive answer without having to dig
// through terminal scrollback. Two JSONL files, joined by runId:
//
//   runs.jsonl        -- one row per invocation (dry-run or --apply):
//                        subject/session detection, participant source,
//                        aggregate counts, timing.
//   participants.jsonl -- one row per participant seen in that run, whatever
//                        the outcome (matched / excluded / unmatched /
//                        duplicate-device): raw Zoom name, match method +
//                        confidence, which roster row it resolved to,
//                        whether that cell was already marked, and whether
//                        this run actually wrote to it.
//
// JSONL (not a nested JSON array) so each file is trivially appendable,
// greppable, and loadable as-is into pandas (`pd.read_json(path,
// lines=True)`), DuckDB (`read_json_auto('participants.jsonl')`), or `jq`.
// Two flat files instead of one nested one so each loads as a clean,
// consistently-columned table -- no sparse/nullable columns from mixing
// run-level and participant-level fields in one row shape.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

function appendJsonl(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + "\n");
}

export function makeRunId() {
  return `${new Date().toISOString()}_${crypto.randomUUID().slice(0, 8)}`;
}

function gitCommit() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: new URL(".", import.meta.url).pathname, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

// Call once per run with everything known at the end of it -- see the shape
// used in mark-attendance.mjs for the actual field list. `at`, `scriptCommit`
// are filled in here so callers don't have to remember to.
export function logRun(runsLogFile, entry) {
  appendJsonl(runsLogFile, { at: new Date().toISOString(), scriptCommit: gitCommit(), ...entry });
}

// `records` is an array of per-participant event objects, already carrying
// runId (so they join back to the run row) -- see mark-attendance.mjs for
// how each outcome type (matched/excluded/unmatched/duplicate-device) is
// built.
export function logParticipants(participantsLogFile, records) {
  const at = new Date().toISOString();
  for (const r of records) appendJsonl(participantsLogFile, { at, ...r });
}
