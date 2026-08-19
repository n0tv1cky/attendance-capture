// Reads the term's daily timetable + course-code legend from the schedule
// .xlsx (a raw Office file on Drive, view-only for us -- so this goes
// through Drive's files.get(alt=media) + the `xlsx` package, never the
// Sheets API, which flatly refuses to touch non-native files).

import XLSX from "xlsx";

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

function parseSheetDate(raw) {
  // Sheet dates are strings like "14-Aug-26" -- not Sheets serial numbers,
  // since this is a raw xlsx read with the `xlsx` package (raw: false gives
  // us the displayed string, which is what's reliably parseable here).
  const m = String(raw ?? "").trim().match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2})$/);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const month = MONTHS[m[2].toLowerCase()];
  if (month === undefined) return null;
  const year = 2000 + parseInt(m[3], 10);
  return new Date(year, month, day);
}

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function isNonClassCell(cell, nonClassMarkers) {
  const s = String(cell ?? "").trim().toLowerCase();
  if (!s) return true;
  return nonClassMarkers.some((marker) => s.includes(marker));
}

// Resolves a raw timetable cell (e.g. "DSM 101 (2)", "ME-1 (KN)", "SM3",
// "MC 1", "ME 11 (DS)") down to just the canonical subject code, ignoring
// session numbers and trailing faculty-initial parens -- the schedule cell
// formats are inconsistent about *where* the session number sits (in parens
// for some subjects, glued to the abbreviation for others), but the leading
// subject token is always first, so that's the only part we rely on. The
// actual session number for attendance purposes comes from the attendance
// sheet's own column state instead (see attendanceSheet.mjs), not from
// parsing this text -- far more robust than trusting the inconsistent
// timetable formatting to also be complete/error-free.
export function resolveSubjectCode(rawCell, subjectCodeMap, nonClassMarkers) {
  const cell = String(rawCell ?? "").trim();
  if (isNonClassCell(cell, nonClassMarkers)) return null;

  let m = cell.match(/^DSM\s*(\d{3})/i);
  if (m) return `DSM ${m[1]}`;

  m = cell.match(/^([A-Za-z]+)/);
  if (!m) return null;
  const abbrev = m[1].toUpperCase();
  return subjectCodeMap[abbrev] ?? null;
}

export async function fetchScheduleWorkbook(drive, fileId) {
  const res = await drive.files.get({ fileId, alt: "media" }, { responseType: "arraybuffer" });
  return XLSX.read(Buffer.from(res.data), { type: "buffer" });
}

// Returns { rows } where each row is the raw array-of-cells for the header
// row and every data row of the timetable sheet (before the legend table).
export function parseTimetable(workbook, sheetName, legendMarker) {
  const ws = workbook.Sheets[sheetName];
  if (!ws) throw new Error(`Schedule workbook has no sheet named "${sheetName}" (found: ${workbook.SheetNames.join(", ")})`);
  const allRows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "" });
  const legendIdx = allRows.findIndex((r) => String(r[0] ?? "").trim() === legendMarker);
  return legendIdx === -1 ? allRows : allRows.slice(0, legendIdx);
}

// Parses the course legend table (Course Code / Title / Instructor /
// Abbreviation / ...) into { [abbreviation]: canonicalCode }, as a
// cross-check against config.json's hand-maintained subjectCodeMap -- this
// is the actual source the config was originally transcribed from.
export function parseLegend(workbook, sheetName, legendMarker) {
  const ws = workbook.Sheets[sheetName];
  const allRows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "" });
  const legendIdx = allRows.findIndex((r) => String(r[0] ?? "").trim() === legendMarker);
  if (legendIdx === -1) return {};
  const header = allRows[legendIdx];
  const codeCol = header.indexOf("Course Code");
  const abbrevCol = header.indexOf("Abbreviation");
  const map = {};
  for (const row of allRows.slice(legendIdx + 1)) {
    const code = String(row[codeCol] ?? "").trim();
    const abbrev = String(row[abbrevCol] ?? "").trim().toUpperCase();
    if (code && abbrev) map[abbrev] = code;
  }
  return map;
}

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

// Finds "the class we just finished / are in" right now, tiered by
// confidence rather than one flat time window:
//   tier "live"    -- now falls inside [slot.start - liveBufferMinutes,
//                      slot.end + liveBufferMinutes] -- the slot is
//                      actually happening (or just wrapped up a few
//                      minutes late).
//   tier "recent"  -- now is past a slot's live window but within
//                      graceMinutes of its end -- "ran this a while after
//                      class ended" fallback.
// A single "live" candidate wins outright over any "recent" ones, since
// back-to-back slots on the same day are sequential and non-overlapping --
// e.g. at 20:35 with Session-I 19:00-20:00 and Session-II 20:15-21:15,
// Session-II is squarely live while Session-I only qualifies as "recent";
// without this split both would tie inside one flat 3-hour grace window and
// force an unnecessary manual pick every time. Ambiguity is only reported
// when two slots land in the same tier at once.
export function findCandidateSessions(timetableRows, config, now = new Date()) {
  const dateColIdx = 0; // "Date" is always column A in this timetable
  const dataRows = timetableRows.slice(1);

  const todayRow = dataRows.find((row) => {
    const d = parseSheetDate(row[dateColIdx]);
    return d && sameDay(d, now);
  });
  if (!todayRow) return { todayRow: null, candidates: [], allToday: [] };

  const dayName = now.toLocaleDateString("en-US", { weekday: "long" });
  const isWeekend = dayName === "Saturday" || dayName === "Sunday";
  const slots = isWeekend ? config.timeSlots.weekend : config.timeSlots.weekday;

  const nowMin = now.getHours() * 60 + now.getMinutes();
  const liveBuffer = config.liveBufferMinutes ?? 15;
  const grace = config.slotGraceMinutes ?? 180;

  const allToday = [];
  const live = [];
  const recent = [];
  for (const slot of slots) {
    const rawCell = todayRow[slot.column];
    const subjectCode = resolveSubjectCode(rawCell, config.subjectCodeMap, config.nonClassMarkers);
    if (!subjectCode) continue;
    const entry = { slot, rawCell: String(rawCell).trim(), subjectCode };
    allToday.push(entry);

    const startMin = toMinutes(slot.start) - liveBuffer;
    const liveEndMin = toMinutes(slot.end) + liveBuffer;
    const graceEndMin = toMinutes(slot.end) + grace;

    if (nowMin >= startMin && nowMin <= liveEndMin) live.push(entry);
    else if (nowMin > liveEndMin && nowMin <= graceEndMin) recent.push(entry);
  }

  const candidates = live.length > 0 ? live : recent;
  return { todayRow, candidates, allToday, tier: live.length > 0 ? "live" : "recent" };
}
