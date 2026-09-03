#!/usr/bin/env node
// test/e2e.js — Playwright end-to-end test for the World 1940 Map Quiz.
//
// Run with: node test/e2e.js   (wired to `npm run test:e2e`)
// Exit code 0 on success, 1 on any failure.
//
// Serves the repo root (or E2E_ROOT, for development against a scratch app)
// over plain HTTP, drives a headless Chromium through four scenarios, and
// writes screenshots to test/screenshots/ (git-ignored).
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const assert = require('assert');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ROOT = path.resolve(process.env.E2E_ROOT || path.join(__dirname, '..'));
const SCREENSHOT_DIR = path.join(__dirname, 'screenshots');
const VIEWPORT = { width: 1400, height: 900 };

// ---------------------------------------------------------------------------
// Playwright loader: try the local/global `playwright` module name first,
// then fall back to the absolute path of the global install.
// ---------------------------------------------------------------------------

function loadPlaywright() {
  try {
    return require('playwright');
  } catch (e1) {
    return require('/opt/node22/lib/node_modules/playwright');
  }
}

// ---------------------------------------------------------------------------
// Tiny static file server
// ---------------------------------------------------------------------------

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function startServer(root) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const urlPath = decodeURIComponent((req.url || '/').split('?')[0].split('#')[0]);
        const safePath = path.normalize(urlPath === '/' ? '/index.html' : urlPath);
        // Forbid path traversal: resolve against root and require it stays inside root.
        const filePath = path.join(root, safePath);
        const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
        if (filePath !== root && !filePath.startsWith(rootWithSep)) {
          res.writeHead(403, { 'Content-Type': 'text/plain' });
          res.end('Forbidden');
          return;
        }
        fs.readFile(filePath, (err, data) => {
          if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not found: ' + safePath);
            return;
          }
          const ext = path.extname(filePath).toLowerCase();
          res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
          res.end(data);
        });
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal error: ' + (e && e.message));
      }
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// ---------------------------------------------------------------------------
// Browser launch, with the documented executablePath fallback.
// ---------------------------------------------------------------------------

function resolveFallbackChromiumPath() {
  const base = '/opt/pw-browsers';
  if (!fs.existsSync(base)) return null;
  const entries = fs.readdirSync(base).filter((n) => n.startsWith('chromium'));
  for (const entry of entries) {
    const candidates = [
      path.join(base, entry, 'chrome-linux', 'chrome'),
      path.join(base, entry, 'chrome-linux', 'headless_shell'),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
  }
  return null;
}

async function launchChromium(chromium) {
  try {
    return await chromium.launch({ headless: true });
  } catch (e1) {
    const fallback = resolveFallbackChromiumPath();
    if (!fallback) throw e1;
    return await chromium.launch({ headless: true, executablePath: fallback });
  }
}

// ---------------------------------------------------------------------------
// Small helpers shared by the scenarios
// ---------------------------------------------------------------------------

function fmtPt(pt) {
  return pt ? `(${pt.x.toFixed(1)}, ${pt.y.toFixed(1)})` : 'null';
}

/**
 * Resolve a screen point for `id`'s label that is verified (via
 * document.elementFromPoint) to actually land on that entity's path. If the
 * naive point misses (e.g. a tiny territory whose label point is covered by
 * a neighbour at the current zoom level), zoom in on its bbox and retry.
 */
async function resolveClickPoint(page, id, maxAttempts) {
  maxAttempts = maxAttempts || 4;
  let lastPt = null;
  let lastFound = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const pt = await page.evaluate((id) => window.GeoApp.map.getLabelScreenPoint(id), id);
    if (!pt) throw new Error(`GeoApp.map.getLabelScreenPoint("${id}") returned null`);
    lastPt = pt;
    const found = await page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      return {
        matches: !!(el && el.getAttribute && el.getAttribute('data-id') !== null),
        id: el && el.getAttribute ? el.getAttribute('data-id') : null,
        tag: el ? el.tagName : null,
      };
    }, { x: pt.x, y: pt.y });
    lastFound = found;
    if (found.id === id) return pt;

    // Miss: zoom in on the entity's bbox and retry.
    const bbox = await page.evaluate((id) => {
      const ent = window.WORLD1940.entities.find((e) => e.id === id);
      return ent ? ent.bbox : null;
    }, id);
    if (!bbox) throw new Error(`entity "${id}" not found in WORLD1940.entities (for zoom fallback)`);
    await page.evaluate((bbox) => window.GeoApp.map.zoomToBBox(bbox, 0.5), bbox);
    await page.waitForTimeout(400);
  }
  throw new Error(
    `could not resolve a click point for "${id}" after ${maxAttempts} attempts; ` +
    `last point ${fmtPt(lastPt)} was over id=${lastFound && lastFound.id} tag=${lastFound && lastFound.tag}`
  );
}

