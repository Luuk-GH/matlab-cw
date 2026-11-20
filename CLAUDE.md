# MATLAB Command Window (community) — VS Code extension
ONLY a better Command Window (webview) for the official MathWorks MATLAB extension. The user uses MathWorks' extension
and MATLAB Agentic Toolkit for everything else: do not add Run commands, Workspace views, MCP servers or debuggers.
It ATTACHES to the MATLAB the official extension runs (no second MATLAB): user runs shareMATLABSession() (MCP Server
Toolbox) -> sessionDetails.json {port, certificate, apiKey, pid}; we start our own instance of the official extension's
language server with --matlabUrl through src/backend/connectorProxy.ts (adds mwapikey, trusts the cert). See RESEARCH.md §8.
NO MATLAB ON THE DEV PC: never claim something works with MATLAB; tests use test/fake/fakeLanguageServer.js + fakeConnector.js.
Everything unverified goes in TESTING-WITH-MATLAB.md; spike in spike/ (spike.ts -> matlab-spike.js via npm run spike:build).
Ported from ~/Projects/octave-extension (do not make that project depend on this one).
Commands: npm install; npm run compile; npm run package; npm run test:unit; npm run test:fake; npm run test:integration; npm run test:vsix.
Nothing is added to the user's MATLAB path: help/completion use MATLAB's own help, which, who and the LS completion.
