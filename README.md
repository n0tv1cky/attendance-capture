# Attendance marking

Marks Zoom-class attendance into the MSDSM coursewise attendance Google
Sheet, from the live Zoom participant list matched against the batch
roster. No browser automation anywhere in the pipeline — the schedule and
roster files, and the write itself, all go through the real Google
Sheets/Drive APIs with your own OAuth login.

## Why this design

**Three different Google files, three different access levels** — worth
knowing before touching any of this:

| File | Format | Your access | How it's read/written |
|---|---|---|---|
| Schedule (`MSDSM Batch 06 Term I Scheduling.xlsx`) | raw .xlsx on Drive | view-only | `drive.files.get(alt=media)` + the `xlsx` package (Sheets API flatly refuses non-native files) |
| Roster (`MSDSM BATCH 2026 Batch 6.xlsx`) | raw .xlsx on Drive | view-only | not used by this tool — see below |
| **Attendance sheet** (`MSDSM Batch 06 Attendance coursewise Term I`) | native Google Sheet | **edit** | Sheets API, read + write |

The roster file linked in early planning turned out to be view-only and
isn't a native Sheet either, so it can't be written to at all. The actual
target is a separate, already-editable sheet
(`<YOUR_ATTENDANCE_SHEET_ID>`) that the MSDSM office
maintains specifically for coursewise attendance — one tab per subject code,
students as rows, "Session N" columns filled in as classes happen. That's
what `config.json`'s `attendanceSheet` points at.

**Session number comes from the sheet, not the schedule.** The schedule's
timetable cells are inconsistent about where a session number lives — some
subjects put it in parens (`DSM 101 (2)`), others glue it to the abbreviation
(`ME-1`, `SM3`, `MP-3`). Rather than trust that formatting to always parse
correctly, this tool only uses the schedule to identify *which subject* is
running; it picks the actual target "Session N" column by looking at the
attendance sheet's own state (first partially-filled column, else first
fully-blank one). This is also what makes re-running mid-session safe: it
tops up the same column instead of guessing wrong and creating a new one.

**DSM 101 has two tabs that are NOT two rosters.** `DSM 101(1 to 20)` and
`DSM 101(21 to 40)` look like a student roll-number split by name, but both
tabs list the same 34 students — they're actually a **session-number-range**
split (Sessions 1–20 vs 21–40), because that subject runs 40 sessions total.
Confirmed by reading the actual data, not assumed. `pickActiveTab()` in
`lib/attendanceSheet.mjs` picks whichever tab currently has room and matches
participants against that tab alone, so a student never gets double-matched
across both.

**Getting the participant list: accessibility read, not "Copy Participant
List".** The original plan was to use Zoom's built-in Participants panel →
"..." → Copy Participant List, reading the clipboard. Verified against a
real live meeting that this menu option **doesn't exist for a plain
participant** — it's host/co-host only, and you're neither on these class
meetings. What does work, also verified live: `lib/participants.mjs` reads
the participant names directly off the Participants window's accessibility
tree via `osascript`/System Events. Two things had to be true for this to be
reliable, both discovered by testing against the real meeting rather than
assumed:
1. **Zoom must be frontmost when queried** — its floating panel windows
   (Participants included) disappear from the accessibility tree entirely
   once Zoom loses focus. The script calls `activate` first.
2. **The list is virtualized** (an `AXOutline`, like a table view) — only
   rows currently scrolled into view are readable; off-screen rows throw
   `Invalid index`. The script drives the scroll bar through a spread of
   positions and unions the names seen at each stop.

This only needs the Participants panel to be open in Zoom — no click-through
menu required, so it works for any participant regardless of host/co-host
status.

**Confident matches only.** Each Zoom participant name is matched against
the roster by, in order: embedded institute roll number (if a student named
themselves `2604107001 Jane Doe`, the recommended convention) → exact
normalized name → fuzzy name similarity above a threshold, with an
ambiguity check against the second-best match. Anything short of that is
reported as **unmatched** and never written — see the "review manually"
section of the tool's output. Wrong-but-confident is a much worse failure
mode than incomplete-but-flagged in a shared, admin-owned sheet.

