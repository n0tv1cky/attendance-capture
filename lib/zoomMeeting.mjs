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
  return execFileSync("osascript", ["-e", script], { encoding: "utf8" });
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
  return osascript(script)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

// "Zoom Meeting" is the name of the actual in-meeting content window --
// confirmed present only while genuinely in a meeting, and absent (just the
// "Zoom Workplace" home window) otherwise, by testing both states live.
export function isInMeeting() {
  if (!isZoomRunning()) return false;
  activateZoom();
  execFileSync("sleep", ["0.4"]);
  return listWindowNames().includes("Zoom Meeting");
}

function getMeetingWindowBounds() {
  const script = `
tell application "System Events"
  tell process "zoom.us"
    set w to window "Zoom Meeting"
    set {px, py} to position of w
    set {sw, sh} to size of w
    return (px as string) & "," & (py as string) & "," & (sw as string) & "," & (sh as string)
  end tell
end tell`;
  const out = osascript(script).trim();
  const [x, y, width, height] = out.split(",").map(Number);
  return { x, y, width, height };
}

// Measured live against a real maximized meeting window (bounds
// x=0,y=33,width=1470,height=923): each toolbar button's distance from the
// window's right and bottom edges, which stays roughly constant regardless
// of window size since the toolbar itself doesn't stretch.
const TOOLBAR = {
  participants: { fromRight: 857, fromBottom: 37 },
  leave: { fromRight: 46, fromBottom: 33 },
};

function revealToolbar(bounds) {
  // Hover near bottom-center first -- any point along the toolbar strip
  // triggers Zoom to mount it in the AX tree / make it clickable.
  execFileSync(CLICLICK, ["m:" + Math.round(bounds.x + bounds.width / 2) + "," + Math.round(bounds.y + bounds.height - 20)]);
  execFileSync("sleep", ["0.3"]);
}

function clickToolbarButton({ fromRight, fromBottom }) {
  const bounds = getMeetingWindowBounds();
  activateZoom();
  execFileSync("sleep", ["0.2"]);
  revealToolbar(bounds);
  const x = Math.round(bounds.x + bounds.width - fromRight);
  const y = Math.round(bounds.y + bounds.height - fromBottom);
  execFileSync(CLICLICK, [`m:${x},${y}`]);
  execFileSync("sleep", ["0.15"]);
  execFileSync(CLICLICK, [`c:${x},${y}`]);
}

// Opens the Participants panel if it isn't already open. Idempotent --
// safe to call whether or not it's already showing.
export function ensureParticipantsPanelOpen() {
  activateZoom();
  execFileSync("sleep", ["0.3"]);
  if (listWindowNames().some((n) => n.startsWith("Participants"))) return;

  clickToolbarButton(TOOLBAR.participants);
  execFileSync("sleep", ["0.6"]);
  activateZoom();
  execFileSync("sleep", ["0.3"]);
  if (!listWindowNames().some((n) => n.startsWith("Participants"))) {
    throw new Error("Clicked where the Participants button should be, but the panel didn't open. Zoom's toolbar layout may have changed -- open it by hand and re-run.");
  }
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
  execFileSync("sleep", ["0.2"]);
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

// Zoom's "Choose one of the audio conference options" dialog -- separate
// from the pre-join preview, and shown whenever "Automatically join
// computer audio when joining a meeting" isn't enabled in Zoom's settings.
// Found live: this dialog being up makes the main "Zoom Meeting" window
// briefly unaddressable by name to System Events ("Can't get window
// -1728"), breaking every toolbar-button click that follows, so it has to
// be cleared before anything else touches the meeting window.
function dismissAudioDialogIfPresent() {
  return clickButtonContaining(["Computer Audio", "computer audio"]);
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
      // after the meeting window itself does.
      for (let i = 0; i < 5; i++) {
        if (dismissAudioDialogIfPresent()) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      return;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(
    `Timed out after ${timeoutSeconds}s waiting to join the meeting. If Zoom is showing a pre-join preview dialog, either click "Join" by hand or disable "Always show this preview when joining" in Zoom's settings for unattended runs.`
  );
}

// Leaves the current meeting: click Leave (toolbar, needs the hover+offset
// approach since it's not exposed to accessibility until hovered -- see
// clickToolbarButton), then confirm via the popup that appears, found by
// name instead of a fixed pixel offset (see clickButtonContaining -- a
// fixed offset from the "Leave" click point broke in practice when the
// meeting window's size/position differed from the one it was measured
// against). Verified live end-to-end, both the original offset-based
// version and this name-based fix.
export async function leaveMeeting() {
  if (!isInMeeting()) return;

  clickToolbarButton(TOOLBAR.leave);
  execFileSync("sleep", ["0.6"]);
  activateZoom();
  execFileSync("sleep", ["0.2"]);

  for (let i = 0; i < 6; i++) {
    if (clickButtonContaining(["Leave meeting", "Leave Meeting"])) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (!isInMeeting()) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('Clicked Leave, but couldn\'t confirm leaving -- still appear to be in the meeting. Zoom may be showing a different confirm dialog than expected; check Zoom and click "Leave meeting" by hand.');
}
