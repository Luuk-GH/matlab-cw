// Hover help in MATLAB editors (the user's request): MathWorks' language server gives signature help while typing but
// no hover, so a name in a .m file shows its usage and description from the connected MATLAB's own help and which(),
// as in the Command Window: no network and no second MATLAB. Only while connected and MATLAB is idle or at K>>;
// otherwise nothing is shown (answers are cached per name, so later hovers work while MATLAB is busy).
import * as vscode from 'vscode';
import { OPEN_DOC_COMMAND } from './docLink';
import { HelpInfo } from './language/helpText';
import { hoverName } from './language/matlabSyntax';
import { SessionManager } from './session';

/** Escape Markdown by hand: appendText turns every space into &nbsp;, so long descriptions would not wrap. */
const esc = (s: string) => s.replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, '\\$&');

/** The hover's Markdown: usage forms as MATLAB code, the description, links to the documentation and the file. */
export function hoverMarkdown(name: string, info: HelpInfo): vscode.MarkdownString | undefined {
  if (!info.signatures.length && !info.doc) { return undefined; }
  const md = new vscode.MarkdownString();
  md.isTrusted = { enabledCommands: [OPEN_DOC_COMMAND] };   // only the Documentation link's command
  if (info.signatures.length) { md.appendCodeblock(info.signatures.slice(0, 8).join('\n'), 'matlab'); }
  if (info.doc) { md.appendMarkdown(esc(info.doc.length > 600 ? info.doc.slice(0, 597) + '…' : info.doc)); }
  const links: string[] = [];
  if (info.docUrl) {
    const args = encodeURIComponent(JSON.stringify([info.docUrl, name]));
    links.push(`[Documentation](command:${OPEN_DOC_COMMAND}?${args} "${info.docUrl}")`);
  }
  if (info.file) { links.push(`[${esc(info.file.split(/[\\/]/).pop()!)}](${vscode.Uri.file(info.file).toString()})`); }
  if (links.length) { md.appendMarkdown(`\n\n${links.join(' · ')}`); }
  return md;
}

export function registerEditorHover(session: SessionManager): vscode.Disposable {
  return vscode.languages.registerHoverProvider({ language: 'matlab' }, {
    async provideHover(doc, pos, token) {
      if (!vscode.workspace.getConfiguration('matlabCommandWindow').get<boolean>('editorHover', true)) { return undefined; }
      const at = hoverName(doc.lineAt(pos.line).text, pos.character);
      if (!at) { return undefined; }
      const info = await session.helpFor(at.name);
      if (!info || token.isCancellationRequested) { return undefined; }
      const md = hoverMarkdown(at.name, info);
      return md && new vscode.Hover(md, new vscode.Range(pos.line, at.start, pos.line, at.end));
    },
  });
}
