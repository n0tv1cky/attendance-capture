# Sending notification emails from a script (Gmail API)

Distilled from building `scripts/calendar-sync`'s change-notification email,
including several real failures hit and fixed along the way. Written down so
any future script here that needs to notify a human by email (not just
calendar-sync) can reuse the pattern and skip re-discovering the same bugs.
Reusable code: `scripts/calendar-sync/lib/googleAuth.mjs` (auth) and
`lib/notify.mjs` (compose + send) — copy and adapt rather than reinventing.

## Why Gmail API, not Calendar's built-in guest notifications

The obvious shortcut for "notify me when an event changes" is Calendar's own
attendee-notification email (`sendUpdates: 'all'` on `events.patch`/`insert`)
— it's free, requires no new scope, and looks like a normal Calendar email.
**Rejected**, for reasons worth knowing before reaching for it on a future
project:

- **It's per-API-call, not batched.** A sync touching many events in one run
  (confirmed live: calendar-sync's first run touched 139) would send 139
  separate emails, not one digest. Solving that requires the same
  batching/suppression logic you'd need to build for a custom send anyway —
  so it doesn't actually save the implementation work it looks like it would.
- **Content is fixed.** You can't make Calendar's own template show a
  grouped "created / changed (before→after) / removed" digest — anything
  beyond "event updated" needs a custom-composed email regardless.
- **Requires a permanent, unwanted side-effect on the data.** To get the
  notification at all, you must add yourself as an "attendee" on every event
  — which puts an RSVP field (needsAction/accepted/declined) on every event
  forever, just to piggyback on a notification side-channel.
- **Less deterministic.** Attendee notifications are also gated by the
  recipient's own Calendar notification preferences — one more layer to
  debug versus a direct send you fully control.

Sending the email yourself via the Gmail API is more code up front but is
fully controllable, batchable into one digest, and has no side effects on
unrelated data.

## Scope: `gmail.send`, and what it does NOT let you do

`https://www.googleapis.com/auth/gmail.send` is the least-privilege scope
that can send mail — it cannot read, search, list, or delete anything in the
mailbox. That last part has a real consequence: **`gmail.users.getProfile`
does NOT work with only `gmail.send`** (confirmed live: "Request had
insufficient authentication scopes" calling it with a token scoped to
`gmail.send` alone — it needs `gmail.readonly`, `gmail.metadata`, or
broader). If you need the sending account's own address, don't call
`getProfile` to look it up — either you already know it (it's the account
that owns the OAuth token) or you'd need a broader scope just for that one
lookup, which defeats the point of using the narrowest scope available.
calendar-sync sidesteps this entirely: the notification's `to` and `from`
are configured as the same known address, no lookup needed.

## The same OAuth friction as any new scope on an existing app

Adding `gmail.send` to a Google Cloud OAuth app that already has other
scopes granted (e.g. Calendar, Drive) hits the exact same two-step friction
documented for this project's Calendar setup — nothing Gmail-specific here,
but easy to forget when adding a *new* scope to *any* existing app:

1. **Enabling the API is not enough.** The scope must also be explicitly
   added on the OAuth consent screen's **Data Access** page (Cloud Console →
   APIs & Services → OAuth consent screen → Data Access → Add or Remove
   Scopes), separately from the Gmail API being enabled on the project.
2. **A repeat login without `prompt: 'consent'` silently keeps the old
   grant.** If a user already consented to this app once, Google will not
   re-prompt for a newly-added scope on a plain repeat login — it silently
   reissues a token scoped to the *original* grant, and every subsequent
   call needing the new scope 403s with `ACCESS_TOKEN_SCOPE_INSUFFICIENT`,
   even though the browser visibly shows a "successful" consent each time.
   `@google-cloud/local-auth` cannot be told to add `prompt: 'consent'` (no
   such option), which is exactly why `scripts/calendar-sync/lib/
   googleAuth.mjs` runs its own tiny local-server OAuth flow instead of that
   package — see that file's header comment for the full mechanics. Reuse
   that flow rather than `@google-cloud/local-auth` for any new script that
   might ever need to add a scope later (i.e. always).

There is also a real `google-auth-library` version-mismatch bug independent
of Gmail specifically — see `googleAuth.mjs`'s file-header comment ("never
hand the OAuth2Client that @google-cloud/local-auth returns directly to
google.calendar()/google.drive()") — relevant to any Google API client in
this repo, not just Gmail.

## Composing and sending the email

The Gmail API's `users.messages.send` takes one field, `raw`: a full RFC822
email (headers + body), base64url-encoded (`+`→`-`, `/`→`_`, no padding).
There's no separate "subject"/"html" fields on the request — you build the
raw message yourself:

```js
function buildRawMessage({ to, from, subject, html }) {
  const messageParts = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: =?utf-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`, // RFC 2047 -- needed for a subject with anything outside ASCII; harmless for plain ASCII subjects too
    "MIME-Version: 1.0",
    "Content-Type: text/html; charset=utf-8",
    "",
    html,
  ];
  const message = messageParts.join("\r\n");
  return Buffer.from(message).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
```

`from` must be the authenticated account's own address (or a verified
alias) — Gmail rejects/overrides an arbitrary `From`.

## Design decisions worth keeping for any future notification email

- **Digest per run, never per event.** Only send when there's something to
  report (`created + updated + deleted > 0` after a real, non-dry-run sync)
  — a no-op run sends nothing. One email listing everything that changed,
  not one email per change.
- **A failed send must not fail the whole job.** Wrap the send in its own
  try/catch; the underlying work (calendar-sync's actual sync) already
  succeeded and matters more than the notification about it. Log the
  failure, don't throw.
- **Subject line front-loads the specific thing that changed, not just a
  count.** `"MSDSM: PS S1 moved 19:00→20:00"` tells you everything from a
  lock-screen notification banner alone; `"1 schedule change synced"` tells
  you nothing until you open it. For several changes, list compact
  per-item descriptions up to a character budget, then `"+N more"`, rather
  than a bare count. See `buildSubject()` in `lib/notify.mjs`.
- **Times in the recipient's actual local convention, explicitly.** This
  project's audience expects IST in 24-hour `HH:MM`, no date repeated in a
  field that's already inside a card showing the date once — match whatever
  your actual audience expects rather than a generic default; don't assume.
- **HTML email = inline styles only, table-based layout.** No `<style>`
  blocks, no external CSS/fonts/scripts — most email clients strip or
  ignore them. `role="presentation"` tables are still the most reliable
  cross-client layout primitive, even in 2026.
