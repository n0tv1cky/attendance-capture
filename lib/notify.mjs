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

function buildRawMessage({ to, from, subject, text }) {
  const messageParts = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: =?utf-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    text,
  ];
  return Buffer.from(messageParts.join("\r\n")).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// A failed send must never throw up into the caller -- the attendance run's
// own outcome (written/skipped/failed) matters regardless of whether we
// managed to tell anyone about it.
export async function sendNotification(config, { subject, bodyLines }) {
  try {
    const authClient = await getGmailAuthClient(config.googleOAuth.clientSecretFile, config.notifications.tokenFile);
    const gmail = google.gmail({ version: "v1", auth: authClient });
    const raw = buildRawMessage({
      to: config.notifications.toEmail,
      from: config.notifications.toEmail,
      subject,
      text: bodyLines.join("\n"),
    });
    await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
    console.error(`Report emailed: ${subject}`);
  } catch (err) {
    console.error(`WARN: failed to send report email: ${err.message}`);
  }
}
