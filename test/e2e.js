#!/usr/bin/env node
// test/e2e.js — Playwright end-to-end test for the World Map Quiz.
//
// Covers TWO map years (1914 and 1940, toggled in the UI) driven by
// `window.GeoApp.years()` rather than hardcoded — see docs/SPEC.md and the
// year-toggle contract described alongside it.
//
// Run with: node test/e2e.js   (wired to `npm run test:e2e`)
// Exit code 0 on success, 1 on any failure.
//
// Serves the repo root (or E2E_ROOT, for development against a scratch app)
// over plain HTTP, drives a headless Chromium through five scenarios, and
// writes screenshots to test/screenshots/ (git-ignored), tagged by year.
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

function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const x of a) {
    if (!b.has(x)) return false;
  }
  return true;
}

/**
 * Resolve a screen point for `id`'s label that is verified (via
 * document.elementFromPoint) to actually land on that entity's path. If the
 * naive point misses (e.g. a tiny territory whose label point is covered by
 * a neighbour at the current zoom level), zoom in on its bbox and retry.
 *
 * Always resolves against the ACTIVE snapshot (window.GeoApp.data) — never a
 * hardcoded global — so it works the same regardless of which year is live.
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

    // Miss: zoom in on the entity's bbox (in the ACTIVE snapshot) and retry.
    const bbox = await page.evaluate((id) => {
      const data = window.GeoApp && window.GeoApp.data;
      const ent = data && data.entities ? data.entities.find((e) => e.id === id) : null;
      return ent ? ent.bbox : null;
    }, id);
    if (!bbox) throw new Error(`entity "${id}" not found in GeoApp.data.entities (for zoom fallback)`);
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

/**
 * Click the `.year-btn[data-year="yearId"]` toggle button and wait for the
 * switch to fully land: GeoApp.currentYear()/GeoApp.data.meta.id agree with
 * `yearId`, and the map DOM has finished rebuilding (path.country count
 * matches the new snapshot). Dismisses a leftover results overlay first, in
 * case a modal backdrop would otherwise intercept the click.
 */
async function switchYear(page, yearId, timeoutMs) {
  await ensureResultsHidden(page);
  await page.click(`.year-btn[data-year="${yearId}"]`);
  await page.waitForFunction(
    (y) => {
      const app = window.GeoApp;
      if (!app || typeof app.currentYear !== 'function' || app.currentYear() !== y) return false;
      const d = app.data;
      if (!d || !d.meta || d.meta.id !== y) return false;
      return document.querySelectorAll('path.country').length === d.entities.length;
    },
    yearId,
    { timeout: timeoutMs || 8000, polling: 20 }
  );
}

/** Read a year-toggle button's active/pressed state. */
async function yearButtonState(page, yearId) {
  return page.evaluate((y) => {
    const btn = document.querySelector('.year-btn[data-year="' + y + '"]');
    if (!btn) return null;
    const cls = btn.getAttribute('class') || '';
    return {
      active: /\bis-active\b/.test(cls),
      pressed: btn.getAttribute('aria-pressed'),
    };
  }, yearId);
}

/**
 * Assert the app is in the "just switched years, nothing started yet" idle
 * state: header stats reset to zero, no game, results/note hidden, and the
 * map itself is non-interactive (a click on it is a no-op).
 */
