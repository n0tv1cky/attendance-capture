// Joins/leaves the Zoom meeting itself, so mark-attendance.mjs can run
// unattended even if Zoom isn't already open in a meeting. Everything here
// was worked out and verified against a real live class, not guessed --
// see the comments at each step for what was actually observed.
//
// Two mechanisms are in play, deliberately kept separate:
//   - Menu bar items (System Events, by name): stable across window size/
//     position, used wherever Zoom exposes one (checking whether we're in
//     a meeting, muting/unmuting, video on/off).
//   - Toolbar buttons (Participants, Leave): NOT exposed via accessibility
//     at all until the mouse hovers over them (Zoom's toolbar only mounts
//     in the AX tree on hover -- confirmed by testing, see
//     lib/participants.mjs' equivalent note for the Participants panel
//     itself). There's no menu-bar equivalent for these, so this drives
//     real synthetic mouse movement (via `cliclick`) to specific points on
//     the "Zoom Meeting" window, computed as fixed offsets from its
//     right/bottom edges rather than raw screen coordinates -- Zoom's
//     toolbar buttons are fixed-size and anchored to the window edges, not
//     stretched proportionally, so edge-offsets hold up across window
//     sizes/positions better than a percentage-of-window-size guess would.
//     These offsets were measured once against a real maximized meeting
//     window; if a future Zoom version reflows the toolbar, the constants
//     below are the first thing to recheck.

import { execFileSync } from "node:child_process";

const CLICLICK = "/opt/homebrew/bin/cliclick";

