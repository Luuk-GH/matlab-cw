// Writes dist/README.vsix.md, the README packaged in the .vsix: README.md without its local images.
// The Extensions page in VS Code only shows images from https URLs (relative paths and data URLs show as broken
// images), and there is no public repository yet for vsce to rewrite relative links to. Once there is one, add
// "repository" to package.json and package README.md directly: vsce then rewrites media/... to https URLs.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const md = fs.readFileSync(path.join(root, 'README.md'), 'utf8')
  .replace(/^!\[[^\]]*\]\((?!https:)[^)]*\)\r?\n\r?\n?/gm, '');
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist', 'README.vsix.md'), md);