async function assertPostSwitchIdleState(page, yearTag) {
  const counterText = (await page.locator('#counter').innerText()).trim();
  const nums = (counterText.match(/\d+/g) || []).map(Number);
  assert.strictEqual(nums.length, 2, `[${yearTag}] expected #counter to read "x / y", got "${counterText}"`);
  assert.ok(nums[0] === 0 && nums[1] === 0, `[${yearTag}] expected #counter reset to zero after a year switch, got "${counterText}"`);

  const timerText = (await page.locator('#timer').innerText()).trim();
  assert.ok(/^0+:0+$/.test(timerText), `[${yearTag}] expected #timer reset to zero after a year switch, got "${timerText}"`);

  const scoreText = (await page.locator('#score').innerText()).trim();
  assert.ok(/^0\s*%$/.test(scoreText), `[${yearTag}] expected #score reset to "0%" after a year switch, got "${scoreText}"`);

  const resultsHiddenCount = await page.locator('#results[hidden]').count();
  assert.ok(resultsHiddenCount > 0, `[${yearTag}] #results should be hidden right after a year switch`);

  const noteHiddenOrAbsent = await page.evaluate(() => {
    const n = document.getElementById('note');
    return !n || n.hasAttribute('hidden');
  });
  assert.ok(noteHiddenOrAbsent, `[${yearTag}] #note should be hidden right after a year switch`);

  const hasGame = await page.evaluate(() => !!window.GeoApp.game);
  assert.ok(!hasGame, `[${yearTag}] GeoApp.game should be falsy (no game) right after a year switch`);

  const currentIdAfterSwitch = await page.evaluate(() => window.GeoApp.currentId());
  assert.strictEqual(currentIdAfterSwitch, null, `[${yearTag}] GeoApp.currentId() should be null right after a year switch (no auto-start)`);

  // The map must be non-interactive: a click on a rendered entity is a no-op.
  const anyEntityId = await page.evaluate(() => {
    const data = window.GeoApp.data;
    return data && data.entities && data.entities.length ? data.entities[0].id : null;
  });
  assert.ok(anyEntityId, `[${yearTag}] active snapshot has no entities to probe non-interactivity with`);

  const pt = await resolveClickPoint(page, anyEntityId);
  await page.mouse.click(pt.x, pt.y);
  await page.waitForTimeout(150);

  const clsAfterClick = await getClass(page, anyEntityId);
  assert.ok(
    !hasClass(clsAfterClick, 'state-correct1') &&
    !hasClass(clsAfterClick, 'state-correct2') &&
    !hasClass(clsAfterClick, 'state-correct3') &&
    !hasClass(clsAfterClick, 'state-wrong') &&
    !hasClass(clsAfterClick, 'state-revealed'),
    `[${yearTag}] clicking the map right after a year switch should be a no-op (map non-interactive), got class="${clsAfterClick}"`
  );

  const stillNoGame = await page.evaluate(() => !window.GeoApp.game);
  assert.ok(stillNoGame, `[${yearTag}] a map click right after a year switch must not start a game`);
}

// ---------------------------------------------------------------------------
// Scenario 1: renders — for every year in GeoApp.years()
// ---------------------------------------------------------------------------

async function testRenders(page, baseUrl) {
  await page.goto(baseUrl + '/index.html', { waitUntil: 'load' });
  await page.waitForFunction(
    () => !!(window.GeoApp && window.GeoApp.map && typeof window.GeoApp.years === 'function'),
    null, { timeout: 15000 }
  );

  const years = await page.evaluate(() => window.GeoApp.years());
  assert.ok(Array.isArray(years) && years.length >= 2, `GeoApp.years() should return at least 2 years, got ${JSON.stringify(years)}`);
  const sortedAscending = years.slice().sort((a, b) => Number(a) - Number(b));
  assert.deepStrictEqual(years, sortedAscending, `GeoApp.years() should be ascending, got ${JSON.stringify(years)}`);
  assert.ok(years.includes('1914') && years.includes('1940'), `GeoApp.years() should include both "1914" and "1940", got ${JSON.stringify(years)}`);

  const requiredSelectors = [
    '#map', '#prompt-name', '#counter', '#timer', '#score',
    '#region-select', '#start-btn', '#include-small', '#feedback',
    '#results', '#results-score', '#results-time', '#results-misses',
    '#play-again-btn', '#note', '#year-toggle',
  ];
  for (const sel of requiredSelectors) {
    const count = await page.locator(sel).count();
    assert.ok(count > 0, `required element not found: ${sel}`);
  }

  const resultsHiddenCount = await page.locator('#results[hidden]').count();
  assert.ok(resultsHiddenCount > 0, '#results should be present with the "hidden" attribute before a game starts');

  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  for (const year of years) {
    await switchYear(page, year);

    const btnCount = await page.locator(`.year-btn[data-year="${year}"]`).count();
    assert.strictEqual(btnCount, 1, `[${year}] expected exactly one .year-btn[data-year="${year}"]`);

    const data = await page.evaluate(() => window.GeoApp.data);
    assert.ok(data && Array.isArray(data.entities) && data.entities.length > 0, `[${year}] GeoApp.data.entities missing or empty`);
    assert.strictEqual(data.meta.id, year, `[${year}] GeoApp.data.meta.id should be "${year}", got "${data.meta.id}"`);

    const pathCount = await page.locator('path.country').count();
    assert.strictEqual(
      pathCount, data.entities.length,
      `[${year}] expected ${data.entities.length} path.country elements (one per entity), found ${pathCount}`
    );

    const dataIds = await page.$$eval('path.country', (els) => els.map((el) => el.getAttribute('data-id')));
    const idCounts = {};
    for (const id of dataIds) idCounts[id] = (idCounts[id] || 0) + 1;
    const duplicates = Object.keys(idCounts).filter((id) => idCounts[id] > 1);
    assert.strictEqual(duplicates.length, 0, `[${year}] data-id values repeated on more than one path.country: ${duplicates.join(', ')}`);

    const idSet = new Set(dataIds);
    const missing = data.entities.map((e) => e.id).filter((id) => !idSet.has(id));
    assert.strictEqual(missing.length, 0, `[${year}] entity ids missing as a path.country data-id: ${missing.join(', ')}`);
    // Together with the count/duplicate checks above, this proves every id appears exactly once.

    const emptyD = await page.$$eval('path.country', (els) =>
      els.filter((el) => !el.getAttribute('d') || el.getAttribute('d').trim() === '').map((el) => el.getAttribute('data-id'))
    );
    assert.strictEqual(emptyD.length, 0, `[${year}] path.country elements with an empty "d" attribute: ${emptyD.join(', ')}`);

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, `01-initial-${year}.png`) });
  }
}

