# Running a background job reliably on a MacBook (launchd, lid-closed, TCC)

Distilled from building `scripts/calendar-sync`'s scheduled sync + its
lid-closed wake workaround, including three real failures hit and fixed
along the way. Written down so any future script here that needs to run
unattended on a schedule — not just calendar-sync — can reuse the pattern
and skip re-discovering the same bugs. Reusable code:
`scripts/calendar-sync/install-launchd.sh` (the normal per-user scheduled
job) and `schedule-wakeups.sh` + `install-wake-scheduler.sh` (the
lid-closed workaround) — copy and adapt.

## The core problem: closing the lid stops launchd, it doesn't pause it

A MacBook with the lid closed (and not in clamshell mode — i.e. not both
plugged into power AND connected to an external display) goes into full
system sleep. **launchd's scheduled jobs (`StartInterval`,
`StartCalendarInterval`) do not fire during that sleep.** They don't queue
up and fire back-to-back on wake either — only the *most recent* missed
occurrence fires once, right after the Mac actually wakes, as a catch-up.
So a job meant to run hourly might, in practice, run only once whenever you
next open the lid.

This is fine for a task that just needs to "catch up whenever the Mac is
next actually used" (see calendar-sync's own `isWithinActiveHours` +
`shouldRunNow` design — the schedule sync is written to be safe and correct
no matter how sparsely it actually gets invoked). It's not fine if the task
specifically needs to happen on a real-world clock regardless of whether
anyone's using the laptop — see the workaround below for that case.

## Gotcha #1: launchd can't execute a script living inside ~/Documents

macOS TCC (Transparency, Consent, and Control) blocks a background,
non-GUI process from executing a script that lives inside a
TCC-protected folder (`~/Documents`, `~/Desktop`, `~/Downloads`, etc.)
unless the *executing binary* has been granted Full Disk Access. A plain
`launchd` job has no such grant by default.

**Fix**: deploy a copy of the actual entry-point script to somewhere
outside those protected folders (this repo's convention: `~/.<project-name>/`,
e.g. `~/.calendar-sync/run.sh`) and point `launchd`'s `ProgramArguments` at
*that* copy. The deployed copy can still safely call `node
/Users/.../Documents/.../actual-script.mjs` as an argument — TCC only
blocks the thing launchd directly executes, not files a already-running
process subsequently opens by path (see next gotcha for the one exception
to that).

## Gotcha #2: a root LaunchDaemon can't even *read* a file in ~/Documents

This one's easy to miss because it looks like the same restriction as #1
but isn't quite: **confirmed live**, a `LaunchDaemon` (a *root*-level
scheduled job, as opposed to a per-user `LaunchAgent` — see below) hit
`EPERM: operation not permitted` from a plain `fs.readFileSync()` on a path
under `~/Documents`, even though the script *doing* the reading was
already deployed outside Documents (satisfying gotcha #1). The difference:
a bare root daemon has no Terminal/WindowServer session to inherit a TCC
grant from at all, so even a simple file read of a protected path is
blocked — not just "executing a script located there."

**Fix**: deploy a copy of any config/data file the daemon needs alongside
the deployed script itself, and read from that copy, never from a path
under `~/Documents`. Re-deploy that copy every time the installer runs, so
it can't silently drift from the source of truth.

## LaunchAgent vs. LaunchDaemon — use the right one

| | LaunchAgent | LaunchDaemon |
|---|---|---|
| Runs as | the logged-in user | root |
| Installed to | `~/Library/LaunchAgents/` | `/Library/LaunchDaemons/` |
| Needs sudo to install | no | yes |
| Load/unload command | `launchctl load/unload` (or `bootstrap gui/$(id -u)` on newer syntax) | `launchctl bootstrap/bootout system` |
| Use for | anything that only needs your own account's permissions (reading your Drive/Calendar via your own OAuth token, writing to your own files) | anything that genuinely needs root (e.g. `pmset schedule`, which errors "This operation must be run as root" otherwise) |

Default to a LaunchAgent. Only reach for a LaunchDaemon when a specific
command actually requires root — don't run everyday scheduled work as root
just because it's "more powerful."

## Gotcha #3: launchd jobs get a minimal PATH

A `launchd`-spawned process does not inherit your shell's `PATH` — it gets
a bare-bones default. **Confirmed live**: a LaunchDaemon failed with `node:
command not found` despite `node` working fine everywhere else, because
Homebrew's `/opt/homebrew/bin` wasn't in the job's environment. Always set
it explicitly:

```xml
<key>EnvironmentVariables</key>
<dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
</dict>
```

## The actual lid-closed workaround: scheduled wake via `pmset`

If a job genuinely needs to run on a real-world clock regardless of
lid state, the only lever available is making the *Mac itself* wake up on
schedule, via `pmset schedule wake "MM/dd/yyyy HH:mm:ss"`. Three things
about this worth knowing before reaching for it:

1. **It needs root.** `pmset schedule` without sudo/root errors with "This
   operation must be run as root" — hence needing a LaunchDaemon (see
   above), not just a LaunchAgent, for whatever re-queues these.
2. **Each event is one-time, not recurring.** There's no "wake daily at
   these N times" primitive — `pmset`'s own `repeat` subcommand only
   supports a *single* wake time per day, not a list. To get several wake
   times a day (e.g. hourly across a window), you queue each one as a
   separate one-time `pmset schedule wake` call, and you need something
   else to re-queue the next day's full set once the current ones are
   consumed. `schedule-wakeups.sh` does the queuing (computing the
   remaining times for *today* from a configurable window +
   interval — see `scripts/calendar-sync/config.json`'s `sync` block for
   the shape); the `com.n0tv1cky.calendar-sync-wake-scheduler`
   LaunchDaemon runs it once nightly (00:05, well before any reasonable
   active-hours start) to refresh the set for the new day.
3. **Reliability is NOT guaranteed lid-closed-on-battery.** Confirmed the
   queuing mechanism itself works (`pmset -g sched` shows the event after
   scheduling one), but Apple's documented behavior is that scheduled wake
   is reliable mainly while plugged into AC power — on battery alone it's
   inconsistent across Mac models, and there's no clean way to verify this
   from software alone; it either wakes the Mac overnight or it doesn't.
   This is a real platform limit, not a bug to keep chasing. **This is
   exactly why it should be built as a removable add-on, not baked into
   the core job's correctness** — the underlying scheduled task should
   already be safe to run sparsely/whenever-woken (via its own
   active-hours + last-run checks, independent of whether the wake
   scheduler helped it fire on time), so if the wake trick doesn't pan out
   on a given machine, nothing breaks, it just falls back to catch-up-on-
   next-real-wake.

## Design pattern worth reusing: two independent gates, not one

Whatever ends up invoking the actual job (launchd on a timer, launchd after
a scheduled wake, or a human running it manually), have the job **check its
own preconditions itself** rather than trusting the scheduler alone got it
right:

- **An active-hours/time-of-day gate** (skip if outside the intended window
  — compare against the configured time zone explicitly via `Intl`, not the
  machine's local time, in case they ever differ).
- **A minimum-interval-since-last-run gate** (skip if it already ran
  recently enough — a persisted "last run" timestamp file, checked before
  doing real work).

Both configurable, both bypassable with an explicit `--force` for manual
runs. This makes the launchd/pmset scheduling layer purely an optimization
for *when* the job ideally runs, never a correctness dependency for
*whether* it's safe to run — see `sync-schedule.mjs`'s `isWithinActiveHours`
and `shouldRunNow`.
