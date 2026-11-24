// "Documentation" links of the help tooltip (Command Window) and the editor hover. The hover shows an address derived
// from which() (help/<product>/ref/<name>.html), right for most functions but not all: linspace's page is
// double.linspace.html [verified 2026-11-24]. So a click asks the connected MATLAB for the page its own `doc` would
// open (matlab.internal.doc.reference.getReferencePage, as doc.m does; internal, so it may change between releases)
// and opens that web address; when MATLAB is busy or the call fails, the derived address opens.
import * as vscode from 'vscode';
import { SessionManager } from './session';

export const OPEN_DOC_COMMAND = 'matlabCommandWindow.openDoc';
const DOC_PREFIX = 'https://www.mathworks.com/help/';

/** MATLAB code that prints the web address of `name`'s reference page (nothing when there is none). */
export function docPageQuery(name: string): string | undefined {
  if (!/^[A-Za-z]\w*$/.test(name)) { return undefined; }
  return `p = matlab.internal.doc.reference.getReferencePage(matlab.internal.doc.reference.ReferenceTopicInput({'${name}'}, whos('mcwNoSuchVariable')));`
    + ` if ~isempty(p), disp(string(p(1).toDocLocation(matlab.internal.doc.services.DocLocation.WEB).getUrl())); end`;
}

/** The first MathWorks documentation address in MATLAB's output. */
export function docPageFromOutput(text: string | undefined): string | undefined {
  const m = /https:\/\/www\.mathworks\.com\/help\/\S+/.exec(text ?? '');
  return m?.[0];
}

export async function openDoc(session: SessionManager, url: string, name: string): Promise<void> {
  if (typeof url !== 'string' || !url.startsWith(DOC_PREFIX)) { return; }   // only MathWorks' documentation
  const q = docPageQuery(String(name));
  const exact = q ? docPageFromOutput(await session.queryText('evalc', [q], true, 5000)) : undefined;
  await vscode.env.openExternal(vscode.Uri.parse(exact ?? url));
}

export function registerOpenDoc(session: SessionManager): vscode.Disposable {
  return vscode.commands.registerCommand(OPEN_DOC_COMMAND, (url: string, name: string) => openDoc(session, url, name));
}