// ---------------------------------------------------------------------------
// Scenario 2: perfect world game — for every year in GeoApp.years()
// ---------------------------------------------------------------------------

async function testPerfectWorldGame(page) {
  const years = await page.evaluate(() => window.GeoApp.years());
  assert.ok(Array.isArray(years) && years.length > 0, 'GeoApp.years() returned no years');

  for (const year of years) {
    await switchYear(page, year);

    await page.selectOption('#region-select', 'world');
    await page.click('#start-btn');
    await page.waitForFunction(
      () => !!(window.GeoApp.game && window.GeoApp.currentId() !== null),
      null, { timeout: 10000 }
    );

    const total = await page.evaluate(() => window.GeoApp.game.order().length);
    const expectedQuizTotal = await page.evaluate(
      () => window.GeoApp.data.entities.filter((e) => e.quiz !== false).length
    );
    assert.strictEqual(
      total, expectedQuizTotal,
      `[${year}] "world" game order length (${total}) should equal the snapshot's quiz-eligible entity count (${expectedQuizTotal})`
    );

    const { quizzed, elapsedMs } = await playToCompletion(page, `perfect world game (${year})`);
    console.log(`  perfect world game (${year}): ${total} entities in ${elapsedMs}ms`);

    const resultsVisible = await page.evaluate(() => {
      const el = document.getElementById('results');
      return !!el && !el.hasAttribute('hidden');
    });
    assert.strictEqual(resultsVisible, true, `[${year}] #results should be visible (no "hidden" attribute) once the game finishes`);

    const scoreText = (await page.locator('#results-score').innerText()).trim();
    assert.ok(scoreText.includes('100%'), `[${year}] expected #results-score to contain "100%", got "${scoreText}"`);

    const counterText = (await page.locator('#counter').innerText()).trim();
    const nums = (counterText.match(/\d+/g) || []).map(Number);
    assert.strictEqual(nums.length, 2, `[${year}] expected #counter to contain two numbers ("x / total"), got "${counterText}"`);
    assert.strictEqual(nums[0], total, `[${year}] expected #counter's first number to equal total (${total}), got "${counterText}"`);
    assert.strictEqual(nums[1], total, `[${year}] expected #counter's second number to equal total (${total}), got "${counterText}"`);

    for (const id of quizzed) {
      const cls = await getClass(page, id);
      assert.ok(hasClass(cls, 'state-correct1'), `[${year}] expected entity "${id}" to carry class state-correct1, got class="${cls}"`);
    }

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, `02-finished-${year}.png`) });
  }
}

