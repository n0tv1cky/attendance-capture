// Builds attendance notification emails as HTML -- same visual pattern as
// the sibling calendar-sync/zoom-recordings projects' lib/notify.mjs (card
// per item, colored left accent bar, uppercase badge section headers), just
// with content specific to a marking run: subject/session summary,
// unmatched participants needing manual review, and skip/failure reasons.
// All three build*Email functions here are pure -- no I/O, no decisions
// about *whether* to send -- lib/notify.mjs's sendNotification() owns that.

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderCard({ accentColor, title, subtitle, body }) {
  return `
    <tr>
      <td style="padding:0 0 10px 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff; border-radius:10px; box-shadow:0 1px 2px rgba(0,0,0,0.06); overflow:hidden;">
          <tr>
            <td width="4" style="background:${accentColor};"></td>
            <td style="padding:14px 16px;">
              <div style="font-size:14px; font-weight:600; color:#1a1a1a;">${escapeHtml(title)}</div>
              ${subtitle ? `<div style="font-size:12.5px; color:#5f6368; margin-top:2px;">${escapeHtml(subtitle)}</div>` : ""}
              ${body ?? ""}
            </td>
          </tr>
        </table>
      </td>
    </tr>`;
}

function renderSection(title, badgeColor, items, cardHtmlFor) {
  if (items.length === 0) return "";
  return `
    <tr><td style="padding:22px 0 8px 2px;">
      <span style="font-size:11px; font-weight:700; letter-spacing:0.04em; text-transform:uppercase; color:${badgeColor};">${escapeHtml(title)}</span>
      <span style="font-size:11px; color:#9aa0a6; margin-left:6px;">${items.length}</span>
    </td></tr>
    ${items.map(cardHtmlFor).join("")}`;
}

function statPill(label, value, color) {
  return `<span style="display:inline-block; font-size:12px; color:${color ?? "#5f6368"}; background:#f1f3f4; border-radius:10px; padding:3px 10px; margin:4px 6px 0 0;"><strong style="color:#1a1a1a;">${value}</strong> ${escapeHtml(label)}</span>`;
}

// One row per matched participant: raw Zoom display name -> matched student
// (roll number), plus the match method/confidence -- same information the
// terminal output already shows per line (`[method score] "raw" -> name
// (roll)`), just as a table instead of console lines. Rendered as one table
// inside a single card rather than one card per person: with up to ~30
// participants a card each would make the email absurdly long for what's
// fundamentally a lookup table, not a set of distinct events.
function renderMatchedTable(matched) {
  if (matched.length === 0) return "";
  const rows = matched
    .map(
      (m) => `
      <tr>
        <td style="padding:5px 8px 5px 0; font-size:12.5px; color:#1a1a1a; border-top:1px solid #f1f3f4;">${escapeHtml(m.participant.raw)}</td>
        <td style="padding:5px 4px; font-size:12.5px; color:#9aa0a6; border-top:1px solid #f1f3f4;">→</td>
        <td style="padding:5px 0 5px 4px; font-size:12.5px; color:#1a1a1a; border-top:1px solid #f1f3f4; white-space:nowrap;">
          ${escapeHtml(m.student.name)} <span style="color:#5f6368;">(${escapeHtml(m.student.rollNumber)})</span>
          <span style="font-size:10.5px; color:#5f6368; background:#f1f3f4; border-radius:8px; padding:1px 6px; margin-left:4px;">${escapeHtml(m.method)}${m.score < 1 ? ` ${m.score.toFixed(2)}` : ""}</span>
        </td>
      </tr>`
    )
    .join("");
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:10px;">
      ${rows}
    </table>`;
}

function codeBlock(text) {
  return `<div style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; background:#f1f3f4; color:#1a1a1a; border-radius:6px; padding:8px 10px; margin-top:8px; overflow-x:auto; white-space:pre;">${escapeHtml(text)}</div>`;
}

function shell({ headline, subheadline, sections, footer }) {
  return `
<div style="background:#f4f5f7; padding:32px 16px; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px; margin:0 auto;">
    <tr>
      <td style="padding-bottom:18px;">
        <div style="font-size:13px; color:#5f6368; font-weight:600; letter-spacing:0.02em;">🎓 ATTENDANCE</div>
        <div style="font-size:20px; font-weight:700; color:#1a1a1a; margin-top:4px;">${headline}</div>
        ${subheadline ? `<div style="font-size:13px; color:#5f6368; margin-top:4px;">${subheadline}</div>` : ""}
      </td>
    </tr>
    ${sections.join("")}
    <tr>
      <td style="padding-top:28px; border-top:1px solid #e8eaed; margin-top:12px;">
        <div style="font-size:11.5px; color:#9aa0a6; padding-top:14px;">${footer}</div>
      </td>
    </tr>
  </table>
</div>`;
}