/** Click the (verified) label point of `id` and wait for GeoApp.currentId() to change. */
async function clickCurrentAndAdvance(page, id, timeoutMs) {
  const pt = await resolveClickPoint(page, id);
  await page.mouse.click(pt.x, pt.y);
  try {
    await page.waitForFunction(
      (prevId) => window.GeoApp.currentId() !== prevId,
      id,
      { timeout: timeoutMs || 3000, polling: 30 }
    );
  } catch (e) {
    const diag = await page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      return { id: el && el.getAttribute ? el.getAttribute('data-id') : null, tag: el ? el.tagName : null };
    }, { x: pt.x, y: pt.y });
    throw new Error(
      `current id "${id}" did not change after clicking at ${fmtPt(pt)}; ` +
      `element under that point now: data-id=${diag.id} tag=${diag.tag}`
    );
  }
  return pt;
}

/** Play a game to completion by always clicking the current prompt correctly. */
async function playToCompletion(page, label) {
  const total = await page.evaluate(() => window.GeoApp.game.order().length);
  const maxIters = total * 5;
  const quizzed = [];
  const t0 = Date.now();
  let iterations = 0;
  while (true) {
    iterations++;
    if (iterations > maxIters) {
      throw new Error(`(${label}) exceeded max iterations (${maxIters}) without the game finishing`);
    }
    const id = await page.evaluate(() => window.GeoApp.currentId());
    if (id === null || id === undefined) break;
    quizzed.push(id);
    await clickCurrentAndAdvance(page, id);
  }
  const elapsedMs = Date.now() - t0;
  return { total, quizzed, elapsedMs };
}

async function getClass(page, id) {
  return page.evaluate((id) => {
    const el = document.querySelector('path.country[data-id="' + CSS.escape(id) + '"]');
    return el ? el.getAttribute('class') : null;
  }, id);
}

function hasClass(cls, name) {
  return !!cls && new RegExp('\\b' + name + '\\b').test(cls);
}

async function waitForClass(page, id, name, timeoutMs) {
  try {
    await page.waitForFunction(
      ({ id, name }) => {
        const el = document.querySelector('path.country[data-id="' + CSS.escape(id) + '"]');
        return !!(el && new RegExp('\\b' + name + '\\b').test(el.getAttribute('class') || ''));
      },
      { id, name },
      { timeout: timeoutMs, polling: 20 }
    );
    return true;
  } catch (e) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Scenario 1: renders
// ---------------------------------------------------------------------------

async function testRenders(page, baseUrl) {
  await page.goto(baseUrl + '/index.html', { waitUntil: 'load' });
  await page.waitForFunction(() => !!(window.GeoApp && window.GeoApp.map), null, { timeout: 15000 });

  const data = await page.evaluate(() => window.WORLD1940);
  assert.ok(data && Array.isArray(data.entities) && data.entities.length > 0, 'WORLD1940.entities missing or empty');

  const pathCount = await page.locator('path.country').count();
  assert.strictEqual(
    pathCount, data.entities.length,
    `expected ${data.entities.length} path.country elements (one per WORLD1940 entity), found ${pathCount}`
  );

  const dataIds = await page.$$eval('path.country', (els) => els.map((el) => el.getAttribute('data-id')));
  const idCounts = {};
  for (const id of dataIds) idCounts[id] = (idCounts[id] || 0) + 1;
  const duplicates = Object.keys(idCounts).filter((id) => idCounts[id] > 1);
  assert.strictEqual(duplicates.length, 0, `data-id values repeated on more than one path.country: ${duplicates.join(', ')}`);

  const idSet = new Set(dataIds);
  const missing = data.entities.map((e) => e.id).filter((id) => !idSet.has(id));
  assert.strictEqual(missing.length, 0, `entity ids missing as a path.country data-id: ${missing.join(', ')}`);

  const emptyD = await page.$$eval('path.country', (els) =>
    els.filter((el) => !el.getAttribute('d') || el.getAttribute('d').trim() === '').map((el) => el.getAttribute('data-id'))
  );
  assert.strictEqual(emptyD.length, 0, `path.country elements with an empty "d" attribute: ${emptyD.join(', ')}`);

  const requiredSelectors = [
    '#prompt-name', '#counter', '#timer', '#score',
    '#region-select', '#start-btn', '#include-small', '#feedback',
  ];
  for (const sel of requiredSelectors) {
    const count = await page.locator(sel).count();
    assert.ok(count > 0, `required element not found: ${sel}`);
  }

  const resultsHiddenCount = await page.locator('#results[hidden]').count();
  assert.ok(resultsHiddenCount > 0, '#results should be present with the "hidden" attribute before a game starts');

  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '01-initial.png') });
}