// ---------------------------------------------------------------------------
// Scenario 3: wrong answers and reveal — runs against the ACTIVE snapshot
// (whichever year testPerfectWorldGame left active), not a hardcoded year.
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

  const yearTag = await page.evaluate(() => window.GeoApp.currentYear());

  const order = await page.evaluate(() => window.GeoApp.game.order());
  const firstPromptId = await page.evaluate(() => window.GeoApp.currentId());
  const distractors = order.filter((id) => id !== firstPromptId).slice(0, 3);
  assert.strictEqual(
    distractors.length, 3,
    `(${yearTag}) need at least 4 quiz entities to exercise the wrong-answer flow, got ${order.length}`
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
    throw new Error(`(${yearTag}) expected #feedback text to start with "That was" after the first wrong click`);
  });

  const gotWrong1 = await waitForClass(page, distractors[0], 'state-wrong', 300);
  assert.ok(gotWrong1, `(${yearTag}) expected path[data-id="${distractors[0]}"] to gain class state-wrong within 300ms of a wrong click`);

  let currentAfter1 = await page.evaluate(() => window.GeoApp.currentId());
  assert.strictEqual(currentAfter1, firstPromptId, `(${yearTag}) currentId should not advance after just one wrong click`);

  // --- 2nd wrong click ---
  pt = await resolveClickPoint(page, distractors[1]);
  await page.mouse.click(pt.x, pt.y);

  let currentAfter2 = await page.evaluate(() => window.GeoApp.currentId());
  assert.strictEqual(currentAfter2, firstPromptId, `(${yearTag}) currentId should not advance after two wrong clicks`);

  // --- 3rd wrong click: should reveal the answer and advance ---
  pt = await resolveClickPoint(page, distractors[2]);
  await page.mouse.click(pt.x, pt.y);

  try {
    await page.waitForFunction(
      (prevId) => window.GeoApp.currentId() !== prevId,
      firstPromptId, { timeout: 2000, polling: 30 }
    );
  } catch (e) {
    throw new Error(`(${yearTag}) GeoApp.currentId() should have advanced past "${firstPromptId}" after the 3rd wrong click`);
  }

  const revealedClass = await getClass(page, firstPromptId);
  assert.ok(
    hasClass(revealedClass, 'state-revealed'),
    `(${yearTag}) expected the prompted entity "${firstPromptId}" to carry class state-revealed after 3 wrong clicks, got class="${revealedClass}"`
  );

  const secondPromptId = await page.evaluate(() => window.GeoApp.currentId());
  assert.notStrictEqual(secondPromptId, firstPromptId, `(${yearTag}) currentId() should have advanced to a different id after the reveal`);

  // --- next prompt: wrong once, then right once -> state-correct2 ---
  const distractorForSecond = order.find((id) => id !== secondPromptId && id !== firstPromptId);
  assert.ok(distractorForSecond, `(${yearTag}) need another entity distinct from the two prompts already used, to answer wrong once`);

  pt = await resolveClickPoint(page, distractorForSecond);
  await page.mouse.click(pt.x, pt.y);

  pt = await resolveClickPoint(page, secondPromptId);
  await page.mouse.click(pt.x, pt.y);

  const gotCorrect2 = await waitForClass(page, secondPromptId, 'state-correct2', 2000);
  assert.ok(gotCorrect2, `(${yearTag}) expected entity "${secondPromptId}" to carry class state-correct2 after one wrong then one right guess`);

  // --- finish the rest correctly ---
  await playToCompletion(page, `reveal test cleanup (${yearTag})`);

  const scoreText = (await page.locator('#results-score').innerText()).trim();
  assert.ok(!scoreText.includes('100%'), `(${yearTag}) expected #results-score to NOT be 100% after wrong answers, got "${scoreText}"`);

  const missesCount = await page.locator('#results-misses li').count();
  assert.ok(missesCount >= 2, `(${yearTag}) expected #results-misses to list at least 2 items, found ${missesCount}`);

  await page.screenshot({ path: path.join(SCREENSHOT_DIR, `03-reveal-${yearTag}.png`) });
}

// ---------------------------------------------------------------------------
// Scenario 4: region game — runs against the ACTIVE snapshot's own regions,
// picking a non-"world" region with a quiz:false entity rather than
// hardcoding "europe" or any entity name/count.
// ---------------------------------------------------------------------------