const FOOTER = "Sent automatically by the scheduled attendance run. Full logs: ~/.attendance-sync/runs.jsonl and participants.jsonl.";

// subjectDetection is one of "skipped-no-schedule"|"skipped-none-live"|"skipped-ambiguous"
// (see pickSubject in mark-attendance.mjs) -- skipInfo carries the reason
// text and, when relevant, today's full scheduled-classes list.
export function buildSkippedEmail({ subjectDetection, skipInfo }) {
  const label = { "skipped-no-schedule": "no schedule entry for today", "skipped-none-live": "no class live right now", "skipped-ambiguous": "ambiguous" }[subjectDetection] ?? subjectDetection;
  const subject = `Attendance: skipped (${label})`;

  const todayList = skipInfo.allToday?.length
    ? `<div style="margin-top:10px;">${skipInfo.allToday.map((c) => statPill(`${c.subjectCode} (${c.rawCell})`, c.label)).join("")}</div>`
    : "";

  const html = shell({
    headline: "Skipped",
    subheadline: escapeHtml(skipInfo.reason),
    sections: [
      renderCard({
        accentColor: "#9aa0a6",
        title: "Nothing was written",
        subtitle: "Zoom was never joined.",
        body: todayList,
      }),
    ].map((card) => `<tr><td style="padding-top:6px;"></td></tr>${card}`),
    footer: FOOTER,
  });

  return { subject, html };
}

// matched/unmatched/excluded are the same arrays mark-attendance.mjs already
// builds during matching -- this just renders them, no new matching logic.
export function buildRunEmail({ apply, subjectCode, tabTitle, sessionNumber, participants, matched, unmatched, excluded, written, alreadyMarkedCount, subjectDetection, scheduleSlot, joinedByUs }) {
  const subject = `Attendance: ${apply ? "marked" : "dry-run"} ${subjectCode} S${sessionNumber} (${written} written)`;

  const headline = `${subjectCode} · Session ${sessionNumber}${apply ? "" : " (dry run)"}`;
  const subheadline = `${tabTitle} · ${participants.length} participant(s) seen`;

  const statsCard = renderCard({
    accentColor: matched.length === participants.length - excluded.length ? "#34a853" : "#fbbc04",
    title: `${matched.length}/${participants.length} matched`,
    subtitle: `Detection: ${subjectDetection}${scheduleSlot ? ` (${scheduleSlot.label}, "${scheduleSlot.rawCell}")` : ""} · joined Zoom: ${joinedByUs ? "yes" : "no"}`,
    body: `<div style="margin-top:10px;">${[
      statPill("written", written, "#188038"),
      statPill("already marked", alreadyMarkedCount),
      statPill("excluded (non-student)", excluded.length),
      unmatched.length > 0 ? statPill("unmatched", unmatched.length, "#c5221f") : "",
    ].join("")}</div>`,
  });

  const unmatchedSection = renderSection("Needs review -- not matched", "#c5221f", unmatched, (u) =>
    renderCard({
      accentColor: "#ea4335",
      title: escapeHtml(u.participant),
      subtitle: u.reason,
    })
  );

  // Given its own uppercase badge header (like "NEEDS REVIEW" above it),
  // not just a plain card -- a bare card here used to sit directly under
  // the unmatched section with no header/spacing of its own, making it
  // read as if it were part of "Needs review" rather than a separate,
  // unrelated section.
  const matchedCard =
    matched.length > 0
      ? `
    <tr><td style="padding:22px 0 8px 2px;">
      <span style="font-size:11px; font-weight:700; letter-spacing:0.04em; text-transform:uppercase; color:#188038;">Matched</span>
      <span style="font-size:11px; color:#9aa0a6; margin-left:6px;">${matched.length}</span>
    </td></tr>
    ${renderCard({
      accentColor: "#34a853",
      title: "Zoom name → roster match",
      body: renderMatchedTable(matched),
    })}`
      : "";

  const html = shell({
    headline: escapeHtml(headline),
    subheadline: escapeHtml(subheadline),
    sections: [statsCard, unmatchedSection, matchedCard],
    footer: FOOTER,
  });

  return { subject, html };
}

export function buildFailedEmail({ message }) {
  const subject = "Attendance: scheduled run FAILED";
  const html = shell({
    headline: "Run failed",
    subheadline: "Nothing further was attempted this run.",
    sections: [
      renderCard({
        accentColor: "#ea4335",
        title: "Error",
        body: codeBlock(message),
      }),
      renderCard({
        accentColor: "#9aa0a6",
        title: "To investigate",
        body: codeBlock("node mark-attendance.mjs"),
      }),
    ],
    footer: FOOTER,
  });
  return { subject, html };
}