Name matching also strips institute boilerplate before comparing — verified
against a real participant list, many students suffix their Zoom name with
things like `- MSDSM Batch 06` or an application reference number, which
would otherwise dilute token-overlap scoring enough to push a genuine,
unambiguous match (`"Jane"` → `"Jane Doe"`, `"John Smith"` →
`"Jonathan John Smith"`) below threshold. `lib/match.mjs` strips known
noise tokens and treats "every word of the shorter name appears in the
longer one" as a strong (not perfect) signal, so real partial names match
while still leaving the ambiguity-margin check able to catch an actual
same-first-name collision.

**Dry run by default.** The tool always prints its full plan (detected
subject, target session column, matched/unmatched participants, what would
be written) without touching the sheet. Pass `--apply` to actually write.

**Idempotent, additive-only writes.** Only blank cells in the target column
get written; an already-`"Present"` cell is left alone. Re-running the same
session's marking run twice is always safe.

## One-time setup

```bash
cd scripts/attendance
npm install
```

**Google OAuth client:** reuses the same Google Cloud OAuth app as
`scripts/zoom-recordings` (`oauth-client.json`, copied here) but with its
**own cached token**, since the scopes differ — this project needs
`spreadsheets` (read/write), `drive.readonly` (to fetch the schedule
.xlsx), and `drive.file` (only for tooling that creates its own scratch
files, e.g. during testing — never used against real data). First run opens
a browser tab for one-time consent; after that it's cached in
`~/.attendance-sync/google-oauth-token.json`.

**macOS Accessibility permission:** the Terminal (or whatever runs this
script) needs Accessibility access under System Settings → Privacy &
Security → Accessibility, so `osascript`/System Events can read Zoom's
Participants window. If the tool errors saying it can't find that window
while Zoom is clearly open with the panel visible, check this first.

## Running it

During or right after a live class:

1. In Zoom, open the **Participants** panel (just needs to be open — no
   menu clicks needed) and leave it open.
2. Run:
   ```bash
   node mark-attendance.mjs
   ```
   This auto-detects today's subject from the schedule + current time, reads
   the live participant list from Zoom, matches names against the roster,
   and prints the full plan — **without writing anything**.
3. Review the output, especially the "NOT matched" section (guests, faculty,
   typo'd names — anyone who needs manual handling).
4. If it looks right:
   ```bash
   node mark-attendance.mjs --apply
   ```
   (Re-run steps 1–4 from scratch — the auto-detected subject/session and
   the participant list are both re-read on `--apply`, so there's no
   stale-plan risk between the dry run and the real write.)

**Useful flags:**

```bash
--subject ME              # override auto-detected subject (abbreviation or "DSM 107")
--session 5               # override auto-picked session column
--participants-file p.txt # read the participant list from a file instead of Zoom directly
--apply                   # actually write (default is dry-run)
--config path/to/other.json
```

If the schedule shows more than one class plausibly "current" (e.g. you're
running this well after class ended, or two slots' grace windows overlap),
the tool lists today's scheduled classes and prompts you to pick one instead
of guessing.

## Logging

Every run (dry-run and `--apply`) appends a line to
`~/.attendance-sync/mark-attendance.log.jsonl` — subject, tab, session
number, match/write counts, and the list of unmatched names. Useful for
auditing what happened on a given day without re-deriving it from the sheet.

## Using it next term

Everything term-specific lives in `config.json`:

- `scheduleFile.id`, `attendanceSheet.id` — sheet URLs, per term
- `subjectCodeMap` — abbreviation → canonical `DSM <N>` code, from the
  schedule's own course legend table (the tool cross-checks this against the
  legend automatically each run and warns on mismatch)
- `timeSlots` — weekday/weekend session time windows, if the timetable
  structure changes