async function testRegionGame(page) {
  await ensureResultsHidden(page);

  const yearTag = await page.evaluate(() => window.GeoApp.currentYear());

  const regionId = await page.evaluate(() => {
    const data = window.GeoApp.data;
    const regions = (data.regions || []).filter((r) => r.id !== 'world');
    const withSmall = regions.filter((r) =>
      data.entities.some((e) => e.region === r.id && e.quiz === false)
    );
    const chosen = withSmall[0] || regions[0];
    return chosen ? chosen.id : null;
  });
  assert.ok(regionId, `(${yearTag}) no non-"world" region available in GeoApp.data.regions to exercise the region game`);

  await page.selectOption('#region-select', regionId);
  const includeSmallChecked = await page.locator('#include-small').isChecked();
  if (includeSmallChecked) await page.uncheck('#include-small');

  await page.click('#start-btn');
  await page.waitForFunction(
    () => !!(window.GeoApp.game && window.GeoApp.currentId() !== null),
    null, { timeout: 10000 }
  );

  const order = await page.evaluate(() => window.GeoApp.game.order());
  const entities = await page.evaluate(() => window.GeoApp.data.entities);
  const byId = new Map(entities.map((e) => [e.id, e]));

  assert.ok(order.length > 0, `(${yearTag}) region "${regionId}" game order() is empty`);
  for (const id of order) {
    const ent = byId.get(id);
    assert.ok(ent, `(${yearTag}) order() contains unknown id "${id}"`);
    assert.strictEqual(ent.region, regionId, `(${yearTag}) entity "${id}" has region "${ent.region}", expected "${regionId}"`);
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
    assert.ok(ent, `(${yearTag}) order() (include-small) contains unknown id "${id}"`);
    assert.strictEqual(ent.region, regionId, `(${yearTag}) entity "${id}" (include-small) has region "${ent.region}", expected "${regionId}"`);
  }
  assert.ok(
    order2.length > baseLen,
    `(${yearTag}) expected the "${regionId}" + include-small order (${order2.length}) to be longer than ${regionId} alone (${baseLen})`
  );

  const smallIds = entities.filter((e) => e.region === regionId && e.quiz === false).map((e) => e.id);
  const order2Set = new Set(order2);
  const includedSmall = smallIds.filter((id) => order2Set.has(id));
  assert.ok(
    includedSmall.length > 0,
    `(${yearTag}) expected at least one quiz:false "${regionId}" entity in the include-small order; ` +
    `candidates were [${smallIds.join(', ')}], order2 had [${order2.join(', ')}]`
  );

  await page.uncheck('#include-small');

  await page.screenshot({ path: path.join(SCREENSHOT_DIR, `04-region-${regionId}-${yearTag}.png`) });
}

// ---------------------------------------------------------------------------
// Scenario 5: year toggle — dedicated coverage of the year-switching UI
// itself. Starts with a fresh page load so "default active year" is a real
// assertion about first-load behaviour, not just whatever a prior scenario
// happened to leave active.
// ---------------------------------------------------------------------------

