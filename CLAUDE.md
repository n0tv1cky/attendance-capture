# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Marks Zoom-class attendance into a shared, admin-owned Google Sheet, from a Zoom participant list matched against the batch roster. Runnable by hand (`node mark-attendance.mjs`) during/after a live class, and also has unattended scheduled automation via a `launchd` LaunchAgent (`com.n0tv1cky.attendance-sync` + `run-scheduled.sh`, firing ~30 min after each class-slot start from `config.json`'s `timeSlots`) — see `README.md`'s "Scheduled (unattended) runs" section for the `--unattended` flag's exact skip-not-guess behavior and the email-report setup.

It still joins the actual live meeting and writes to a shared sheet you don't own outright, so treat changes to the scheduling or the `--unattended` skip logic with real care — a bug here doesn't just fail quietly, it can write wrong attendance data to a sheet other people rely on.

This repo was split out of a personal monorepo (`~/Documents/Personal/masters`) on 2026-08-27, with full commit history preserved via `git filter-repo`. See "Split history" below for what that means for secrets handling.

**Git workflow:** this repo has a real GitHub remote (`origin`, `n0tv1cky/attendance-capture`). Commit as normal, but **never push without being explicitly asked** — a push here is visible to whoever has access to that GitHub repo.

## Split history / secrets (read before touching config or docs)

`config.json` in this repo contains only **placeholder** values (`<YOUR_...>`) for anything sensitive — the schedule-sheet ID, the attendance-sheet ID, the live Zoom meeting link (with embedded password), and the institute email. The real values live in `config.local.json`, which is gitignored and deep-merged over `config.json` at load time by `lib/configLocal.mjs` (see `loadConfig()` in `mark-attendance.mjs`).

**Never put a real Sheet ID, the real Zoom meeting link, or a real student's/classmate's name directly into `config.json`, code, or `README.md`.** The pre-split history had the live Zoom meeting credentials baked into `config.json`, and had a real classmate's name (and, in one commit message, their name again) used as a worked example for the name-matching logic — both were scrubbed from history with `git filter-repo --replace-text`/`--replace-message` when this repo was extracted. If you need an example name/roll number for documentation, use an obviously fake one (this repo's `README.md` currently uses a placeholder for exactly this reason) — never a real classmate's.

`oauth-client.json` (Google Cloud "Desktop app" OAuth client secret) is gitignored and has never been committed, in this repo or its monorepo predecessor.

## Commands

Plain Node ESM script — no build step, no bundler, no lint config, no test suite.

```bash
npm install
node mark-attendance.mjs           # dry run (default) -- prints the plan, writes nothing
node mark-attendance.mjs --apply   # actually write to the attendance sheet
node mark-attendance.mjs --subject ME --session 5   # override auto-detection
node mark-attendance.mjs --participants-file p.txt  # skip Zoom entirely, read names from a file
```

**Redeploying `run-scheduled.sh` after editing it:** launchd runs a copy of this outside `~/Documents` (macOS TCC blocks background/non-GUI processes from executing scripts that live inside `~/Documents`). After any edit, re-copy:
```bash
cp run-scheduled.sh ~/.attendance-sync/run-scheduled.sh
```
Editing the repo copy alone has no effect on the live unattended job until this is done. The deployed copy still references this repo's absolute path (`/Users/n0tv1cky/Documents/Personal/masters/projects/attendance/mark-attendance.mjs`) — if this repo is ever moved again, that deployed script needs updating and redeploying, or the scheduled job silently breaks (this happened during the 2026-08-27 split and had to be fixed by hand). Note this is a LaunchAgent (runs in the logged-in GUI session), not a LaunchDaemon — it has to be, since the Zoom-UI automation below needs a real, unlocked GUI session.

## OAuth credentials

