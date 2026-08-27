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
(id in `config.local.json`'s `attendanceSheet.id`) that the MSDSM office
maintains specifically for coursewise attendance — one tab per subject code,
students as rows, "Session N" columns filled in as classes happen. That's
what `config.json`'s `attendanceSheet` points at.

**Session number comes from counting the schedule, not from parsing a
number out of it, and not from the attendance sheet's fill state either.**
The schedule's timetable cells are inconsistent about where a session
number lives — some subjects put it in parens (`DSM 101 (2)`), others glue
it to the abbreviation (`ME-1`, `SM3`, `MP-3`) — so this tool never reads a
number out of the cell text at all. Instead `countSessionOccurrences` in
`lib/schedule.mjs` counts how many times the subject has appeared in the
timetable, chronologically, up to and including today; that count *is* the
session number, since the sheet's columns get filled in the same order the
class actually meets.

An earlier version instead picked the target column by the attendance
sheet's own fill state (a column with some rows filled and some blank =
"today, in progress"). That has a real failure mode, caught before it ever
shipped a wrong write: a past session with one genuine permanent absentee
is indistinguishable, from cell contents alone, from a column someone just
started filling in a minute ago — both are "some filled, some blank," and
there's no way to tell "in progress" from "permanently incomplete" without
knowing *when* each row was written, which the Sheets API doesn't expose
per-cell. Counting the schedule sidesteps needing that entirely.

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

**Joins/leaves the meeting only if it has to.** If Zoom isn't already in the
configured meeting when this runs (and `--participants-file` isn't given),
`lib/zoomMeeting.mjs` joins it (muted, video off), runs the whole pipeline,
then leaves again -- but only because it's the one who joined. A meeting
already running when the script starts is left exactly as found, untouched,
whether it finishes normally or errors out. Two different accessibility
mechanisms are used deliberately: menu bar items (stable, used for
mute/video-off and for checking whether a meeting is active) vs. toolbar
buttons like Participants/Leave (not exposed to accessibility at all until
the mouse hovers over them -- driven with real synthetic mouse movement via
`cliclick`, at points computed as fixed offsets from the meeting window's
edges rather than raw screen coordinates, since Zoom's toolbar doesn't
stretch with window size). All of this was worked out and verified against
a real live class, including the join dialog, the leave confirmation popup,
and the "not in a meeting" idle state -- not assumed from documentation.

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

**`cliclick`** (`brew install cliclick`): needed for the toolbar-button
clicks (Participants/Leave) described above -- System Events alone can't
synthesize real mouse movement, and Zoom's toolbar needs that to reveal
itself before anything can click it.

**Zoom's "Always show this preview when joining" setting:** if enabled
(Zoom Settings → General), joining shows a pre-join camera/mic preview
dialog that needs a manual "Join" click -- `joinMeeting()` deliberately
doesn't click through it (an unverified dialog isn't worth guessing at), so
it'll just time out. Turn this off for unattended runs. Zoom's "mute my
microphone"/"turn off my video when joining" settings (Settings →
Audio/Video) are also worth enabling directly -- `ensureMutedAndVideoOff()`
enforces the same result via the Meeting menu regardless, but the setting
is one less thing that has to go right.

## Running it

Just run it during or right after a live class:

```bash
node mark-attendance.mjs
```

If Zoom isn't already in the class meeting, it joins (muted, video off,
using `config.json`'s `zoom.meetingLink`), opens the Participants panel, and
leaves again when done. If you're already in the meeting, it just opens the
panel if needed and leaves the meeting running afterward -- your call on
whether to stay. Either way it then auto-detects today's subject from the
schedule + current time, reads the live participant list, matches names
against the roster, and prints the full plan — **without writing anything**.

