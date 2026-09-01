# The 2026-09-01 Zoom Workplace rebrand: what broke, what was fixed, what's still open

A Zoom auto-update sometime around 2026-08-31/09-01 rebranded the desktop
app to "Zoom Workplace" and changed enough of its window/accessibility
structure that most of `lib/zoomMeeting.mjs`'s automation broke at once.
This doc is the distilled record of that debugging session -- commits
`f783293` through `8f755f2` -- so a future recurrence (this app updates
itself silently; nothing here is pinned to a version) doesn't require
re-discovering all of this from scratch.

**Status as of the last commit (`8f755f2`): each individual piece below was
verified against the real live UI, and one fully unattended dry-run
succeeded end-to-end. But at least one automated run during testing still
stalled past a 90s timeout for a reason not fully isolated (possibly
system load from many rapid repeated test runs that same session, possibly
a genuine timing race). Treat this as *cautiously working, not proven* --
the real test is the next few actual scheduled runs. If one fails on the
lobby-card symptom below, this doc is the starting point, not a dead end.**

## Symptom 1: every join timed out, even though it visibly succeeded

**What we saw:** `joinMeeting()` timed out after 45s waiting for
`isInMeeting()` to go true, but the user could see (via a second device)
that the bot really had joined and left normally.

**Root cause:** the old client's in-meeting window was reliably named
`"Zoom Meeting..."` (see `MEETING_WINDOW_PREFIX`). The rebranded client
doesn't create that window by default at all -- confirmed live via:

```applescript
tell application "System Events"
  tell process "zoom.us"
    repeat with w in windows
      try
        return (name of w as string) & linefeed
      end try
    end repeat
  end tell
end tell
```

which returned things like `"zoom floating video window"`, an unnamed
recording-notice popup, and `"Zoom Workplace"` (the unified app window) --
never `"Zoom Meeting..."`. `isInMeeting()` only ever checked for that one
name, so it silently returned false for the entire meeting.

**Fix (`f783293`):** `isInMeeting()` now also matches
`"zoom floating video window"` (a small always-present picture-in-picture
panel) as evidence of being in a meeting, alongside the legacy prefix.

**Learning:** don't assume a window's name is a stable identity across app
versions, *especially* not for an app that silently self-updates. When
automation depends on one, the very first debugging step for "this
suddenly stopped working" should be a fresh live window-name dump, not
re-reading old comments that assumed a name that may no longer hold.

## Symptom 2: joins succeeded but Participants-panel-open and Leave still failed

**What we saw:** even after fixing `isInMeeting()`, `getMeetingWindowBounds()`
(used by both `ensureParticipantsPanelOpen()` and `leaveMeeting()`) threw
`Can't get window ... "Zoom Meeting"` -- the exact window that symptom 1
proved doesn't exist by default anymore.

**Fix (`a9eb24a`):** two Window-menu items, driven via `osascript`, bring
the classic full-toolbar window back:

```applescript
tell application "System Events"
  tell process "zoom.us"
    click menu item "Always Show Meeting Controls" of menu 1 of menu bar item "Window" of menu bar 1
    click menu item "Zoom Meeting" of menu 1 of menu bar item "Window" of menu bar 1
  end tell
end tell
```

`"Always Show Meeting Controls"` keeps the toolbar permanently docked
(replacing the old hover-to-reveal behavior); `"Zoom Meeting"` switches
focus to that window like any other item in the Window menu. Once both are
done, the resulting window's bounds and the existing `TOOLBAR`/
`LEAVE_CONFIRM` pixel offsets matched what they were **before** the
rebrand almost exactly -- so the actual toolbar layout didn't change, only
whether the window hosting it exists and is frontmost by default.

`ensureMeetingWindowVisible()` (exported from `zoomMeeting.mjs`) wraps
this, checking the menu's checkmark state first so it doesn't blindly
toggle "Always Show Meeting Controls" back off if it's already on.

**Learning:** when a whole *class* of actions breaks together (not just
one), look for one shared precondition instead of patching each action
separately. Here, "the window doesn't exist" explained both symptom 1 and
symptom 2's participants/leave failures -- fixing detection alone wasn't
enough because the fix didn't also make the window exist for the later
toolbar actions to use.

## Symptom 3: a second, different pre-join screen (the "lobby card")

**What we saw:** rejoining a *second* time in the same session (join, leave,
then join again) surfaced a completely different screen than the
already-handled "Choose one of the audio conference options" modal -- a
card titled after the meeting's own topic, "Host has joined. We've let
them know you're here.", with a muted-mic icon needing a manual click.
Until clicked, `isInMeeting()` never goes true, so this caused the exact
same 45s-timeout symptom as #1, but from a genuinely different cause.

This took **four separate corrections**, each only discovered by testing
the previous "fix" live and watching it fail differently:

