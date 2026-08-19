// Reads/writes the actual attendance Google Sheet (native, editable) -- one
// tab per subject code, students as rows, one "Session N" column per class
// occurrence. Tab discovery is dynamic (by title prefix) rather than a
// hardcoded list in config, so a new term's tab names/splits don't need a
// code change -- only whatever's already true of config.json's
// subjectCodeMap.

function columnLetter(index) {
  // 0-based column index -> A1 letter(s).
  let n = index + 1;
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export async function listSubjectTabs(sheets, spreadsheetId, subjectCodes) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const titles = meta.data.sheets.map((s) => s.properties.title);

  const tabsBySubject = {};
  for (const code of subjectCodes) tabsBySubject[code] = [];
  for (const title of titles) {
    // Longest-prefix match guards against a hypothetical "DSM 1010" tab
    // being mis-grouped under "DSM 101" -- not a real case in this sheet
    // today, but cheap to get right.
    const match = subjectCodes
      .filter((code) => title.toUpperCase().startsWith(code.toUpperCase()))
      .sort((a, b) => b.length - a.length)[0];
    if (match) tabsBySubject[match].push(title);
  }
  return tabsBySubject;
}

// Loads one tab's full grid and locates the roster columns + all "Session N"
// columns from row 1 headers, by name rather than fixed index -- resilient
// to the sheet gaining/losing columns.
export async function loadTab(sheets, spreadsheetId, tabTitle, columnsConfig) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${tabTitle}'!A1:ZZ2000`,
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const rows = res.data.values ?? [];
  const header = rows[0] ?? [];

  const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
  const nameCol = header.findIndex((h) => norm(h) === norm(columnsConfig.name));
  const rollCol = header.findIndex((h) => norm(h) === norm(columnsConfig.rollNumber));
  if (nameCol === -1 || rollCol === -1) {
    throw new Error(`Tab "${tabTitle}": could not find "${columnsConfig.name}" / "${columnsConfig.rollNumber}" columns in header row: ${JSON.stringify(header)}`);
  }

  const sessionCols = [];
  header.forEach((h, idx) => {
    const s = String(h ?? "");
    if (s.startsWith(columnsConfig.sessionPrefix)) {
      const n = parseInt(s.slice(columnsConfig.sessionPrefix.length), 10);
      if (!Number.isNaN(n)) sessionCols.push({ index: idx, sessionNumber: n });
    }
  });
  sessionCols.sort((a, b) => a.sessionNumber - b.sessionNumber);

  const students = rows.slice(1).map((row, i) => ({
    rowIndex: i + 1, // 0-based within `rows` (header is row 0)
    name: String(row[nameCol] ?? "").trim(),
    rollNumber: String(row[rollCol] ?? "").trim(),
    values: row,
  })).filter((s) => s.name || s.rollNumber);

  return { tabTitle, header, nameCol, rollCol, sessionCols, students };
}

// A subject can have multiple tabs that are NOT independent rosters but a
// single roster split by session-number range (e.g. DSM 101's
// "(1 to 20)"/"(21 to 40)" tabs both list the same 34 students, just with
// different "Session N" column windows -- confirmed by inspecting real
// data, not assumed from the tab names, which read like a roll-number split
// and would be easy to mis-guess). Picks whichever tab actually has the
// given session number's column and returns that exact column.
//
// sessionNumber is always the schedule's own count of how many times this
// subject has met up to today (see countSessionOccurrences in
// lib/schedule.mjs), or an explicit --session override -- never inferred
// from which columns in the sheet happen to look full/empty/partial. An
// earlier version tried to infer it that way (a column with some rows
// filled and some blank = "today, in progress"), which has a real failure
// mode: a past session with one genuine permanent absentee is
// indistinguishable, from cell contents alone, from a column someone just
// started filling in. The schedule doesn't have that ambiguity.
export function pickActiveTab(tabs, sessionNumber) {
  const owner = tabs.find((t) => t.sessionCols.some((c) => c.sessionNumber === sessionNumber));
  if (!owner) {
    throw new Error(`No tab has a "Session ${sessionNumber}" column (checked: ${tabs.map((t) => t.tabTitle).join(", ")}).`);
  }
  const targetCol = owner.sessionCols.find((c) => c.sessionNumber === sessionNumber);
  return { tab: owner, targetCol };
}

// Writes "Present" into the target column for the given student row indices,
// skipping any that already have a non-blank value there (idempotent -- safe
// to re-run, never overwrites an existing mark).
export async function writePresent(sheets, spreadsheetId, tab, targetCol, rowIndicesToMark, presentValue) {
  const data = rowIndicesToMark
    .filter((rowIndex) => !String(tab.students.find((s) => s.rowIndex === rowIndex).values[targetCol.index] ?? "").trim())
    .map((rowIndex) => ({
      range: `'${tab.tabTitle}'!${columnLetter(targetCol.index)}${rowIndex + 1}`,
      values: [[presentValue]],
    }));

  if (data.length === 0) return { written: 0 };

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: { valueInputOption: "RAW", data },
  });
  return { written: data.length };
}

export { columnLetter };
