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
// The "Leave meeting" confirm button in the popup that appears after
// clicking Leave -- also measured live, offset from the same window's edges
// (the popup anchors near the Leave button, not to the window center).
const LEAVE_CONFIRM = { fromRight: 129, fromBottom: 89 };

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

// Joins the given meeting link and waits until it's actually connected
// (isInMeeting() true) or gives up after timeoutSeconds. Does NOT touch the
// pre-join preview dialog's Join button -- that dialog only appears with
// "Always show this preview when joining" enabled in Zoom's settings; if
// it's on, this will time out waiting and surface a clear error rather than
// blindly clicking around an unverified dialog. Turn that setting off in
// Zoom for unattended use.
export async function joinMeeting(link, { timeoutSeconds = 45 } = {}) {
  const uri = toZoommtgUri(link);
  execFileSync("open", [uri]);

  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    if (isInMeeting()) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(
    `Timed out after ${timeoutSeconds}s waiting to join the meeting. If Zoom is showing a pre-join preview dialog, either click "Join" by hand or disable "Always show this preview when joining" in Zoom's settings for unattended runs.`
  );
}

// Leaves the current meeting: click Leave, then confirm in the popup that
// appears. Verified live end-to-end (including the confirm step) against a
// real meeting.
export async function leaveMeeting() {
  if (!isInMeeting()) return;

  clickToolbarButton(TOOLBAR.leave);
  execFileSync("sleep", ["0.6"]);

  const bounds = getMeetingWindowBounds();
  activateZoom();
  execFileSync("sleep", ["0.2"]);
  const x = Math.round(bounds.x + bounds.width - LEAVE_CONFIRM.fromRight);
  const y = Math.round(bounds.y + bounds.height - LEAVE_CONFIRM.fromBottom);
  execFileSync(CLICLICK, [`c:${x},${y}`]);

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (!isInMeeting()) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('Clicked Leave and the confirm button, but still appear to be in the meeting. Check Zoom -- the confirm dialog\'s position may have shifted, or it needs a manual "Leave meeting" click.');
}
