# MATLAB Command Window — VS Code extension
ONLY a better Command Window (webview) for the official MathWorks MATLAB extension. The user uses MathWorks' extension
and MATLAB Agentic Toolkit for everything else: do not add Workspace views, MCP servers or debuggers. Exception (user's
request): Run File/Section/Selection in the Command Window (src/runInCommandWindow.ts) on F5/Ctrl+Enter/Shift+Enter,
because the official Run always uses and focuses its terminal (no setting for that). Likewise src/keepInFront.ts brings the Command Window back
when the official extension shows its MATLAB terminal at a breakpoint or on input().
It ATTACHES to the MATLAB the official extension runs (no second MATLAB): user runs shareMATLABSession() (MCP Server
Toolbox) -> sessionDetails.json {port, certificate, apiKey, pid}; we start our own instance of the official extension's
language server with --matlabUrl through src/backend/connectorProxy.ts (adds mwapikey, trusts the cert). See RESEARCH.md §8.
MATLAB R2026b is now installed on the dev PC (trial). The spike (node spike/matlab-spike.js --no-manual) passes against
the MATLAB the official extension runs; automated tests still use test/fake/fakeLanguageServer.js + fakeConnector.js.
Only claim what the spike or a real run showed. Attach mode runs the server via src/backend/lsLoader.ts (in-memory fix).
Everything unverified goes in TESTING-WITH-MATLAB.md; spike in spike/ (spike.ts -> matlab-spike.js via npm run spike:build).
Ported from ~/Projects/octave-extension (do not make that project depend on this one).
Commands: npm install; npm run compile; npm run package; npm run test:unit; npm run test:fake; npm run test:integration; npm run test:vsix;
npm run test:real (integration tests on the real shared MATLAB; restores its folder, never leaves it at K>>);
npm run demo:screenshots (docs/screenshots/). ALWAYS also test with the real MATLAB (user's instruction).
Nothing is added to the user's MATLAB path: help/completion use MATLAB's own help, which, who and the LS completion
(file/folder names and signature help from matlabls.internal.getCompletions).
Only the MATLAB started by THIS window's MATLAB extension is connected (session.ts notOurs, sharedSession.ts
ownership); the test launchers set MCW_ANY_MATLAB=1 to skip that check. Use the user's screen (computer-use) only when
unavoidable; prefer tests and a browser harness of the webview.
