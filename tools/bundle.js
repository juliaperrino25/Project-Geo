#!/usr/bin/env node
/*
 * Builds dist/play.html: the whole game as one self-contained page.
 *
 * Everything (CSS, the three scripts, the map data and the historical notes)
 * is inlined, so the file can be opened from disk, emailed, or hosted anywhere
 * without the rest of the repo. Used to publish the playable link.
 *
 * Usage: node tools/bundle.js [--full]
 *   --full  emit a complete <!doctype html> document (default emits a fragment
 *           with <title>, <style>, markup and <script>, for hosts that supply
 *           their own document skeleton).
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// A closing script tag inside inlined JS would end the block early. None of the
// current sources contain one, but guard anyway so future data can't break out.
const safe = (js) => js.split('</script').join('<\\/script');

const html = read('index.html');
const body = html.match(/<body[^>]*>([\s\S]*?)<\/body>/)[1];
const markup = body
  .replace(/<script\b[\s\S]*?<\/script>/g, '')   // scripts are inlined below
  .trim();

let css = read('css/style.css');

// The published page inherits the viewer's theme, which has three states:
// an explicit light/dark stamp on <html>, or nothing at all (system default).
// The stylesheet defines the full light palette on bare :root and overrides
// tokens under prefers-color-scheme. Guard that override so an explicit light
// choice beats a dark OS, and repeat it for an explicit dark choice.
const darkBlock = css.match(/@media \(prefers-color-scheme: dark\) \{\s*:root \{([\s\S]*?)\n {2}\}/);
if (!darkBlock) throw new Error('could not find the dark-theme token block in css/style.css');
css = css.replace(
  '@media (prefers-color-scheme: dark) {\n  :root {',
  '@media (prefers-color-scheme: dark) {\n  :root:not([data-theme="light"]) {'
);
css += `

/* Explicit dark choice wins over a light OS (same tokens as the media query). */
:root[data-theme="dark"] {${darkBlock[1]}
}

/* The host paints its own ground behind the page, so state the background. */
html, body { background: var(--page-bg); }
`;

const scripts = [
  'data/world1940.js',
  'data/notes1940.js',
  'js/map.js',
  'js/game.js',
  'js/app.js',
].map((f) => `<script>\n${safe(read(f))}\n</script>`).join('\n');

// Keep head and body content as separate pieces. (Splitting a joined string
// back apart is not safe here: the CSS contains blank lines of its own.)
const head = `<title>World 1940 Map Quiz</title>\n\n<style>\n${css}\n</style>`;
const bodyOut = `${markup}\n\n${scripts}`;

const full = process.argv.includes('--full');
const out = full
  ? '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    `${head}\n</head>\n<body>\n${bodyOut}\n</body>\n</html>\n`
  : `${head}\n\n${bodyOut}\n`;

fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
const dest = path.join(ROOT, 'dist', 'play.html');
fs.writeFileSync(dest, out);
console.log(`wrote dist/play.html — ${(out.length / 1024).toFixed(0)} KB, ` +
  `${full ? 'full document' : 'fragment'}`);
