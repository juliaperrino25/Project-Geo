#!/usr/bin/env node
// test/map.e2e.js — Playwright end-to-end checks for map INTERACTION
// (js/map.js): wheel/button zoom, mouse + touch pan, click-vs-drag, pinch,
// tiny-island hit targets, hover, resize, and console cleanliness.
//
// Run with: node test/map.e2e.js     Exit code 0 on success, 1 on failure.
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(path.join(__dirname, '..'));
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
};

function loadPlaywright() {
  try { return require('playwright'); } catch (e) { return require('/opt/node22/lib/node_modules/playwright'); }
}

function startServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const p = decodeURIComponent((req.url || '/').split('?')[0]);
      const file = path.join(ROOT, path.normalize(p === '/' ? '/index.html' : p));
      if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403); return res.end(); }
      fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); return res.end('nf'); }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
        res.end(data);
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function launch(chromium) {
  try { return await chromium.launch({ headless: true }); } catch (e) {
    const base = '/opt/pw-browsers';
    if (fs.existsSync(base)) {
      for (const d of fs.readdirSync(base).filter((n) => n.startsWith('chromium'))) {
        for (const sub of ['chrome-linux/chrome', 'chrome-linux/headless_shell']) {
          const c = path.join(base, d, sub);
          if (fs.existsSync(c)) return chromium.launch({ headless: true, executablePath: c });
        }
      }
    }
    throw e;
  }
}

let failures = 0;
function check(cond, msg) {
  if (cond) console.log('  ok   ' + msg);
  else { failures++; console.log('  FAIL ' + msg); }
}
const near = (a, b, eps) => Math.abs(a - b) <= eps;

// --- in-page helpers -------------------------------------------------------

const appVb = (page) => page.evaluate(() => window.GeoApp.map.getViewBox());
const vb = (page) => page.evaluate(() => window.__map.getViewBox());

/** Replace the app's map with a fresh instance that records clicks/hovers. */
async function installProbeMap(page) {
  await page.evaluate(() => {
    const app = window.GeoApp;
    app.map.destroy();
    window.__clicks = [];
    window.__hovers = [];
    const m = window.GeoMap.create(document.getElementById('map'), app.data, {
      onClick: (id) => window.__clicks.push(id),
      onHover: (id) => window.__hovers.push(id),
    });
    m.setInteractive(true);
    window.__map = m;
  });
}

const mapRect = (page) => page.evaluate(() => {
  const r = document.querySelector('#map svg').getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
});

/** Screen point of a viewBox-unit point under the current view. */
const vbToScreen = (page, x, y) => page.evaluate(([x, y]) => {
  const svg = document.querySelector('#map svg');
  const r = svg.getBoundingClientRect();
  const v = window.__map.getViewBox();
  const s = Math.min(r.width / v[2], r.height / v[3]);
  return {
    x: r.left + (r.width - v[2] * s) / 2 + (x - v[0]) * s,
    y: r.top + (r.height - v[3] * s) / 2 + (y - v[1]) * s,
  };
}, [x, y]);

/** viewBox-unit coords under a screen point. */
const screenToVb = (page, cx, cy) => page.evaluate(([cx, cy]) => {
  const r = document.querySelector('#map svg').getBoundingClientRect();
  const v = window.__map.getViewBox();
  const s = Math.min(r.width / v[2], r.height / v[3]);
  return { x: v[0] + (cx - r.left - (r.width - v[2] * s) / 2) / s, y: v[1] + (cy - r.top - (r.height - v[3] * s) / 2) / s };
}, [cx, cy]);

// Wait until the viewBox stops changing (animations done), regardless of frame rate.
async function settle(page) {
  let last = '', stable = 0;
  for (let i = 0; i < 100 && stable < 3; i++) {
    await page.waitForTimeout(80);
    const cur = await page.evaluate(() => JSON.stringify((window.__map || window.GeoApp.map).getViewBox()));
    stable = cur === last ? stable + 1 : 0;
    last = cur;
  }
}

function viewInsideWorld(v, W, H) {
  const e = 1e-6;
  const okX = v[2] >= W - e || (v[0] >= -e && v[0] + v[2] <= W + e);
  const okY = v[3] >= H - e || (v[1] >= -e && v[1] + v[3] <= H + e);
  return okX && okY && v.every(Number.isFinite) && v[2] > 0 && v[3] > 0;
}