`oauth-client.json` sits in the repo root, gitignored, never committed — treat it as a secret if you ever touch it. Reuses the same underlying Google Cloud OAuth app/client-secret as the sibling `zoom-recordings` project (copied, not shared by reference) but keeps its **own separately cached token**, since the two tools request different scopes.

Cached user token lives outside the repo, at `~/.attendance-sync/google-oauth-token.json`. This is an OAuth **testing-status** app token — Google can expire it (commonly after ~7 days unused, or without periodic re-consent), which shows up as an auth failure requiring one interactive re-login (`node mark-attendance.mjs`), not a code bug.

There's a **second, separate token** just for sending unattended-run report emails: `~/.attendance-sync/gmail-token.json`, scoped to `gmail.send` only, obtained via `lib/gmailAuth.mjs`'s own local-server OAuth flow — only used by `--unattended` runs; manual runs never email.

## Architecture

**Run manually per class, or unattended via launchd** — see "What this repo is" above for the scheduling detail.

**Pipeline:** read the schedule (raw `.xlsx` on Drive, view-only — read via `drive.files.get(alt=media)` + the `xlsx` package, since the Sheets API refuses non-native files) to auto-detect today's subject/session → get the live Zoom participant list → fuzzy-match names against the roster (embedded roll number → exact name → fuzzy similarity with an ambiguity check) → write `"Present"` into the matching column of the attendance Google Sheet (a separate native Sheet, one tab per subject, real Sheets API read+write).

Key design points:

- **No browser automation for the sheet work** — only reading the Zoom participant list needs anything unusual (see below); the schedule read and the attendance write both go through real Google APIs.
- **Session number** comes from `countSessionOccurrences` (`lib/schedule.mjs`): counts how many times the subject has appeared in the timetable up to today, rather than parsing an inconsistently-formatted number out of the timetable cell or inferring it from which sheet columns look full/partial (an earlier fill-state heuristic couldn't distinguish "today's column, partly filled" from "a past column with a genuine permanent absentee").
- **Getting the participant list**: Zoom's "Copy Participant List" menu item doesn't exist for a plain (non-host) participant. `lib/participants.mjs` instead reads names directly off the Participants panel's macOS accessibility tree (`osascript`/System Events) — requires Zoom frontmost (its floating panels vanish from the accessibility tree when it loses focus) and driving the scrollbar through several positions since the list is virtualized.
- **Joining/leaving Zoom**: `lib/zoomMeeting.mjs` joins the meeting only if not already in it, and only leaves again if it's the one that joined — a meeting already running when the script starts is left untouched either way. Uses menu-bar accessibility items (stable) for mute/video-off/join-detection, but real synthetic mouse movement via `cliclick` for toolbar buttons like Participants/Leave, since those aren't exposed to accessibility until actually hovered. This is the most fragile part of the whole project — a Zoom app auto-update can silently change window names/accessibility structure and break it (happened 2026-09-01, see `docs/zoom-workplace-rebrand-2026-09.md` for the full debugging trail, the fixes, and what's still unproven under real unattended conditions before touching this file again).
- **Dry run by default**; `--apply` is required to actually write, and writes are additive-only (blank cells only — an already-`"Present"` cell is never touched), so re-running the same session twice is always safe.
- **Logging**: every run (dry or `--apply`) writes to `~/.attendance-sync/runs.jsonl` and `participants.jsonl` (joined by `runId`) — designed to be `jq`/pandas/DuckDB-queryable for "was this student marked present, and how confidently" questions.
- **Subject code resolution** uses the same `config.json` `subjectCodeMap` pattern as the sibling `zoom-recordings` project (short abbreviations like `ME`, `MC` mapped to canonical `DSM <N>` codes) — the full code/title/instructor table lives in the monorepo's `docs/course-codes.md`, not in this repo.

Full detail (including the DSM 101 two-tabs-same-roster gotcha, name-matching noise-token stripping, and required one-time setup like the Accessibility permission and `cliclick`) is in `README.md`.
