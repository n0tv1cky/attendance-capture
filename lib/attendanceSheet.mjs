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
// and would be easy to mis-guess). Picks the one tab that's actually
// "active" right now (has a partially-filled column, or failing that the
// first fully-blank column), trying tabs in ascending session-number order.
// Returns null if every tab's every known Session column is already full.
export function pickActiveTab(tabs, explicitSessionNumber) {
  const ordered = [...tabs].sort((a, b) => (a.sessionCols[0]?.sessionNumber ?? Infinity) - (b.sessionCols[0]?.sessionNumber ?? Infinity));

  if (explicitSessionNumber != null) {
    const owner = ordered.find((t) => t.sessionCols.some((c) => c.sessionNumber === explicitSessionNumber));
    if (!owner) throw new Error(`No tab has a "Session ${explicitSessionNumber}" column (checked: ${ordered.map((t) => t.tabTitle).join(", ")}).`);
    return { tab: owner, targetCol: pickTargetSessionColumn(owner, explicitSessionNumber) };
  }

  for (const tab of ordered) {
    const targetCol = pickTargetSessionColumn(tab, null);
    if (targetCol) return { tab, targetCol };
  }
  return null;
}

// Picks which "Session N" column to write into for this run:
// - if a partially-filled column exists (some rows Present, some blank),
//   that's treated as today's in-progress session -- re-running the script
//   later the same session tops it up instead of creating a new column.
// - otherwise, the first fully-blank column is the next new session.
// Returns null if every known Session column is already fully filled (sheet
// needs a new column added by hand before this can proceed).
export function pickTargetSessionColumn(tab, explicitSessionNumber) {
  if (explicitSessionNumber != null) {
    const found = tab.sessionCols.find((c) => c.sessionNumber === explicitSessionNumber);
    if (!found) throw new Error(`Tab "${tab.tabTitle}" has no "Session ${explicitSessionNumber}" column.`);
    return found;
  }

  const filledCount = (col) => tab.students.filter((s) => String(s.values[col.index] ?? "").trim()).length;

  const partial = tab.sessionCols.find((col) => {
    const filled = filledCount(col);
    return filled > 0 && filled < tab.students.length;
  });
  if (partial) return partial;

  const blank = tab.sessionCols.find((col) => filledCount(col) === 0);
  return blank ?? null;
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