1. Review the output, especially the "NOT matched" section (guests, faculty,
   typo'd names — anyone who needs manual handling).
2. If it looks right:
   ```bash
   node mark-attendance.mjs --apply
   ```
   (This re-runs the whole thing from scratch — subject/session detection
   and the participant list are both re-read on `--apply`, so there's no
   stale-plan risk between the dry run and the real write. If it had to
   join for the dry run, it already left afterward, so this may join again
   — a few seconds' overhead, worth it for never acting on a stale read.)

**Useful flags:**

```bash
--subject ME              # override auto-detected subject (abbreviation or "DSM 107")
--session 5               # override auto-picked session column
--participants-file p.txt # read the participant list from a file, skipping Zoom entirely (no join/leave)
--no-leave                # don't auto-leave even if this run is the one that joined
--apply                   # actually write (default is dry-run)
--config path/to/other.json
```

If the schedule shows more than one class plausibly "current" (e.g. you're
running this well after class ended, or two slots' grace windows overlap),
the tool lists today's scheduled classes and prompts you to pick one instead
of guessing.

## Logging

Every run (dry-run and `--apply`) writes to two linked JSONL files under
`~/.attendance-sync/`, built specifically so questions like "was this
student really marked present on this date, and how confidently" have a
definitive answer without digging through terminal scrollback:

- **`runs.jsonl`** — one row per invocation: subject/session detection
  method (auto-live/auto-recent/override/manual-prompt), the schedule slot
  that triggered it, participant source, aggregate counts, timing, and the
  script's own git commit (for full reproducibility of *how* a given run
  behaved).
- **`participants.jsonl`** — one row per participant *seen* that run,
  whatever the outcome (`matched`/`excluded`/`unmatched`/`duplicate-device`):
  raw Zoom name, match method + confidence score, which roster row it
  resolved to, whether that cell was already marked before this run, and
  whether this run actually wrote to it (`written`; dry runs get `wouldWrite`
  instead, so a dry run's "what would have happened" is distinguishable from
  a real write).

Both join on `runId`. JSONL rather than one nested file so each is
independently `jq`-able and loads straight into pandas
(`pd.read_json(path, lines=True)`) or DuckDB
(`read_json_auto('participants.jsonl')`) as a clean, flat table. Example:

```bash
jq -c 'select(.matchedStudentRoll == "2604107004")' ~/.attendance-sync/participants.jsonl
```

answers "every time this roll number was matched, by what method, and was
it actually written" — roll-number matches are the strongest signal
available (that student's own roll number was in the live Zoom display
name), but note that's still "a device joined claiming this identity," not
independent proof of physical presence — worth keeping in mind for any
integrity question, not something a log can resolve on its own.

## Scheduled (unattended) runs

Unlike the original design (see the section above and the top of this file
-- "no launchd job... deliberately"), this is now automated: a LaunchAgent
(`com.n0tv1cky.attendance-sync`) fires `node mark-attendance.mjs --apply
--unattended` roughly 30 minutes after each class-slot start time from
`config.json`'s `timeSlots`, every day of the week.

**Why a LaunchAgent, not a LaunchDaemon**: this task has to run in your
logged-in GUI session -- `ensureParticipantsPanelOpen()`/`joinMeeting()`/
`leaveMeeting()` drive Zoom's actual UI via System Events + `cliclick`, which
needs a real, unlocked screen to do anything. A LaunchDaemon (root, no GUI
session) can't do this at all. There's also no lid-closed wake workaround
here (unlike `scripts/zoom-recordings`) -- if the Mac is asleep or the screen
is locked when a scheduled time fires, that run will fail, and there's no
practical way around that for a task that fundamentally needs to click
things in a visible Zoom window.

**Why firing on every slot, every day, is safe (not spammy)**: the schedule
here is purely a timing optimization, not the thing that decides "should
this actually run" -- see docs/background-automation.md's "two independent
gates" pattern. `mark-attendance.mjs`'s own schedule detection
(`findCandidateSessions`) is what's authoritative. A firing that lands on a
holiday, a slot with no class, or between classes just detects "nothing live
right now," logs it, emails a one-line "skipped" report, and touches nothing
-- no Zoom join, no sheet write.

**`--unattended`** changes exactly two things from a normal `--apply` run:
1. **No interactive prompt.** There's no TTY under launchd, so the
   ambiguous-detection prompt (`rl.question(...)`) would otherwise hang
   forever. Instead, whenever `pickSubject` can't resolve to exactly one
   class -- either genuinely ambiguous (two slots equally live/recent at
   once) or nothing live right now -- it logs the reason and returns without
   ever touching Zoom or the sheet. See `pickSubject`'s `UNATTENDED` branch
   in `mark-attendance.mjs` for the exact conditions.
2. **Emails a report** for every outcome (skipped / written / failed) via
   `lib/notify.mjs` -- reusing `zoom-recordings`' Gmail-send pattern
   (`lib/gmailAuth.mjs`, its own `gmail.send`-only OAuth token, entirely
   separate from this project's Sheets/Drive token; see that file's header
   comment for why a new scope needs a brand-new token file). Manual runs
   never email -- only `--unattended` does, since a human watching the
   terminal doesn't need an email about what they just watched happen.

### One-time setup for scheduled runs

```bash
# Gmail-send OAuth token, separate from the Sheets/Drive one above -- opens
# a one-time browser consent tab.
node -e '
import("./lib/gmailAuth.mjs").then(({ getGmailAuthClient }) =>
  getGmailAuthClient("./oauth-client.json", process.env.HOME + "/.attendance-sync/gmail-token.json"))'
```

`config.json`'s `notifications.toEmail` controls where reports go (defaults
to your own institute email, from == to).

### Redeploying after editing `run-scheduled.sh`

Same TCC constraint as `zoom-recordings` (see
docs/background-automation.md, gotcha #1): launchd executes the deployed
copy outside `~/Documents`, not the repo file directly.

```bash
cp scripts/attendance/run-scheduled.sh ~/.attendance-sync/run-scheduled.sh
```

Editing the repo copy alone has no effect on the live job until this is done.

### Changing the schedule

If `config.json`'s `timeSlots` ever change (new term, different slot times),
recompute the `StartCalendarInterval` entries in
`com.n0tv1cky.attendance-sync.plist` (each is slot-start + 30 min, one dict
per weekday/weekend-day + slot combination -- see the plist's own comment)
and reload:

```bash
launchctl bootout gui/$(id -u)/com.n0tv1cky.attendance-sync
cp scripts/attendance/com.n0tv1cky.attendance-sync.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.n0tv1cky.attendance-sync.plist
```

### Useful commands

```bash
launchctl print gui/$(id -u)/com.n0tv1cky.attendance-sync   # status
launchctl kickstart gui/$(id -u)/com.n0tv1cky.attendance-sync   # trigger a run right now (for testing)
tail -f ~/.attendance-sync/last-scheduled-run.log   # what a scheduled run actually did
tail -f ~/.attendance-sync/launchd.log   # launchd's own stdout/stderr wrapper

# Fully disable (e.g. term ended, or reverting to fully manual)
launchctl bootout gui/$(id -u)/com.n0tv1cky.attendance-sync
rm ~/Library/LaunchAgents/com.n0tv1cky.attendance-sync.plist
```

## Using it next term

Everything term-specific lives in `config.json`:

- `scheduleFile.id`, `attendanceSheet.id` — sheet URLs, per term
- `subjectCodeMap` — abbreviation → canonical `DSM <N>` code, from the
  schedule's own course legend table (the tool cross-checks this against the
  legend automatically each run and warns on mismatch)
- `timeSlots` — weekday/weekend session time windows, if the timetable
  structure changes