// ---------------------------------------------------------------------------
// Scenario 2: perfect world game
// ---------------------------------------------------------------------------

async function testPerfectWorldGame(page) {
  await page.selectOption('#region-select', 'world');
  await page.click('#start-btn');
  await page.waitForFunction(
    () => !!(window.GeoApp.game && window.GeoApp.currentId() !== null),
    null, { timeout: 10000 }
  );

  const { total, quizzed, elapsedMs } = await playToCompletion(page, 'perfect world game');
  console.log(`  perfect world game: ${total} entities in ${elapsedMs}ms`);

  const resultsVisible = await page.evaluate(() => {
    const el = document.getElementById('results');
    return !!el && !el.hasAttribute('hidden');
  });
  assert.strictEqual(resultsVisible, true, '#results should be visible (no "hidden" attribute) once the game finishes');

  const scoreText = (await page.locator('#results-score').innerText()).trim();
  assert.ok(scoreText.includes('100%'), `expected #results-score to contain "100%", got "${scoreText}"`);

  const counterText = (await page.locator('#counter').innerText()).trim();
  const nums = (counterText.match(/\d+/g) || []).map(Number);
  assert.strictEqual(nums.length, 2, `expected #counter to contain two numbers ("x / total"), got "${counterText}"`);
  assert.strictEqual(nums[0], total, `expected #counter's first number to equal total (${total}), got "${counterText}"`);
  assert.strictEqual(nums[1], total, `expected #counter's second number to equal total (${total}), got "${counterText}"`);

  for (const id of quizzed) {
    const cls = await getClass(page, id);
    assert.ok(hasClass(cls, 'state-correct1'), `expected entity "${id}" to carry class state-correct1, got class="${cls}"`);
  }

  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '02-finished.png') });
}

// ---------------------------------------------------------------------------
// Scenario 3: wrong answers and reveal
// ---------------------------------------------------------------------------

