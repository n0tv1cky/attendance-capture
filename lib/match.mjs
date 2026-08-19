// Matches a cleaned Zoom display name against the roster's student rows.
// Correctness matters more than coverage here: a wrong match writes
// "Present" for the wrong student in a shared institute sheet, so anything
// below a confident threshold is reported as unmatched for a human to check
// by hand, rather than guessed.

// Verified against a real live-meeting participant list: many students
// suffix their Zoom display name with institute boilerplate ("... - MSDSM
// Batch 06", "... MSDSM 2026MSDSM0100282") that the roster's plain name
// never has. Left alone, that boilerplate dilutes token-overlap scoring
// enough to push genuine, unambiguous matches below threshold -- so it's
// stripped here rather than worked around with a lower threshold, which
// would also let real near-misses through.
const NOISE_TOKENS = new Set(["msdsm", "batch"]);

export function normalizeName(s) {
  const base = String(s ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return base
    .split(" ")
    .filter((t) => t && !NOISE_TOKENS.has(t) && !/^\d+$/.test(t))
    .join(" ");
}

export function extractRollNumber(s) {
  const m = String(s ?? "").match(/\b(\d{10})\b/);
  return m ? m[1] : null;
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[n];
}

function levenshteinSimilarity(a, b) {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

function tokenSetSimilarity(a, b) {
  const setA = new Set(a.split(" ").filter(Boolean));
  const setB = new Set(b.split(" ").filter(Boolean));
  if (setA.size === 0 || setB.size === 0) return 0;

  const [small, large] = setA.size <= setB.size ? [setA, setB] : [setB, setA];
  let overlap = 0;
  for (const t of small) if (large.has(t)) overlap++;

  if (overlap === small.size) {
    // Every token of the shorter name appears in the longer one, e.g.
    // "Jane" inside "Jane Doe", or a first+last name inside a
    // full name with a middle name added. Verified against real data as a
    // common, correct pattern (partial display names), not just a
    // hypothetical -- scored high but deliberately short of 1.0 so a
    // genuine ambiguity (two students both named "Jane") still trips the
    // ambiguity-margin check below against a second candidate.
    return 0.9 + 0.1 * (small.size / large.size);
  }
  return (2 * overlap) / (setA.size + setB.size);
}

function nameSimilarity(a, b) {
  // Blend word-overlap (robust to reordering, e.g. "Kumar Aditya" vs
  // "Aditya Kumar") with edit-distance (robust to a single typo/nickname
  // spelling) -- whichever signal is stronger wins.
  return Math.max(tokenSetSimilarity(a, b), levenshteinSimilarity(a, b));
}

// students: [{ name, rollNumber, ... }]
// Returns { method: "roll-number"|"exact-name"|"fuzzy", student, score } or
// { method: "unmatched", reason }.
export function matchParticipant(participant, students, { fuzzyThreshold, ambiguityMargin }) {
  const roll = extractRollNumber(participant.cleaned) ?? extractRollNumber(participant.raw);
  if (roll) {
    const byRoll = students.find((s) => s.rollNumber === roll);
    if (byRoll) return { method: "roll-number", student: byRoll, score: 1 };
  }

  const normParticipant = normalizeName(participant.cleaned);
  if (!normParticipant) return { method: "unmatched", reason: "empty name after cleaning" };

  const exact = students.find((s) => normalizeName(s.name) === normParticipant);
  if (exact) return { method: "exact-name", student: exact, score: 1 };

  const scored = students
    .map((s) => ({ student: s, score: nameSimilarity(normParticipant, normalizeName(s.name)) }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  const secondBest = scored[1];
  if (!best || best.score < fuzzyThreshold) {
    return { method: "unmatched", reason: `best guess "${best?.student.name ?? "n/a"}" scored ${best?.score.toFixed(2) ?? "0"}, below threshold ${fuzzyThreshold}` };
  }
  if (secondBest && best.score - secondBest.score < ambiguityMargin) {
    return { method: "unmatched", reason: `ambiguous between "${best.student.name}" (${best.score.toFixed(2)}) and "${secondBest.student.name}" (${secondBest.score.toFixed(2)})` };
  }
  return { method: "fuzzy", student: best.student, score: best.score };
}
