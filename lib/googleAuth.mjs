// Google OAuth for this project -- deliberately separate token file from
// scripts/zoom-recordings' cached login (even though it reuses the same
// oauth-client.json app), because the scopes differ: this project needs
// read-write Sheets access plus read-only Drive (to fetch the raw .xlsx
// schedule file), whereas the recordings sync only ever asked for
// spreadsheets.readonly + full drive. Keeping them separate means widening
// scope here can't silently invalidate the other project's cached consent.

import { google } from "googleapis";
import { authenticate } from "@google-cloud/local-auth";
import fs from "node:fs";
import path from "node:path";

// drive.file (not full "drive") is deliberate: it only grants access to
// files this app itself creates, which is all that's needed beyond
// drive.readonly (reading the pre-existing schedule .xlsx) -- e.g. creating
// a disposable scratch sheet for testing without broadening access to the
// user's whole Drive.
const SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/drive.file",
];

function loadSavedAuth(tokenFile) {
  if (!fs.existsSync(tokenFile)) return null;
  return google.auth.fromJSON(JSON.parse(fs.readFileSync(tokenFile, "utf8")));
}

function saveAuth(tokenFile, client, clientSecretFile) {
  const keys = JSON.parse(fs.readFileSync(clientSecretFile, "utf8"));
  const key = keys.installed ?? keys.web;
  const payload = JSON.stringify({
    type: "authorized_user",
    client_id: key.client_id,
    client_secret: key.client_secret,
    refresh_token: client.credentials.refresh_token,
  });
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
  fs.writeFileSync(tokenFile, payload);
}

export async function getGoogleAuthClient(clientSecretFile, tokenFile) {
  const saved = loadSavedAuth(tokenFile);
  if (saved) return saved;

  console.log("No cached Google login found -- opening a browser tab for one-time sign-in (Sheets read/write + Drive read-only)...");
  const client = await authenticate({ scopes: SCOPES, keyfilePath: clientSecretFile });
  if (client.credentials?.refresh_token) saveAuth(tokenFile, client, clientSecretFile);
  return client;
}