async function testWrongAnswersAndReveal(page) {
  const playAgainCount = await page.locator('#play-again-btn').count();
  if (playAgainCount > 0) {
    await page.click('#play-again-btn');
  } else {
    await page.click('#start-btn');
  }
  await page.waitForFunction(
    () => !!(window.GeoApp.game && window.GeoApp.currentId() !== null),
    null, { timeout: 10000 }
  );

  const order = await page.evaluate(() => window.GeoApp.game.order());
  const firstPromptId = await page.evaluate(() => window.GeoApp.currentId());
  const distractors = order.filter((id) => id !== firstPromptId).slice(0, 3);
  assert.strictEqual(
    distractors.length, 3,
    `need at least 4 quiz entities to exercise the wrong-answer flow, got ${order.length}`
  );

  // --- 1st wrong click ---
  let pt = await resolveClickPoint(page, distractors[0]);
  await page.mouse.click(pt.x, pt.y);

  await page.waitForFunction(
    () => {
      const el = document.getElementById('feedback');
      return !!(el && el.textContent && el.textContent.indexOf('That was') === 0);
    },
    null, { timeout: 2000 }
  ).catch(() => {
    throw new Error('expected #feedback text to start with "That was" after the first wrong click');
  });

  const gotWrong1 = await waitForClass(page, distractors[0], 'state-wrong', 300);
  assert.ok(gotWrong1, `expected path[data-id="${distractors[0]}"] to gain class state-wrong within 300ms of a wrong click`);

  let currentAfter1 = await page.evaluate(() => window.GeoApp.currentId());
  assert.strictEqual(currentAfter1, firstPromptId, 'currentId should not advance after just one wrong click');

  // --- 2nd wrong click ---
  pt = await resolveClickPoint(page, distractors[1]);
  await page.mouse.click(pt.x, pt.y);

  let currentAfter2 = await page.evaluate(() => window.GeoApp.currentId());
  assert.strictEqual(currentAfter2, firstPromptId, 'currentId should not advance after two wrong clicks');

  // --- 3rd wrong click: should reveal the answer and advance ---
  pt = await resolveClickPoint(page, distractors[2]);
  await page.mouse.click(pt.x, pt.y);

  try {
    await page.waitForFunction(
      (prevId) => window.GeoApp.currentId() !== prevId,
      firstPromptId, { timeout: 2000, polling: 30 }
    );
  } catch (e) {
    throw new Error(`GeoApp.currentId() should have advanced past "${firstPromptId}" after the 3rd wrong click`);
  }

  const revealedClass = await getClass(page, firstPromptId);
  assert.ok(
    hasClass(revealedClass, 'state-revealed'),
    `expected the prompted entity "${firstPromptId}" to carry class state-revealed after 3 wrong clicks, got class="${revealedClass}"`
  );

  const secondPromptId = await page.evaluate(() => window.GeoApp.currentId());
  assert.notStrictEqual(secondPromptId, firstPromptId, 'currentId() should have advanced to a different id after the reveal');

  // --- next prompt: wrong once, then right once -> state-correct2 ---
  const distractorForSecond = order.find((id) => id !== secondPromptId && id !== firstPromptId);
  assert.ok(distractorForSecond, 'need another entity distinct from the two prompts already used, to answer wrong once');

  pt = await resolveClickPoint(page, distractorForSecond);
  await page.mouse.click(pt.x, pt.y);

  pt = await resolveClickPoint(page, secondPromptId);
  await page.mouse.click(pt.x, pt.y);

  const gotCorrect2 = await waitForClass(page, secondPromptId, 'state-correct2', 2000);
  assert.ok(gotCorrect2, `expected entity "${secondPromptId}" to carry class state-correct2 after one wrong then one right guess`);

  // --- finish the rest correctly ---
  await playToCompletion(page, 'reveal test cleanup');

  const scoreText = (await page.locator('#results-score').innerText()).trim();
  assert.ok(!scoreText.includes('100%'), `expected #results-score to NOT be 100% after wrong answers, got "${scoreText}"`);

  const missesCount = await page.locator('#results-misses li').count();
  assert.ok(missesCount >= 2, `expected #results-misses to list at least 2 items, found ${missesCount}`);

  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '03-reveal.png') });
}

// ---------------------------------------------------------------------------
// Scenario 4: region game
// ---------------------------------------------------------------------------

/** If the results overlay is still showing from a previous game, dismiss it via Play again. */
async function ensureResultsHidden(page) {
  const stillHidden = await page.locator('#results[hidden]').count();
  if (stillHidden > 0) return;
  const playAgainCount = await page.locator('#play-again-btn').count();
  if (playAgainCount > 0) {
    await page.click('#play-again-btn');
  }
  await page.waitForFunction(
    () => document.getElementById('results').hasAttribute('hidden'),
    null, { timeout: 5000 }
  ).catch(() => {
    throw new Error('#results overlay from the previous game is still showing and has no way to be dismissed (#play-again-btn missing?)');
  });
}

