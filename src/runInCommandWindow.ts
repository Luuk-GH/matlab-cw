// Run File / Run Section / Run Selection in the Command Window instead of the official extension's terminal.
// The official MATLAB extension has no setting for where its Run commands go (they always use and focus its terminal),
// so these commands are bound to the same keys (F5, Ctrl+Enter, Shift+Enter) for .m files while
// matlabCommandWindow.runInCommandWindow is on (package.json). The editor keeps the focus.
import * as path from 'path';
import * as vscode from 'vscode';
import { onlyComments, sectionAt } from './language/sections';
import { SessionManager } from './session';
import { matlabString } from './sessionText';

function matlabEditor(): vscode.TextEditor | undefined {
  const e = vscode.window.activeTextEditor;
  if (!e || e.document.languageId !== 'matlab') {
    void vscode.window.showInformationMessage('MATLAB Command Window: open a MATLAB (.m) file first.');
    return undefined;
  }
  return e;
}

export async function runFile(session: SessionManager): Promise<void> {
  const e = matlabEditor();
  if (!e) { return; }
  const doc = e.document;
  session.reveal(true);
  if (doc.isUntitled) {
    // Nothing to run() yet: run the text, like typing it.
    await session.execute(doc.getText(), `% ${doc.fileName}`);
    return;
  }
  if (doc.isDirty && !(await doc.save())) { return; }
  // run() changes to the file's folder for the run and back, so scripts and functions off the path work too.
  // The window shows just the script name, like typing it (the user's request).
  await session.execute(`run(${matlabString(doc.uri.fsPath)})`, path.basename(doc.fileName, path.extname(doc.fileName)));
}

export async function runSection(session: SessionManager): Promise<void> {
  const e = matlabEditor();
  if (!e) { return; }
  const lines = e.document.getText().split(/\r?\n/);
  const sec = sectionAt(lines, e.selection.active.line);
  const code = lines.slice(sec.start, sec.end + 1).join('\n');
  if (onlyComments(code)) { return; }
  session.reveal(true);
  const name = path.basename(e.document.fileName);
  const label = sec.title ? `"${sec.title}"` : `lines ${sec.start + 1}–${sec.end + 1}`;
  await session.execute(code, `% ${name}: section ${label}`);
}

export async function runSelection(session: SessionManager): Promise<void> {
  const e = matlabEditor();
  if (!e) { return; }
  const code = e.selections.length === 1 && !e.selection.isEmpty
    ? e.document.getText(e.selection)
    : e.document.lineAt(e.selection.active.line).text;   // no selection: the current line
  if (onlyComments(code)) { return; }
  session.reveal(true);
  session.addHistory(code);   // like MATLAB's Evaluate Selection: the Command History pop-up and Up find it
  await session.execute(code);
}
