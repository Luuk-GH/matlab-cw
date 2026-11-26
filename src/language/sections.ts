// MATLAB code sections ("cells"): a line starting with %% (after optional whitespace, followed by a space or the end
// of the line) starts a section that runs until the line before the next one. No VS Code dependency; unit-tested.

export interface Section {
  /** First line (0-based, the %% line itself when there is one). */
  start: number;
  /** Last line (0-based, inclusive). */
  end: number;
  /** The text after %% on the header line, or '' (no header, or an untitled one). */
  title: string;
}

const HEADER = /^\s*%%(?:\s+(.*?))?\s*$/;

/** Whether a line starts a section. `%%{` (a block comment) and `%%%` are not section headers. */
export function isSectionHeader(line: string): boolean {
  return HEADER.test(line);
}

/** The section containing `line`. Without any %% lines this is the whole file. */
export function sectionAt(lines: string[], line: number): Section {
  const at = Math.max(0, Math.min(line, lines.length - 1));
  let start = 0;
  for (let i = at; i >= 0; i--) { if (isSectionHeader(lines[i])) { start = i; break; } }
  let end = lines.length - 1;
  for (let i = at + 1; i < lines.length; i++) { if (isSectionHeader(lines[i])) { end = i - 1; break; } }
  const m = HEADER.exec(lines[start] ?? '');
  return { start, end, title: m ? (m[1] ?? '') : '' };
}

/** The first line of the next section (Ctrl+Down), or undefined in the last section. */
export function nextSectionStart(lines: string[], line: number): number | undefined {
  const sec = sectionAt(lines, line);
  return sec.end + 1 < lines.length ? sec.end + 1 : undefined;
}

/** The first line of the previous section (Ctrl+Up), or undefined in the first section. */
export function previousSectionStart(lines: string[], line: number): number | undefined {
  const sec = sectionAt(lines, line);
  return sec.start > 0 ? sectionAt(lines, sec.start - 1).start : undefined;
}

/** True when the code has nothing to run (only blank lines and % comments). */
export function onlyComments(code: string): boolean {
  return code.split(/\r?\n/).every(l => /^\s*(%.*)?$/.test(l));
}
