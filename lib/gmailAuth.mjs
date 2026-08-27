// Dedicated OAuth for lib/notify.mjs's Gmail send -- deliberately its own
// scope (gmail.send only) and its own token file
// (~/.attendance-sync/gmail-token.json), kept fully separate from
// mark-attendance.mjs's spreadsheets/drive.readonly token even though
// both reuse the same oauth-client.json app.
//
// Why not just add gmail.send to the existing token in
// lib/googleAuth.mjs: that token is obtained via @google-cloud/
// local-auth's authenticate(), which hardcodes access_type: 'offline' but
// never sets prompt: 'consent' and exposes no option to add it. Per
// docs/email-notifications.md (hit and fixed for real in scripts/
// calendar-sync), adding a new scope to an *existing* cached grant without
// prompt=consent makes Google silently reissue a token scoped to only the
// original grant -- every gmail.send call would then 403 with
// ACCESS_TOKEN_SCOPE_INSUFFICIENT despite a visibly "successful" consent
// screen. A brand-new token file for a brand-new scope sidesteps the whole
// problem: this is a first-time consent, not an incremental one, so the
// missing prompt=consent option never matters. This file runs its own tiny
// local-server OAuth flow (same pattern as scripts/calendar-sync/lib/
// googleAuth.mjs) so that if a scope is ever added here later, prompt=consent
// is available too.

import { google } from "googleapis";
import http from "node:http";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const SCOPES = ["https://www.googleapis.com/auth/gmail.send"];

function readClientKey(clientSecretFile) {
  const keys = JSON.parse(fs.readFileSync(clientSecretFile, "utf8"));
  return keys.installed ?? keys.web;
}

function buildClient(clientSecretFile, tokens) {
  const key = readClientKey(clientSecretFile);
  const client = new google.auth.OAuth2(key.client_id, key.client_secret, key.redirect_uris?.[0]);
  client.setCredentials(tokens);
  return client;
}

function loadSavedTokens(tokenFile) {
  if (!fs.existsSync(tokenFile)) return null;
  return JSON.parse(fs.readFileSync(tokenFile, "utf8"));
}

function saveTokens(tokenFile, tokens) {
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
  fs.writeFileSync(tokenFile, JSON.stringify(tokens));
}

function openBrowser(url) {
  execFile("open", [url]);
}

function interactiveConsent(client, scopes) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, "http://localhost");
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");
        if (error) throw new Error(`Google returned an error: ${error}`);
        if (!code) return;

        res.end("Authentication successful! You can close this tab and return to the terminal.");
        server.close();

        const { tokens } = await client.getToken({ code, redirect_uri: redirectUri });
        resolve(tokens);
      } catch (err) {
        res.end(`Authentication failed: ${err.message}`);
        server.close();
        reject(err);
      }
    });

    let redirectUri;
    server.listen(0, "localhost", () => {
      redirectUri = `http://localhost:${server.address().port}`;
      const authorizeUrl = client.generateAuthUrl({
        access_type: "offline",
        prompt: "consent",
        scope: scopes,
        redirect_uri: redirectUri,
      });
      console.log("Opening a browser tab for one-time sign-in (Gmail send only)...");
      openBrowser(authorizeUrl);
    });

    server.on("error", reject);
  });
}

export async function getGmailAuthClient(clientSecretFile, tokenFile) {
  const saved = loadSavedTokens(tokenFile);
  if (saved) {
    const client = buildClient(clientSecretFile, saved);
    client.on("tokens", (tokens) => saveTokens(tokenFile, { ...saved, ...tokens }));
    await client.getAccessToken();
    return client;
  }

  const client = buildClient(clientSecretFile, {});
  const tokens = await interactiveConsent(client, SCOPES);
  if (!tokens.refresh_token) {
    throw new Error("Google didn't return a refresh_token -- if you've consented to this app+scope before, revoke access at https://myaccount.google.com/permissions and try again so Google issues a fresh one.");
  }
  client.setCredentials(tokens);
  saveTokens(tokenFile, client.credentials);
  client.on("tokens", (newTokens) => saveTokens(tokenFile, { ...client.credentials, ...newTokens }));
  return client;
}