1. **First attempt** searched `buttons of window i` (direct children
   only) for a `help` attribute containing "audio"/"mic". Found nothing,
   ever -- confirmed live that a real scheduled run still stalled on this
   card. Dumping the card's full accessibility tree (`entire contents of
   window`) while it was actually stuck showed why: the button is nested
   one level inside a `tab` element (itself a direct child of the window),
   and its usable text lives in `description`, not `help` (empty for this
   button).

2. **Second attempt** tried `tabs of w` / `class is tab` to walk that
   nesting -- both failed outright with cryptic errors (`-1700`, `-2741`).
   `tab` is a **reserved AppleScript constant** (the tab whitespace
   character), not a plain identifier one can use as a class name in a
   query. Confirmed by testing in isolation:
   `class is tab` errors as "can't get class whose it = '<TAB CHAR>'".
   Fixed by getting `class of el as string` in a manual loop and comparing
   against the *string* `"tab"`, sidestepping the reserved word entirely.

3. **Third attempt**, now correctly finding candidate buttons, matched on
   a loose `"mic"` substring in `description`. This matched the
   *unrelated* `"Test speaker and mic"` button (checked earlier in
   iteration order, since it's a direct window child) and clicked that
   instead -- confirmed live by running it and watching the wrong thing
   happen on screen, harmlessly (it just opened/toggled a hidden test
   dialog). Narrowed the match to `"currently muted"`, which only the real
   audio button's description (`"Audio, turn on, currently muted"`)
   contains -- the sibling video button says `"currently off"`, not
   `"muted"`, so it couldn't cross-match.

4. **Fourth attempt**: even once the exact right button was being found,
   AppleScript's own `click b` (an AXPress action) did *nothing visible at
   all* -- confirmed by running it against the live stuck card and seeing
   no state change on screen. Same underlying class of problem as the
   toolbar buttons elsewhere in this file (`TOOLBAR`/`clickToolbarButton`),
   which already need real synthetic mouse events via `cliclick` instead
   of AXPress for the same reason: this Zoom build doesn't wire every
   button's accessibility press action to its actual click handler.
   Switched to reading the button's bounds via AppleScript and clicking
   its center with `cliclick` -- confirmed live by seeing the "Computer
   audio connected" toast actually appear.

**Fix (`caa9107`, corrected in `8f755f2`):** `findLobbyAudioButtonBounds()`
+ `dismissLobbyAudioPromptIfPresent()` in `zoomMeeting.mjs`, checked on
every iteration of `joinMeeting()`'s wait loop (this prompt gates
`isInMeeting()` itself, unlike the audio dialog which only appears after a
confirmed join).

**Learning, the big one from this whole session:** for an app with this
many "button has no accessible name" gaps, *never trust that a fix works
just because the AppleScript ran without error and returned something
that looks like success.* Every one of the four corrections above was a
plausible-looking fix that silently did the wrong thing (or nothing) --
each was only caught by actually watching the live screen after running
it, not by the script's own return value. The general debugging recipe
that worked, every time:
1. Get the exact live-stuck state on screen (a real failure, not a guess).
2. Dump the *actual* accessibility tree of that exact state (`UI elements
   of w`, recursing into `tab`/`group` children one level at a time --
   avoid `entire contents` on large windows like the main app window,
   since it recurses the whole tree and is slow).
3. Identify the target element by whichever of `name`/`description`/`help`
   actually has real text (often only one does, sometimes none, in which
   case a coordinate-bounds fallback is unavoidable).
4. Write the narrowest match that can't also match a sibling element you
   can see in the same dump.
5. Click it (`click b` via AppleScript OR a `cliclick` coordinate click --
   try the cheap one first, but verify which one actually works on this
   specific button before trusting it elsewhere).
6. **Take a fresh screenshot and look at it.** Don't infer success from
   the AppleScript call not throwing.

## Symptom 4: a second popup, "This meeting is being recorded"

**What we saw:** a separate, unrelated popup (unnamed window, `"OK"`
button) sometimes stacked on top of / alongside the lobby card, adding to
the join delay.

**Fix (`8f755f2`):** `dismissRecordingNoticeIfPresent()` -- scoped to a
window that also contains static text `"...being recorded..."` (not just
any `"OK"` button anywhere, since that word alone is too generic to click
blind). Unlike the lobby card's button, this one's `click b` (AXPress)
**did** work correctly first try -- not every button in this app has the
AXPress-does-nothing problem from symptom 3, so don't assume it applies
everywhere; check each one.

## Symptom 5: the whole join sequence is just slow, and inconsistent

**What we saw:** the lobby-card → click-audio → recording-notice →
window-mount chain, when it happens at all, routinely took longer than the
original 45s timeout to fully resolve -- sometimes over 90s. Other times
(most of the time, in later testing) the join is fast and none of this
appears at all; Zoom seems to non-deterministically choose between a fast
direct join and this slower lobby-card flow for reasons that were never
identified (not obviously tied to "second join in a session" -- that
pattern held once, then didn't hold on a later clean-relaunch test).

**Fix:** bumped `config.json`'s `zoom.joinTimeoutSeconds` from 45 to 90.

**Open question, not resolved:** why does Zoom sometimes take this slow
path and sometimes not? Candidate factors not yet ruled out: whether Zoom
was already running vs. cold-launched, network conditions, whether this is
the first join of the day vs. a rejoin, server-side Zoom Workplace
rollout/A-B state entirely outside this Mac's control. If this keeps
happening, the next debugging step is probably logging a timestamp at
every `dismissLobbyAudioPromptIfPresent()`/`dismissRecordingNoticeIfPresent()`
poll (not just relying on manual screenshots) to see exactly how long each
stage takes across several real occurrences, rather than continuing to
guess from screenshots taken by hand.

## Quick reference: files touched

- `lib/zoomMeeting.mjs` -- all the detection/toolbar/lobby-card/
  recording-notice logic described above.
- `config.json` -- `zoom.joinTimeoutSeconds: 45 -> 90`.
- Commits, in order: `f783293`, `a9eb24a`, `caa9107`, `8f755f2` (plus
  `65e36af` and `1364e20`, unrelated email-behavior changes made in the
  same session).

## If this breaks again

1. Don't assume it's the same cause as last time -- confirm live with a
   fresh window/accessibility dump first (see the recipe under Symptom 3).
2. Check whether Zoom auto-updated again (`zoom.us` -> About, or just note
   the date and compare against this doc's date).
3. If it's a genuinely new UI variant, follow the same recipe: reproduce
   it live, dump the real tree, match the narrowest unique attribute,
   verify the click actually does something on screen before trusting it.
4. Update this doc, not just the code -- the next person (or the next
   Zoom update) benefits from the reasoning, not just the final diff.
