// Getting the Zoom participant list.
//
// We deliberately do NOT drive Zoom's UI via accessibility/AppleScript
// automation here. Zoom's participants panel is a notoriously unstable
// target for UI scripting (button labels/positions shift across versions,
// and there's no way to verify a click sequence works without a live
// meeting to test against) -- a script that's "mostly right" here is worse
// than one that's simple and always right, because a silent failure means
// wrong/missing attendance in a shared institute sheet.
//
// Instead: in the live meeting, use Zoom's own built-in "Participants" panel
// -> "..." menu -> "Copy Participant List" (2 clicks, always in the same
// place regardless of Zoom version), which puts a clean plain-text list on
// the clipboard. This script just reads that -- via `pbpaste` by default, or
// a file with --participants-file for scripting/testing without touching
// the clipboard.

import { execFileSync } from "node:child_process";
import fs from "node:fs";

export function readClipboardText() {
  return execFileSync("pbpaste", { encoding: "utf8" });
}

// Zoom's copied list is one participant per line, sometimes with a role/
// device suffix in parens ("(Host)", "(co-host)", "(iPad)") and sometimes a
// leading roll number if that's how a student set their display name (a
// real, encouraged convention at IIM Indore for exactly this purpose).
export function parseParticipantList(rawText) {
  const lines = rawText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  return lines
    .map((line) => {
      // Strip ALL trailing parenthetical tags, e.g. "Jane Doe (Host) (iPad)".
      const cleaned = line.replace(/\s*\([^)]*\)\s*/g, " ").trim();
      return { raw: line, cleaned };
    })
    .filter((p) => p.cleaned.length > 0);
}

export function loadParticipants({ participantsFile }) {
  const rawText = participantsFile ? fs.readFileSync(participantsFile, "utf8") : readClipboardText();
  const participants = parseParticipantList(rawText);
  if (participants.length === 0) {
    throw new Error(
      participantsFile
        ? `No participant names found in ${participantsFile}.`
        : "Clipboard doesn't contain a participant list. In Zoom: Participants panel -> \"...\" -> Copy Participant List, then re-run."
    );
  }
  return participants;
}
