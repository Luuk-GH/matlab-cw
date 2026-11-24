// Rows of the Command History pop-up (Up arrow, like MATLAB's): the commands that start with what is typed, oldest
// first, a command repeated right after itself shown once with a count ("2x"). Pure; unit-tested.

export interface HistoryRow { text: string; count: number; }

/** At most `max` rows (the newest); `prefix` is the text on the input line when the pop-up opens. */
export function historyRows(history: readonly string[], prefix: string, max = 500): HistoryRow[] {
  const rows: HistoryRow[] = [];
  let prev: string | undefined;
  for (const h of history) {
    const repeat = h === prev;
    prev = h;
    if (!h.trim() || !h.startsWith(prefix)) { continue; }
    const last = rows[rows.length - 1];
    if (repeat && last?.text === h) { last.count++; } else { rows.push({ text: h, count: 1 }); }
  }
  return rows.slice(-max);
}