// --- CDP touch helpers -----------------------------------------------------

async function touch(cdp, type, pts) {
  await cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: pts.map((p, i) => ({ x: p.x, y: p.y, id: p.id != null ? p.id : i })),
  });
}

async function main() {
  const { chromium } = loadPlaywright();
  const server = await startServer();
  const url = 'http://127.0.0.1:' + server.address().port + '/index.html';
  const browser = await launch(chromium);
  const errors = [];
  const hook = (page, tag) => {
    page.on('pageerror', (e) => errors.push(tag + ' pageerror: ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(tag + ' console: ' + m.text()); });
  };

  try {
    // ======================= DESKTOP =======================
    console.log('Desktop 1400x900');
    const dctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await dctx.newPage();
    hook(page, 'desktop');
    await page.goto(url);
    await page.waitForFunction(() => window.GeoApp && window.GeoApp.map && document.querySelector('path.country'));
    const dims = await page.evaluate(() => ({ W: window.GeoApp.data.meta.width, H: window.GeoApp.data.meta.height }));
    const { W, H } = dims;

    let v;
    // buttons
    await page.click('#zoom-in'); await settle(page);
    let w1 = (await appVb(page))[2];
    check(w1 < W - 1, `+ button zooms in (${w1.toFixed(1)})`);
    await page.click('#zoom-in'); await settle(page);
    const w2 = (await appVb(page))[2];
    check(w2 < w1 - 1, '+ button zooms in again');
    await page.click('#zoom-out'); await settle(page);
    check((await appVb(page))[2] > w2 + 1, '- button zooms out');
    await page.click('#zoom-reset'); await settle(page);
    v = await appVb(page);
    check(near(v[0], 0, 1e-3) && near(v[1], 0, 1e-3) && near(v[2], W, 1e-3) && near(v[3], H, 1e-3), 'reset restores the full extent');
    for (let i = 0; i < 10; i++) { await page.click('#zoom-out'); await page.waitForTimeout(30); }
    await settle(page);
    v = await appVb(page);
    check(near(v[2], W, 1e-3), '- button cannot zoom out past the full extent');
    await installProbeMap(page);

    // 1. wheel zoom around the cursor
    let r = await mapRect(page);
    const cx = r.left + r.width * 0.7, cy = r.top + r.height * 0.4;
    const before = await screenToVb(page, cx, cy);
    await page.mouse.move(cx, cy);
    for (let i = 0; i < 4; i++) await page.mouse.wheel(0, -100);
    await page.waitForTimeout(100);
    v = await vb(page);
    check(v[2] < W * 0.8, `wheel in zooms (viewBox width ${v[2].toFixed(1)} < ${W})`);
    const after = await screenToVb(page, cx, cy);
    check(near(before.x, after.x, 0.5) && near(before.y, after.y, 0.5),
      `point under cursor stays fixed (${before.x.toFixed(1)},${before.y.toFixed(1)} -> ${after.x.toFixed(1)},${after.y.toFixed(1)})`);
    check(viewInsideWorld(v, W, H), 'zoomed view stays inside the world extent');
    for (let i = 0; i < 60; i++) await page.mouse.wheel(0, -200);
    await page.waitForTimeout(100);
    v = await vb(page);
    check(v[2] >= W / 12 - 1e-6, `max zoom clamped (width ${v[2].toFixed(2)} >= ${(W / 12).toFixed(2)})`);
    check(viewInsideWorld(v, W, H), 'max-zoom view inside extent');
    // wheel out at the map corner: never shows blank beyond the clamp
    await page.mouse.move(r.left + 5, r.top + 5);
    for (let i = 0; i < 80; i++) await page.mouse.wheel(0, 200);
    await page.waitForTimeout(100);
    v = await vb(page);
    check(near(v[2], W, 1e-6) && near(v[0], 0, 1e-6) && near(v[1], 0, 1e-6), `wheel out clamps to full extent (${v.map((n) => n.toFixed(1))})`);

    // 2. mouse drag pans; small movement is a click; drag is not
    await page.evaluate(() => { window.__clicks.length = 0; });
    await page.evaluate(() => { window.__map.zoomBy(1.5); window.__map.zoomBy(1.5); }); await settle(page);
    check(near((await vb(page))[2], W / 2.25, 0.5), `rapid zoomBy calls compound (width ${(await vb(page))[2].toFixed(1)} ~ ${(W / 2.25).toFixed(1)})`);
    r = await mapRect(page);
    const v0 = await vb(page);
    const sx = r.left + r.width / 2, sy = r.top + r.height / 2;
    await page.mouse.move(sx, sy); await page.mouse.down();
    await page.mouse.move(sx + 60, sy + 30, { steps: 6 });
    await page.mouse.up();
    const v1 = await vb(page);
    check(v1[0] < v0[0] - 1 && v1[1] < v0[1] - 0.5 || v1[0] === 0 || v1[1] === 0, `mouse drag pans (x ${v0[0].toFixed(1)} -> ${v1[0].toFixed(1)})`);
    check(near(v1[2], v0[2], 1e-9), 'drag does not change zoom');
    check(viewInsideWorld(v1, W, H), 'panned view inside extent');
    await page.waitForTimeout(120);
    check((await page.evaluate(() => window.__clicks.length)) === 0, 'drag does not fire the country callback');
    await page.mouse.move(sx - 400, sy - 200); await page.mouse.down();
    await page.mouse.move(sx + 3000, sy + 3000, { steps: 4 });
    await page.mouse.up();
    check(viewInsideWorld(await vb(page), W, H), 'huge drag still clamped inside extent');
    { const a = await vb(page); await page.mouse.move(sx, sy); await page.mouse.move(sx + 50, sy + 50); const b = await vb(page);
      check(JSON.stringify(a) === JSON.stringify(b), 'moving with no button down after an off-window release does not pan'); }

    // pick a big country under a known screen point to click
    await page.evaluate(() => window.__map.resetZoom()); await settle(page);
    const target = await page.evaluate(() => {
      const d = window.GeoApp.data; let best = null, ba = 0;
      for (const e of d.entities) { const a = (e.bbox[2] - e.bbox[0]) * (e.bbox[3] - e.bbox[1]); if (a > ba) { ba = a; best = e; } }
      return { id: best.id, label: best.label };
    });
    const tp = await vbToScreen(page, target.label[0], target.label[1]);
    const hit = await page.evaluate(([x, y]) => { const el = document.elementFromPoint(x, y); return el && el.getAttribute('data-id'); }, [tp.x, tp.y]);
    await page.mouse.move(tp.x, tp.y); await page.mouse.down(); await page.mouse.move(tp.x + 2, tp.y + 1); await page.mouse.up();
    await page.waitForTimeout(100);
    const clicks = await page.evaluate(() => window.__clicks.slice());
    check(clicks.length === 1 && clicks[0] === hit && !!hit, `<4px press+release counts as click (${clicks.join(',')} vs hit ${hit})`);
    // press on country, drag far, release on same spot area -> no click
    await page.evaluate(() => { window.__clicks.length = 0; });
    await page.mouse.move(tp.x, tp.y); await page.mouse.down();
    await page.mouse.move(tp.x + 30, tp.y, { steps: 5 }); await page.mouse.move(tp.x, tp.y, { steps: 5 });
    await page.mouse.up(); await page.waitForTimeout(100);
    check((await page.evaluate(() => window.__clicks.length)) === 0, 'drag out and back (>4px) is not a click');

    // 5. hover
    await page.evaluate(() => window.__map.resetZoom()); await settle(page);
    const tp2 = await vbToScreen(page, target.label[0], target.label[1]);
    await page.mouse.move(2, 2); await page.mouse.move(tp2.x, tp2.y);
    const hov = await page.evaluate(() => Array.from(document.querySelectorAll('.is-hover')).map((e) => e.getAttribute('data-id')));
    check(hov.length === 1 && hov[0] === hit, `hover marks exactly the hovered path (${hov})`);
    await page.mouse.move(r.left + 1, r.top + 1);
    await page.mouse.move(2, 2);
    check((await page.evaluate(() => document.querySelectorAll('.is-hover').length)) === 0, 'hover cleared when pointer leaves');
    await page.mouse.move(tp2.x, tp2.y);
    await page.mouse.down(); await page.mouse.up(); await page.waitForTimeout(80);
    check((await page.evaluate(() => document.querySelectorAll('.is-hover').length)) === 0, 'nothing left highlighted after a click');
    await page.mouse.move(tp2.x + 1, tp2.y);
    await page.evaluate(() => window.__map.setInteractive(false));
    check((await page.evaluate(() => document.querySelectorAll('.is-hover').length)) === 0, 'nothing highlighted after setInteractive(false)');
    await page.mouse.move(tp2.x + 2, tp2.y + 1);
    check((await page.evaluate(() => document.querySelectorAll('.is-hover').length)) === 0, 'no hover highlight while non-interactive');
    await page.evaluate(() => { window.__clicks.length = 0; });
    await page.mouse.down(); await page.mouse.up(); await page.waitForTimeout(80);
    check((await page.evaluate(() => window.__clicks.length)) === 0, 'non-interactive map ignores clicks');
    await page.evaluate(() => window.__map.setInteractive(true));

    // 4. tiny islands (include-small data: all entities, quiz or not)
    const tinies = await page.evaluate(() => window.GeoApp.data.entities
      .map((e) => ({ id: e.id, name: e.name, area: (e.bbox[2] - e.bbox[0]) * (e.bbox[3] - e.bbox[1]), label: e.label, bbox: e.bbox }))
      .sort((a, b) => a.area - b.area).slice(0, 60));
    console.log('  (checking ' + tinies.length + ' smallest entities; smallest bbox area ' + tinies[0].area.toFixed(3) + ')');
    const tinyFails = [];
    const named = { Malta: 0, Bahrain: 0, 'Saint Pierre': 0 };
    for (const t of tinies) {
      for (const k in named) if ((t.name || '').indexOf(k) === 0) named[k]++;
      await page.evaluate(() => window.__map.resetZoom()); await settle(page);
      for (const [label, pt] of [['label', t.label]]) {
        const sp = await vbToScreen(page, pt[0], pt[1]);
        const got = await page.evaluate(([x, y]) => { const el = document.elementFromPoint(x, y); return el && el.getAttribute && el.getAttribute('data-id'); }, [sp.x, sp.y]);
        if (got !== t.id && label === 'label') tinyFails.push(`${t.id} (${t.name}) ${label}: hit ${got}`);
      }
    }
    // real click on a few of the very smallest, through the full event path
    await page.evaluate(() => { window.__clicks.length = 0; });
    const clickIds = [];
    for (const t of tinies.slice(0, 8)) {
      await page.evaluate(() => window.__map.resetZoom()); await settle(page);
      const sp = await vbToScreen(page, t.label[0], t.label[1]);
      await page.mouse.click(sp.x, sp.y);
      clickIds.push([t.id, (await page.evaluate(() => window.__clicks.splice(0)))[0]]);
    }
    for (const [want, got] of clickIds) if (want !== got) tinyFails.push(`real click ${want} -> ${got}`);
    check(tinyFails.length === 0, `tiny entities are clickable at world zoom${tinyFails.length ? ': ' + tinyFails.slice(0, 6).join('; ') : ''}`);
    // visual stroke untouched
    const strokes = await page.evaluate(() => {
      const el = document.querySelector('path.country');
      return { sw: getComputedStyle(el).strokeWidth, hits: document.querySelectorAll('path.hit').length, countries: document.querySelectorAll('path.country').length, total: window.GeoApp.data.entities.length };
    });
    check(parseFloat(strokes.sw) < 2, `visible stroke width unchanged (${strokes.sw})`);
    check(strokes.countries === strokes.total, 'exactly one visible path.country per entity');

    // 6. resize
    for (const [w, h] of [[900, 700], [600, 900], [1600, 500], [1400, 900]]) {
      await page.setViewportSize({ width: w, height: h });
      await page.waitForTimeout(150);
      const st = await page.evaluate(() => {
        const svg = document.querySelector('#map svg'); const rc = svg.getBoundingClientRect();
        const mr = document.getElementById('map').getBoundingClientRect();
        return { vb: window.__map.getViewBox(), w: rc.width, h: rc.height, mw: mr.width, mh: mr.height, attr: svg.getAttribute('viewBox') };
      });
      const attrOk = st.attr.split(/\s+/).map(Number).every(Number.isFinite);
      check(viewInsideWorld(st.vb, W, H) && attrOk && st.w > 0 && st.h > 0 &&
        st.w <= st.mw + 1 && st.h <= st.mh + 1, `resize ${w}x${h}: viewBox valid, svg fits container (${st.w.toFixed(0)}x${st.h.toFixed(0)})`);
    }
    await page.evaluate(() => window.__map.resetZoom()); await settle(page);
    // after resize, wheel-zoom anchoring still correct
    {
      const rr = await mapRect(page);
      const px = rr.left + rr.width * 0.3, py = rr.top + rr.height * 0.6;
      const b = await screenToVb(page, px, py);
      await page.mouse.move(px, py); await page.mouse.wheel(0, -300); await page.waitForTimeout(80);
      const a = await screenToVb(page, px, py);
      check(near(a.x, b.x, 0.5) && near(a.y, b.y, 0.5), 'cursor anchoring correct after resize');
    }
    await dctx.close();

    // ======================= MOBILE =======================
    console.log('Mobile 390x844 (touch)');
    const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    const mp = await mctx.newPage();
    hook(mp, 'mobile');
    await mp.goto(url);
    await mp.waitForFunction(() => window.GeoApp && window.GeoApp.map && document.querySelector('path.country'));
    await installProbeMap(mp);
    const cdp = await mctx.newCDPSession(mp);
    // zoom in a little so there is room to pan
    await mp.evaluate(() => window.__map.zoomBy(2.5)); await settle(mp);
    let mr = await mapRect(mp);
    let m0 = await vb(mp);
    const ax = mr.left + mr.width / 2, ay = mr.top + mr.height / 2;

    // one-finger pan
    await touch(cdp, 'touchStart', [{ x: ax, y: ay }]);
    for (let i = 1; i <= 8; i++) await touch(cdp, 'touchMove', [{ x: ax + i * 8, y: ay + i * 4 }]);
    await touch(cdp, 'touchEnd', []);
    let m1 = await vb(mp);
    check(Math.abs(m1[0] - m0[0]) > 1 || Math.abs(m1[1] - m0[1]) > 1, `one-finger drag pans (${m0[0].toFixed(1)},${m0[1].toFixed(1)} -> ${m1[0].toFixed(1)},${m1[1].toFixed(1)})`);
    check(near(m1[2], m0[2], 1e-9) && viewInsideWorld(m1, W, H), 'touch pan keeps zoom and stays inside extent');
    await mp.waitForTimeout(150);
    check((await mp.evaluate(() => window.__clicks.length)) === 0, 'touch drag does not fire the country callback');

    // tap (and tiny jitter) = click
    await mp.evaluate(() => window.__map.resetZoom()); await settle(mp);
    const mt = await mp.evaluate(() => {
      const d = window.GeoApp.data; let best = null, ba = 0;
      for (const e of d.entities) { const a = (e.bbox[2] - e.bbox[0]) * (e.bbox[3] - e.bbox[1]); if (a > ba) { ba = a; best = e; } }
      return { id: best.id, label: best.label };
    });
    const mtp = await vbToScreen(mp, mt.label[0], mt.label[1]);
    const mhit = await mp.evaluate(([x, y]) => { const el = document.elementFromPoint(x, y); return el && el.getAttribute('data-id'); }, [mtp.x, mtp.y]);
    await touch(cdp, 'touchStart', [{ x: mtp.x, y: mtp.y }]);
    await touch(cdp, 'touchMove', [{ x: mtp.x + 2, y: mtp.y + 1 }]);
    await touch(cdp, 'touchEnd', []);
    await mp.waitForTimeout(150);
    const mclicks = await mp.evaluate(() => window.__clicks.splice(0));
    check(mclicks.length === 1 && mclicks[0] === mhit, `tap (<4px jitter) fires callback (${mclicks} vs ${mhit})`);
    check((await mp.evaluate(() => document.querySelectorAll('.is-hover').length)) === 0, 'tap leaves no hover highlight');
    await settle(mp);

    // pinch
    await mp.evaluate(() => window.__map.resetZoom()); await settle(mp);
    await mp.evaluate(() => { window.__clicks.length = 0; });
    mr = await mapRect(mp);
    const px = mr.left + mr.width / 2, py = mr.top + mr.height / 2;
    const anchorBefore = await screenToVb(mp, px, py);
    const wBefore = (await vb(mp))[2];
    await touch(cdp, 'touchStart', [{ x: px - 30, y: py, id: 0 }, { x: px + 30, y: py, id: 1 }]);
    for (let i = 1; i <= 10; i++) {
      await touch(cdp, 'touchMove', [{ x: px - 30 - i * 8, y: py, id: 0 }, { x: px + 30 + i * 8, y: py, id: 1 }]);
    }
    await touch(cdp, 'touchEnd', []);
    const pv = await vb(mp);
    check(pv[2] < wBefore * 0.6, `pinch out zooms in (width ${wBefore.toFixed(1)} -> ${pv[2].toFixed(1)})`);
    const anchorAfter = await screenToVb(mp, px, py);
    check(near(anchorBefore.x, anchorAfter.x, 2) && near(anchorBefore.y, anchorAfter.y, 2), 'pinch keeps the midpoint world position');
    check(viewInsideWorld(pv, W, H), 'pinched view inside extent');
    await mp.waitForTimeout(200);
    check((await mp.evaluate(() => window.__clicks.length)) === 0, 'pinch does not fire a country click');
    // pinch in zooms back out and clamps
    await touch(cdp, 'touchStart', [{ x: px - 120, y: py, id: 0 }, { x: px + 120, y: py, id: 1 }]);
    for (let i = 1; i <= 12; i++) {
      await touch(cdp, 'touchMove', [{ x: px - 120 + i * 9, y: py, id: 0 }, { x: px + 120 - i * 9, y: py, id: 1 }]);
    }
    await touch(cdp, 'touchEnd', []);
    const pv2 = await vb(mp);
    check(pv2[2] > pv[2] * 1.5 && viewInsideWorld(pv2, W, H), `pinch in zooms out (${pv[2].toFixed(1)} -> ${pv2[2].toFixed(1)})`);
    // after pinch the map is still pannable/tappable (state not stuck)
    const pv3 = await vb(mp);
    await touch(cdp, 'touchStart', [{ x: px, y: py }]);
    for (let i = 1; i <= 6; i++) await touch(cdp, 'touchMove', [{ x: px - i * 10, y: py }]);
    await touch(cdp, 'touchEnd', []);
    const pv4 = await vb(mp);
    check(pv4[0] > pv3[0] + 0.5 || pv4[0] + pv4[2] >= W - 1e-6, 'one-finger pan still works after a pinch');

    // tiny island tappable on mobile
    await mp.evaluate(() => { window.__map.resetZoom(); window.__clicks.length = 0; }); await settle(mp);
    const tiny = tinies[0];
    const tsp = await vbToScreen(mp, tiny.label[0], tiny.label[1]);
    await mp.touchscreen.tap(tsp.x, tsp.y);
    await mp.waitForTimeout(150);
    const tc = await mp.evaluate(() => window.__clicks.splice(0));
    check(tc[0] === tiny.id, `tiny entity ${tiny.id} tappable on mobile (got ${tc})`);

    // resize / rotate
    await mp.setViewportSize({ width: 844, height: 390 });
    await mp.waitForTimeout(200);
    const rv = await vb(mp);
    check(viewInsideWorld(rv, W, H), 'rotate to landscape: viewBox valid');
    await mp.setViewportSize({ width: 390, height: 844 });
    await mp.waitForTimeout(200);
    check(viewInsideWorld(await vb(mp), W, H), 'rotate back: viewBox valid');
    await mctx.close();
  } finally {
    await browser.close();
    server.close();
  }

  // 7. console cleanliness
  check(errors.length === 0, 'no console errors / page errors' + (errors.length ? ': ' + errors.slice(0, 5).join(' | ') : ''));

  if (failures) { console.log('\n' + failures + ' check(s) FAILED'); process.exit(1); }
  console.log('\nAll map interaction checks passed.');
}

main().catch((e) => { console.error(e); process.exit(1); });