function osascript(script) {
  // stderr set to "ignore" rather than inherited: several call sites here
  // expect AppleScript errors as normal control flow (e.g. probing whether
  // a window exists) and catch the resulting thrown error -- without this,
  // osascript's own diagnostic text for those still leaks straight to the
  // terminal even though the JS-level catch handles it fine.
  return execFileSync("osascript", ["-e", script], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

function activateZoom() {
  osascript('tell application "zoom.us" to activate');
}

function isZoomRunning() {
  try {
    const out = osascript('tell application "System Events" to (name of processes) contains "zoom.us"');
    return out.trim() === "true";
  } catch {
    return false;
  }
}

function listWindowNames() {
  const script = `
tell application "System Events"
  tell process "zoom.us"
    set out to ""
    repeat with w in windows
      try
        set out to out & (name of w as string) & linefeed
      end try
    end repeat
  end tell
end tell
return out`;
  try {
    return osascript(script)
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    // Found live: right after `open zoommtg://...` launches Zoom,
    // isZoomRunning() can go true (the process exists) before its window/AX
    // tree is actually queryable yet -- "tell process ... windows" then
    // throws instead of returning an empty list. Every caller here is
    // either a poll loop (isInMeeting(), called repeatedly by joinMeeting())
    // or an idempotent check (ensureParticipantsPanelOpen()), so treating a
    // transient AX-query failure as "no windows (yet)" and letting the
    // caller retry is correct -- same defensive pattern as isZoomRunning()
    // above, just one level further in. Before this fix, this exact race
    // killed a whole unattended run instead of just costing one poll cycle.
    return [];
  }
}

// The in-meeting content window's name starts with "Zoom Meeting" but isn't
// always exactly that -- found live that it can carry a per-join suffix
// ("Zoom Meeting Participant ID: 795276"), which silently broke every
// exact-name lookup that assumed the plain string (isInMeeting included --
// this was very likely the real explanation for several earlier "a dialog
// must be blocking window introspection" symptoms, not modals at all).
// Matched by prefix everywhere for that reason, never exact equality.
const MEETING_WINDOW_PREFIX = "Zoom Meeting";

export function isInMeeting() {
  if (!isZoomRunning()) return false;
  activateZoom();
  execFileSync("sleep", ["0.2"]);
  return listWindowNames().some((n) => n.startsWith(MEETING_WINDOW_PREFIX));
}

function getMeetingWindowBounds() {
  const script = `
tell application "System Events"
  tell process "zoom.us"
    set w to first window whose name begins with "${MEETING_WINDOW_PREFIX}"
    set {px, py} to position of w
    set {sw, sh} to size of w
    return (px as string) & "," & (py as string) & "," & (sw as string) & "," & (sh as string)
  end tell
end tell`;
  const out = osascript(script).trim();
  const [x, y, width, height] = out.split(",").map(Number);
  return { x, y, width, height };
}

// Originally measured live against a real maximized meeting window at
// width=1470 as a distance from the window's RIGHT edge, on the assumption
// the whole toolbar was right-anchored and offsets would hold regardless of
// window size. Found live (2026-08-27, on a 1920-wide window -- this Mac's
// actual full display width): that assumption was wrong for the main button
// group. Zoom's [Mute][Video][Participants][Chat][React][Share][More]
// cluster is anchored to the window's horizontal CENTER, not its right
// edge -- so a fixed fromRight offset only ever worked at the exact width
// it was measured on, and silently clicked the wrong button (or nothing) at
// any other width. This was the actual cause of "clicked where Participants
// should be but the panel didn't open" -- not a timing/race issue, despite
// how that error reads. Re-measured against the same 1920-wide window:
// Participants sits 122px left of center. Leave is NOT part of that
// group -- it's a separate button docked at the window's actual right edge
// -- so its original fromRight offset is kept as-is (and did work).
const TOOLBAR = {
  participants: { fromCenterX: -122, fromBottom: 37 },
  leave: { fromRight: 46, fromBottom: 33 },
};
// The "Leave meeting" confirm button in the popup that appears after
// clicking Leave -- kept as a fallback alongside the name-based search in
// leaveMeeting() (see there for why neither alone turned out reliable).
// Measured live, offset from the same window's edges as the toolbar.
const LEAVE_CONFIRM = { fromRight: 129, fromBottom: 89 };

function revealToolbar(bounds) {
  // Hover near bottom-center first -- any point along the toolbar strip
  // triggers Zoom to mount it in the AX tree / make it clickable.
  execFileSync(CLICLICK, ["m:" + Math.round(bounds.x + bounds.width / 2) + "," + Math.round(bounds.y + bounds.height - 20)]);
  execFileSync("sleep", ["0.15"]);
}

// `spec` is one of TOOLBAR's entries: either { fromCenterX, fromBottom }
// (the centered button group) or { fromRight, fromBottom } (a
// right-docked button, e.g. Leave) -- see TOOLBAR's comment for why these
// need different anchors.
function clickToolbarButton(spec) {
  const bounds = getMeetingWindowBounds();
  activateZoom();
  execFileSync("sleep", ["0.1"]);
  revealToolbar(bounds);
  const x = spec.fromCenterX != null ? Math.round(bounds.x + bounds.width / 2 + spec.fromCenterX) : Math.round(bounds.x + bounds.width - spec.fromRight);
  const y = Math.round(bounds.y + bounds.height - spec.fromBottom);
  execFileSync(CLICLICK, [`m:${x},${y}`]);
  execFileSync("sleep", ["0.1"]);
  execFileSync(CLICLICK, [`c:${x},${y}`]);
}

// Opens the Participants panel if it isn't already open. Idempotent --
// safe to call whether or not it's already showing. Polls for the panel to
// actually appear rather than a single fixed sleep, so the common case
// (it opens fast) doesn't pay for the worst case's wait time.
export function ensureParticipantsPanelOpen() {
  activateZoom();
  execFileSync("sleep", ["0.15"]);
  if (listWindowNames().some((n) => n.startsWith("Participants"))) return;

  clickToolbarButton(TOOLBAR.participants);

  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    activateZoom();
    if (listWindowNames().some((n) => n.startsWith("Participants"))) return;
    execFileSync("sleep", ["0.2"]);
  }
  throw new Error("Clicked where the Participants button should be, but the panel didn't open. Zoom's toolbar layout may have changed -- open it by hand and re-run.");
}

function getMenuItemNames(menuName) {
  const script = `
tell application "System Events"
  tell process "zoom.us"
    set out to ""
    repeat with mi in menu items of menu 1 of menu bar item "${menuName}" of menu bar 1
      try
        set out to out & (name of mi as string) & linefeed
      end try
    end repeat
  end tell
end tell
return out`;
  return osascript(script)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

function clickMenuItem(menuName, itemName) {
  const script = `
tell application "System Events"
  tell process "zoom.us"
    click menu item "${itemName}" of menu 1 of menu bar item "${menuName}" of menu bar 1
  end tell
end tell`;
  osascript(script);
}

// Belt-and-suspenders on top of Zoom's own "mute/video-off on join"
// settings (which already covered this in live testing, but aren't
// guaranteed to be enabled on every machine this ever runs on): the
// Meeting menu's audio/video items are a toggle whose *label* reflects
// current state ("Mute audio" = currently unmuted; "Unmute audio" =
// already muted), so reading the label tells us what to do rather than
// guessing.
export function ensureMutedAndVideoOff() {
  activateZoom();
  execFileSync("sleep", ["0.1"]);
  const items = getMenuItemNames("Meeting");
  if (items.includes("Mute audio")) clickMenuItem("Meeting", "Mute audio");
  if (items.includes("Stop video")) clickMenuItem("Meeting", "Stop video");
}

function meetingIdAndPasscodeFromLink(link) {
  const url = new URL(link);
  const confno = url.pathname.split("/").filter(Boolean).pop();
  const pwd = url.searchParams.get("pwd");
  return { confno, pwd };
}

// zoommtg:// is Zoom's own direct-launch URI scheme -- unlike opening the
// https join link (which routes through a browser interstitial page asking
// "Open in zoom.us?"), this hands off to the desktop app with no manual
// click in between. Verified live.
function toZoommtgUri(link) {
  const { confno, pwd } = meetingIdAndPasscodeFromLink(link);
  let uri = `zoommtg://zoom.us/join?action=join&confno=${confno}`;
  if (pwd) uri += `&pwd=${encodeURIComponent(pwd)}`;
  return uri;
}

// Finds and clicks a button anywhere across zoom.us's windows whose name
// contains any of `searchTexts` (case-sensitive per variant given -- pass
// both cases you expect), searching windows by index rather than by name.
// Used for anything shown in an unnamed/transient Zoom popup (this app
// seems to favor those for anything beyond its main windows), since
// indexing sidesteps needing a name for the window at all, and doing the
// find-and-click in one atomic AppleScript call avoids a race between two
// separate calls while a just-appeared popup's window list is still
// settling. This is deliberately preferred over computing a fixed pixel
// offset from a window's edges (the original approach for the Leave-confirm
// button): offsets measured once against one window size/position aren't
// guaranteed to hold at a different one, and this doesn't need them to.
function clickButtonContaining(searchTexts) {
  const conditions = searchTexts.map((t) => `bname contains "${t}"`).join(" or ");
  const script = `
tell application "System Events"
  tell process "zoom.us"
    set n to count of windows
    repeat with i from 1 to n
      try
        set btns to buttons of window i
        repeat with b in btns
          try
            set bname to name of b as string
            if ${conditions} then
              click b
              return "clicked:" & bname
            end if
          end try
        end repeat
      end try
    end repeat
  end tell
end tell
return "not found"`;
  try {
    return osascript(script).trim().startsWith("clicked:");
  } catch {
    return false;
  }
}

// Finds a window's bounds by name PREFIX, iterating the windows collection
// (like listWindowNames) rather than referencing `window "<exact name>"`
// directly -- the latter throws -1728 for windows System Events can't
// address by name outright (confirmed live, same issue noted throughout
// this file). Returns null if no window's name currently starts with
// `prefix`.
function getWindowBoundsByPrefix(prefix) {
  const script = `
tell application "System Events"
  tell process "zoom.us"
    repeat with w in windows
      try
        if (name of w as string) starts with "${prefix}" then
          set {px, py} to position of w
          set {sw, sh} to size of w
          return (px as string) & "," & (py as string) & "," & (sw as string) & "," & (sh as string)
        end if
      end try
    end repeat
  end tell
end tell
return "__NOT_FOUND__"`;
  try {
    const out = osascript(script).trim();
    if (out === "__NOT_FOUND__") return null;
    const [x, y, width, height] = out.split(",").map(Number);
    return { x, y, width, height };
  } catch {
    return null;
  }
}

// Zoom's "Choose one of the audio conference options" dialog -- separate
// from the pre-join preview, and shown whenever "Automatically join
// computer audio when joining a meeting" isn't enabled in Zoom's settings.
// Found live: this dialog being up makes the main "Zoom Meeting" window
// briefly unaddressable by name to System Events ("Can't get window
// -1728"), breaking every toolbar-button click that follows, so it has to
// be cleared before anything else touches the meeting window.
//
// clickButtonContaining() alone turned out NOT to be reliable here: found
// live (2026-08-27) that on the current Zoom version, this dialog's buttons
// report `missing value` for their name via System Events -- there's simply
// no accessible title to search for, so the name-based click always
// silently returns false and the dialog is left blocking everything
// downstream (every subsequent toolbar click failed because of this, not
// because of anything toolbar-related). Falls back to a coordinate click at
// the dialog's own center -- measured live, "Join with computer audio" (the
// default/primary button) sits there -- found via getWindowBoundsByPrefix
// so it doesn't need the dialog's exact window name either (also unreliable
// -- its title has been observed both present and, per the same
// missing-value pattern, possibly absent on some Zoom versions).
function dismissAudioDialogIfPresent() {
  if (clickButtonContaining(["Computer Audio", "computer audio"])) return true;

  const bounds = getWindowBoundsByPrefix("Choose one of the audio conference options");
  if (!bounds) return false;
  const x = Math.round(bounds.x + bounds.width / 2);
  const y = Math.round(bounds.y + bounds.height / 2);
  execFileSync(CLICLICK, [`c:${x},${y}`]);
  return true;
}

// Joins the given meeting link and waits until it's actually connected
// (isInMeeting() true) or gives up after timeoutSeconds. Does NOT touch the
// pre-join preview dialog's Join button -- that dialog only appears with
// "Always show this preview when joining" enabled in Zoom's settings; if
// it's on, this will time out waiting and surface a clear error rather than
// blindly clicking around an unverified dialog. Turn that setting off in
// Zoom for unattended use. The audio-conference dialog (see above) IS
// handled automatically, once we're confirmed in the meeting -- it doesn't
// block isInMeeting() from becoming true, only the toolbar clicks after it.
export async function joinMeeting(link, { timeoutSeconds = 45 } = {}) {
  const uri = toZoommtgUri(link);
  execFileSync("open", [uri]);

  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    if (isInMeeting()) {
      // Poll briefly for the audio dialog too -- it can appear a moment
      // after the meeting window itself does. Short budget: most of the
      // time there's nothing to dismiss at all (e.g. "automatically join
      // computer audio" is already enabled), so this shouldn't cost more
      // than about a second in the common case.
      for (let i = 0; i < 3; i++) {
        if (dismissAudioDialogIfPresent()) break;
        await new Promise((r) => setTimeout(r, 300));
      }
      return;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(
    `Timed out after ${timeoutSeconds}s waiting to join the meeting. If Zoom is showing a pre-join preview dialog, either click "Join" by hand or disable "Always show this preview when joining" in Zoom's settings for unattended runs. Also seen live (2026-08-29): a real network outage right after the Mac woke from sleep caused this same timeout AND made the failure-report email itself fail to send (DNS lookup failure) -- confirmed the screen being locked was NOT the cause that time (join/leave/participants-read all work fine on a locked screen on this Mac, verified live immediately after). A forced leave attempt still runs regardless of which of these it was (see mark-attendance.mjs's finally block) so the bot doesn't get stranded either way.`
  );
}

// Leaves the current meeting: click Leave (toolbar, needs the hover+offset
// approach since it's not exposed to accessibility until hovered -- see
// clickToolbarButton), then confirm via the popup that appears.
//
// The confirm click uses BOTH mechanisms tried so far, because each has
// failed differently in practice: the name-based search
// (clickButtonContaining) assumes the popup's button is exposed to
// accessibility, which held for the audio dialog but apparently doesn't
// always hold here -- this popup may behave like the toolbar itself
// (nothing exposed until something rendering-related triggers it), which
// would make the search silently find nothing and skip the click with no
// error. The fixed-offset coordinate click (the original approach) is a
// raw synthetic click that doesn't need accessibility exposure at all, so
// it's kept as a fallback for exactly that case -- recomputed fresh each
// attempt rather than cached, so it isn't the earlier position-drift
// problem either.
//
// Confirming success is its own problem: isInMeeting() can misread "false"
// for a moment while this same popup is up, blocking window introspection
// (the same -1728 issue the audio dialog caused for getMeetingWindowBounds)
// -- a single "false" reading isn't trustworthy evidence we actually left.
// Two consecutive "gone" readings, a beat apart, are required before this
// returns success, so a transient misread can't look like a real leave and
// silently strand the run mid-meeting with no error.
//
// `force: true` skips the isInMeeting() early-return -- for whenever a
// caller can't fully trust a "not in a meeting" reading. Added live
// (2026-08-29) after joinMeeting() timed out and threw during a real
// network outage (confirmed separately -- the same run's failure-report
// email also failed with a DNS lookup error), even though isInMeeting()
// itself works fine on a locked screen on this Mac (verified immediately
// after: join, participants-read, and leave all worked normally while
// locked -- an earlier theory here blamed the screen lock specifically,
// which turned out to be wrong; the actual cause was the network outage,
// which broke the Zoom connection itself, not System Events' ability to
// see it). Either way, joinMeeting() throwing before confirming success
// meant mark-attendance.mjs never got to set joinedByUs = true, so its own
// isInMeeting()-gated leave never ran -- the bot could be left sitting in
// the meeting indefinitely, unmanaged, with no error surfaced. `force` lets
// a caller
// attempt to leave anyway whenever the join outcome is ambiguous rather
// than confirmed-false; it's harmless to call when genuinely not in a
// meeting (the click sequence below just lands on nothing and this returns
// via the failure path below, same as any other unconfirmed leave attempt).
export async function leaveMeeting({ force = false } = {}) {
  if (!force && !isInMeeting()) return;

  clickToolbarButton(TOOLBAR.leave);
  execFileSync("sleep", ["0.7"]);
  activateZoom();
  execFileSync("sleep", ["0.2"]);

  for (let i = 0; i < 6; i++) {
    if (clickButtonContaining(["Leave meeting", "Leave Meeting"])) break;
    try {
      const bounds = getMeetingWindowBounds();
      const x = Math.round(bounds.x + bounds.width - LEAVE_CONFIRM.fromRight);
      const y = Math.round(bounds.y + bounds.height - LEAVE_CONFIRM.fromBottom);
      execFileSync(CLICLICK, [`m:${x},${y}`]);
      execFileSync("sleep", ["0.1"]);
      execFileSync(CLICLICK, [`c:${x},${y}`]);
    } catch {
      // Meeting window can be briefly unaddressable while the confirm
      // popup is up -- not fatal, just try again next iteration.
    }
    await new Promise((r) => setTimeout(r, 400));
  }

  const deadline = Date.now() + 15000;
  let consecutiveGone = 0;
  while (Date.now() < deadline) {
    if (!isInMeeting()) {
      consecutiveGone++;
      if (consecutiveGone >= 2) return;
    } else {
      consecutiveGone = 0;
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  throw new Error('Clicked Leave, but couldn\'t confirm leaving -- still appear to be in the meeting. Zoom may be showing a different confirm dialog than expected; check Zoom and click "Leave meeting" by hand.');
}