async function testRegionGame(page) {
  await ensureResultsHidden(page);
  await page.selectOption('#region-select', 'europe');
  const includeSmallChecked = await page.locator('#include-small').isChecked();
  if (includeSmallChecked) await page.uncheck('#include-small');

  await page.click('#start-btn');
  await page.waitForFunction(
    () => !!(window.GeoApp.game && window.GeoApp.currentId() !== null),
    null, { timeout: 10000 }
  );

  const order = await page.evaluate(() => window.GeoApp.game.order());
  const entities = await page.evaluate(() => window.WORLD1940.entities);
  const byId = new Map(entities.map((e) => [e.id, e]));

  assert.ok(order.length > 0, 'region "europe" game order() is empty');
  for (const id of order) {
    const ent = byId.get(id);
    assert.ok(ent, `order() contains unknown id "${id}"`);
    assert.strictEqual(ent.region, 'europe', `entity "${id}" has region "${ent.region}", expected "europe"`);
  }
  const baseLen = order.length;

  await page.check('#include-small');
  await page.click('#start-btn');
  await page.waitForFunction(
    () => !!(window.GeoApp.game && window.GeoApp.currentId() !== null),
    null, { timeout: 10000 }
  );

  const order2 = await page.evaluate(() => window.GeoApp.game.order());
  for (const id of order2) {
    const ent = byId.get(id);
    assert.ok(ent, `order() (include-small) contains unknown id "${id}"`);
    assert.strictEqual(ent.region, 'europe', `entity "${id}" (include-small) has region "${ent.region}", expected "europe"`);
  }
  assert.ok(
    order2.length > baseLen,
    `expected the "europe" + include-small order (${order2.length}) to be longer than europe alone (${baseLen})`
  );

  const smallEuropeIds = entities.filter((e) => e.region === 'europe' && e.quiz === false).map((e) => e.id);
  const order2Set = new Set(order2);
  const includedSmall = smallEuropeIds.filter((id) => order2Set.has(id));
  assert.ok(
    includedSmall.length > 0,
    `expected at least one quiz:false "europe" entity in the include-small order; ` +
    `candidates were [${smallEuropeIds.join(', ')}], order2 had [${order2.join(', ')}]`
  );

  await page.uncheck('#include-small');
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

async function runScenario(name, fn, state) {
  const startErrCount = state.errors.length;
  const t0 = Date.now();
  try {
    await fn();
    const newErrors = state.errors.slice(startErrCount);
    if (newErrors.length > 0) {
      throw new Error(`console.error/pageerror occurred during this test: ${newErrors.join(' | ')}`);
    }
    console.log(`PASS  ${name}  (${Date.now() - t0}ms)`);
    return true;
  } catch (e) {
    console.log(`FAIL  ${name}  (${Date.now() - t0}ms)`);
    console.log(`      ${e && e.message ? e.message : e}`);
    return false;
  }
}

async function main() {
  const overallT0 = Date.now();
  const server = await startServer(ROOT);
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`Serving ${ROOT} at ${baseUrl}`);

  const { chromium } = loadPlaywright();
  const browser = await launchChromium(chromium);

  let allPassed = true;
  try {
    const context = await browser.newContext({ viewport: VIEWPORT });
    const page = await context.newPage();

    const state = { errors: [] };
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        state.errors.push(`console.error: ${msg.text()}`);
      }
    });
    page.on('pageerror', (err) => {
      state.errors.push(`pageerror: ${err && err.message ? err.message : err}`);
    });

    const scenarios = [
      ['renders', () => testRenders(page, baseUrl)],
      ['perfect world game', () => testPerfectWorldGame(page)],
      ['wrong answers and reveal', () => testWrongAnswersAndReveal(page)],
      ['region game', () => testRegionGame(page)],
    ];

    for (const [name, fn] of scenarios) {
      const ok = await runScenario(name, fn, state);
      if (!ok) {
        allPassed = false;
        break; // fail fast: later scenarios build on earlier game state
      }
    }
  } catch (e) {
    console.log(`FAIL  (setup/teardown)  ${e && e.stack ? e.stack : e}`);
    allPassed = false;
  } finally {
    try { await browser.close(); } catch (e) { /* ignore */ }
    await new Promise((resolve) => server.close(resolve));
  }

  const totalMs = Date.now() - overallT0;
  console.log('----------------------------------------');
  console.log(allPassed ? `SUMMARY: all tests passed (${totalMs}ms)` : `SUMMARY: FAILED (${totalMs}ms)`);
  process.exit(allPassed ? 0 : 1);
}

main().catch((e) => {
  console.log(`FAIL  (uncaught)  ${e && e.stack ? e.stack : e}`);
  process.exit(1);
});
