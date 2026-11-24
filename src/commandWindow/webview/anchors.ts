// MATLAB prints hyperlinks as HTML when "hotlinks" are on, e.g. in error stacks:
//   Error in <a href="matlab:matlab.lang.internal.introspective.errorDocCallback('f', 'C:\x\f.m', 12)" style="font-weight:bold">f</a> (<a href="matlab: opentoline('C:\x\f.m',12,0)">line 12</a>)
// Whether text from the language server contains them is not known yet (spike check S9), so both forms are handled:
// anchors become their plain label, and the ones that point at a file become link hits. Pure; unit-tested.

export interface LinkHit { file?: string; func?: string; line?: number; start: number; end: number; }

const ANCHOR = /<a\s+href\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
const TAGS = /<\/?(?:strong|b)>/g;

/** Remove MATLAB's HTML anchors (and <strong>) from `text`; return the plain text and links for file anchors. */
export function parseAnchors(text: string): { text: string; links: LinkHit[] } {
  if (!text.includes('<')) { return { text, links: [] }; }
  const links: LinkHit[] = [];
  let out = '';
  let pos = 0;
  ANCHOR.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ANCHOR.exec(text))) {
    out += stripTags(text.slice(pos, m.index));
    const label = stripTags(m[2]);
    const target = linkTarget(decodeEntities(m[1]));
    if (target && label) { links.push({ ...target, start: out.length, end: out.length + label.length }); }
    out += label;
    pos = m.index + m[0].length;
  }
  out += stripTags(text.slice(pos));
  return { text: out, links };
}

function stripTags(s: string): string { return s.replace(TAGS, ''); }

function decodeEntities(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** MATLAB string literals in a matlab: URL ('it''s' or "x"). */
function args(call: string): string[] {
  const out: string[] = [];
  const re = /'((?:[^']|'')*)'|"((?:[^"]|"")*)"|(-?\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(call))) {
    out.push(m[1] !== undefined ? m[1].replace(/''/g, "'") : m[2] !== undefined ? m[2].replace(/""/g, '"') : m[3]);
  }
  return out;
}

export function linkTarget(href: string): Omit<LinkHit, 'start' | 'end'> | undefined {
  const h = href.replace(/^matlab:\s*/, '');
  let m = /^opentoline\s*\(([\s\S]*)\)\s*;?$/.exec(h) ?? /^matlab\.desktop\.editor\.openAndGoToLine\s*\(([\s\S]*)\)\s*;?$/.exec(h);
  if (m) {
    const [file, line] = args(m[1]);
    return file ? { file, line: line ? Number(line) : undefined } : undefined;
  }
  m = /errorDocCallback\s*\(([\s\S]*)\)\s*;?$/.exec(h);
  if (m) {
    const [func, file, line] = args(m[1]);
    if (file) { return { file, line: line ? Number(line) : undefined }; }
    return func ? { func } : undefined;
  }
  m = /^(?:edit|open)\s*\(([\s\S]*)\)\s*;?$/.exec(h);
  if (m) {
    const [file] = args(m[1]);
    return file && /[\\/]/.test(file) ? { file } : file ? { func: file } : undefined;
  }
  return undefined;
}

/** run() (Run File runs scripts with it) and the extension's own helpers: frames that are noise for the user. */
const HELPER = String.raw`(?:run|mcw\.\w+) \(line \d+\)`;
// [verified, R2026b] an error frame is followed by its code line and a ^^^ line: hide those too (never a next frame).
const ERROR_FRAME = new RegExp(String.raw`^Error in ${HELPER}(?:\n|$)(?:(?!Error in |Error using |[ \t]*(?:> )?In )[^\n]*\n(?:[ \t]*\^+[ \t]*(?:\n|$))?)?`, 'gm');
// A warning's backtrace: "> In f (line 3)" for the first frame, "  In g (line 9)" for the next ones (no code lines).
const WARNING_FRAME = new RegExp(String.raw`^[ \t]*(?:> )?In ${HELPER}[ \t]*(?:\n|$)`, 'gm');

/** Remove the stack frames of run() and of the extension's helpers from error output (text with \n line ends). */
export function hideHelperFrames(text: string): string {
  return text.replace(ERROR_FRAME, '').replace(WARNING_FRAME, '');
}