async function testYearToggle(page, baseUrl) {
  await page.goto(baseUrl + '/index.html', { waitUntil: 'load' });
  await page.waitForFunction(
    () => !!(window.GeoApp && window.GeoApp.map && typeof window.GeoApp.years === 'function'),
    null, { timeout: 15000 }
  );

  const years = await page.evaluate(() => window.GeoApp.years());
  assert.ok(
    years.includes('1914') && years.includes('1940'),
    `expected GeoApp.years() to include both "1914" and "1940", got ${JSON.stringify(years)}`
  );

  // --- default state on load: 1940 active, 1914 not ---
  let s1940 = await yearButtonState(page, '1940');
  let s1914 = await yearButtonState(page, '1914');
  assert.ok(s1940, '.year-btn[data-year="1940"] not found');
  assert.ok(s1914, '.year-btn[data-year="1914"] not found');
  assert.strictEqual(s1940.active, true, 'default: .year-btn[data-year="1940"] should carry class "is-active"');
  assert.strictEqual(s1940.pressed, 'true', 'default: .year-btn[data-year="1940"] should have aria-pressed="true"');
  assert.strictEqual(s1914.active, false, 'default: .year-btn[data-year="1914"] should NOT carry class "is-active"');
  assert.notStrictEqual(s1914.pressed, 'true', 'default: .year-btn[data-year="1914"] should NOT have aria-pressed="true"');

  const defaultYear = await page.evaluate(() => window.GeoApp.currentYear());
  assert.strictEqual(defaultYear, '1940', `default GeoApp.currentYear() should be "1940", got "${defaultYear}"`);
  const defaultMetaId = await page.evaluate(() => window.GeoApp.data.meta.id);
  assert.strictEqual(defaultMetaId, '1940', `default GeoApp.data.meta.id should be "1940", got "${defaultMetaId}"`);

  // --- capture the rendered id set before switching, to prove a real swap later ---
  const idsBefore = await page.$$eval('path.country', (els) => els.map((el) => el.getAttribute('data-id')));

  // --- click 1914: it becomes active, 1940 becomes inactive ---
  await switchYear(page, '1914');

  s1940 = await yearButtonState(page, '1940');
  s1914 = await yearButtonState(page, '1914');
  assert.strictEqual(s1914.active, true, 'after switch: .year-btn[data-year="1914"] should carry class "is-active"');
  assert.strictEqual(s1914.pressed, 'true', 'after switch: .year-btn[data-year="1914"] should have aria-pressed="true"');
  assert.strictEqual(s1940.active, false, 'after switch: .year-btn[data-year="1940"] should no longer carry class "is-active"');
  assert.notStrictEqual(s1940.pressed, 'true', 'after switch: .year-btn[data-year="1940"] should no longer have aria-pressed="true"');

  const currentYearAfter = await page.evaluate(() => window.GeoApp.currentYear());
  assert.strictEqual(currentYearAfter, '1914', `GeoApp.currentYear() should agree with the button state ("1914"), got "${currentYearAfter}"`);
  const metaIdAfter = await page.evaluate(() => window.GeoApp.data.meta.id);
  assert.strictEqual(metaIdAfter, '1914', `GeoApp.data.meta.id should agree with the button state ("1914"), got "${metaIdAfter}"`);

  // --- the rendered .country data-id SET actually changes between years ---
  const idsAfter = await page.$$eval('path.country', (els) => els.map((el) => el.getAttribute('data-id')));
  const setBefore = new Set(idsBefore);
  const setAfter = new Set(idsAfter);
  assert.ok(
    !setsEqual(setBefore, setAfter),
    `expected the rendered .country data-id set to change between years, but it was identical ` +
    `(${idsAfter.length} ids: ${idsAfter.slice(0, 8).join(', ')}${idsAfter.length > 8 ? ', …' : ''})`
  );

  const entityIds1914 = await page.evaluate(() => window.GeoApp.data.entities.map((e) => e.id));
  assert.deepStrictEqual(
    [...setAfter].sort(), [...new Set(entityIds1914)].sort(),
    'the rendered .country data-id set should exactly equal the 1914 snapshot\'s entity ids'
  );

  // --- header stats reset, map non-interactive, no game, results/note hidden ---
  await assertPostSwitchIdleState(page, '1914');

  // --- a game started post-switch asks ONLY ids belonging to the 1914 snapshot ---
  await page.selectOption('#region-select', 'world');
  await page.click('#start-btn');
  await page.waitForFunction(
    () => !!(window.GeoApp.game && window.GeoApp.currentId() !== null),
    null, { timeout: 10000 }
  );

  const order = await page.evaluate(() => window.GeoApp.game.order());
  assert.ok(order.length > 0, 'post-switch game order() is empty');
  const idSet1914 = new Set(entityIds1914);
  const foreignIds = order.filter((id) => !idSet1914.has(id));
  assert.strictEqual(foreignIds.length, 0, `post-switch game asked ids not belonging to the 1914 snapshot: ${foreignIds.join(', ')}`);

  // Answer one correctly so the game is genuinely mid-progress, not just started.
  const firstId = await page.evaluate(() => window.GeoApp.currentId());
  await clickCurrentAndAdvance(page, firstId);
  const midStats = await page.evaluate(() => window.GeoApp.game.stats());
  assert.strictEqual(midStats.answered, 1, `expected exactly 1 answered entity before the mid-game switch, got ${midStats.answered}`);
  const finishedTooEarly = await page.evaluate(() => window.GeoApp.game.isFinished());
  assert.strictEqual(finishedTooEarly, false, 'game finished after a single answer — need it genuinely mid-game for this check; add more quiz entities');

  // --- switching years MID-GAME abandons the game, without showing results ---
  await switchYear(page, '1940');

  const gameFalsyAfterAbandon = await page.evaluate(() => !window.GeoApp.game);
  assert.ok(gameFalsyAfterAbandon, 'expected GeoApp.game to be falsy (discarded) after a mid-game year switch');

  const resultsHiddenAfterAbandon = await page.locator('#results[hidden]').count();
  assert.ok(resultsHiddenAfterAbandon > 0, 'switching years mid-game must not leave the #results overlay visible');

  await assertPostSwitchIdleState(page, '1940');

  const finalYear = await page.evaluate(() => window.GeoApp.currentYear());
  assert.strictEqual(finalYear, '1940', `expected GeoApp.currentYear() to be "1940" after switching back, got "${finalYear}"`);
  const finalBtnState = await yearButtonState(page, '1940');
  assert.strictEqual(finalBtnState.active, true, 'after switching back: .year-btn[data-year="1940"] should carry class "is-active" again');

  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '05-year-toggle.png') });
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
      ['year toggle', () => testYearToggle(page, baseUrl)],
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
