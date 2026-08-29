// Emails a short report for unattended (launchd-triggered) runs -- the
// interactive/manual flow never calls this, since a human watching the
// terminal doesn't need an email about what they just watched happen.
//
// Deliberately minimal compared to zoom-recordings' send-report.mjs: no
// retry-queuing logic here, since a missed/skipped attendance run just gets
// caught by countSessionOccurrences + the live/recent grace window next
// time this is run (manually or on the next scheduled slot) -- there's no
// "same-day retry" concept to gate.

import { google } from "googleapis";
import { getGmailAuthClient } from "./gmailAuth.mjs";

function buildRawMessage({ to, from, subject, html }) {
  const messageParts = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: =?utf-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`,
    "MIME-Version: 1.0",
    "Content-Type: text/html; charset=utf-8",
    "",
    html,
  ];
  return Buffer.from(messageParts.join("\r\n")).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const RETRY_DELAYS_MS = [3000, 10000, 20000];

// A failed send must never throw up into the caller -- the attendance run's
// own outcome (written/skipped/failed) matters regardless of whether we
// managed to tell anyone about it. subject/html are built by
// lib/emailTemplate.mjs -- this function only handles the actual send.
//
// Retries a few times on failure (a few seconds apart, total budget ~35s)
// before giving up silently. Found live (2026-08-29): a scheduled run fired
// right as the Mac wasn't fully awake yet -- the "run FAILED" report itself
// failed to send ("getaddrinfo ENOTFOUND gmail.googleapis.com", i.e. Wi-Fi
// hadn't reconnected yet) with no retry, so the run's actual failure (Zoom
// couldn't be joined -- a real network outage, confirmed separately, not
// the screen being locked as first suspected) produced *no* notification at
// all, not even a late one. Networking typically comes back within a few
// seconds of wake, so a short retry window turns "silently missed" into
// "arrived a bit late" for exactly that case, without adding a persistent
// retry-queue mechanism this project doesn't otherwise need (see header
// comment above).
export async function sendNotification(config, { subject, html }) {
  for (let attempt = 0; ; attempt++) {
    try {
      const authClient = await getGmailAuthClient(config.googleOAuth.clientSecretFile, config.notifications.tokenFile);
      const gmail = google.gmail({ version: "v1", auth: authClient });
      const raw = buildRawMessage({
        to: config.notifications.toEmail,
        from: config.notifications.toEmail,
        subject,
        html,
      });
      await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
      console.error(`Report emailed: ${subject}`);
      return;
    } catch (err) {
      if (attempt >= RETRY_DELAYS_MS.length) {
        console.error(`WARN: failed to send report email after ${attempt + 1} attempt(s): ${err.message}`);
        return;
      }
      console.error(`WARN: send attempt ${attempt + 1} failed (${err.message}) -- retrying in ${RETRY_DELAYS_MS[attempt] / 1000}s...`);
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
    }
  }
}
