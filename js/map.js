// js/map.js — window.GeoMap: SVG map renderer for the 1940 world map quiz.
// Classic script, no ES modules, no external libraries. See docs/SPEC.md section 2.
(function () {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var MIN_ZOOM = 1;    // multiple of full-extent width
  var MAX_ZOOM = 12;
  var ZOOM_ANIM_MS = 350;
  var FLASH_MS = 1000;
  var DRAG_THRESHOLD = 4; // px, beyond this a pointerdown->pointerup is a drag, not a click
  var DBLCLICK_ZOOM_FACTOR = 1.6;
  var TINY_BBOX = 8;   // viewBox units: entities with both bbox sides <= this get a hit stroke
  var HIT_PX = 14;     // screen px width of the invisible hit stroke

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  // Cubic ease-in-out, used for animated zoom/pan transitions.
  function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  function unionBBox(a, b) {
    if (!a) return b.slice();
    return [
      Math.min(a[0], b[0]),
      Math.min(a[1], b[1]),
      Math.max(a[2], b[2]),
      Math.max(a[3], b[3])
    ];
  }

  function create(containerEl, data, opts) {
    opts = opts || {};
    var onClick = typeof opts.onClick === 'function' ? opts.onClick : function () {};
    var onHover = typeof opts.onHover === 'function' ? opts.onHover : function () {};

    var meta = data.meta || {};
    var W = meta.width;
    var H = meta.height;
    var fullExtent = [0, 0, W, H];

    // --- Build DOM once, via a DocumentFragment. ---
    containerEl.className = containerEl.className
      ? containerEl.className + ' geomap'
      : 'geomap';
    // Ensure exact class token present even if containerEl already had classes.
    if (!/\bgeomap\b/.test(containerEl.className)) {
      containerEl.className += ' geomap';
    }

    var frag = document.createDocumentFragment();

    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'geomap-svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svg.setAttribute('role', 'img');
    svg.style.width = '100%';
    svg.style.height = '100%';
    svg.style.display = 'block';
    svg.style.touchAction = 'none';
    svg.style.cursor = 'grab';

    var ocean = document.createElementNS(SVG_NS, 'rect');
    ocean.setAttribute('class', 'ocean');
    ocean.setAttribute('x', '0');
    ocean.setAttribute('y', '0');
    ocean.setAttribute('width', String(W));
    ocean.setAttribute('height', String(H));
    svg.appendChild(ocean);

    var g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('class', 'countries');
    svg.appendChild(g);

    // id -> { entity, pathEl, state }
    var entityMap = Object.create(null);
    var entities = data.entities || [];
    var pathFrag = document.createDocumentFragment();
    for (var i = 0; i < entities.length; i++) {
      var ent = entities[i];
      var path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('class', 'country');
      path.setAttribute('data-id', ent.id);
      path.setAttribute('d', ent.path);
      path.setAttribute('vector-effect', 'non-scaling-stroke');
      // Deliberately no <title>/tooltip: it must not leak the country name.
      pathFrag.appendChild(path);
      entityMap[ent.id] = { entity: ent, pathEl: path, state: null };
    }
    g.appendChild(pathFrag);

    // Tiny territories (Malta, Bahrain, ...) are only a pixel or two wide at
    // world zoom. Give them an invisible, non-scaling hit stroke (drawn
    // beneath the visible paths, in its own group) so they have a minimum ~HIT_PX pointer target
    // without changing the visible stroke. Hits carry the same data-id.
    var hitG = document.createElementNS(SVG_NS, 'g');
    hitG.setAttribute('class', 'hit-targets');
    var hitFrag = document.createDocumentFragment();
    for (var hi = 0; hi < entities.length; hi++) {
      var he = entities[hi];
      var bb = he.bbox;
      if (!bb || Math.max(bb[2] - bb[0], bb[3] - bb[1]) > TINY_BBOX) continue;
      var hp = document.createElementNS(SVG_NS, 'path');
      hp.setAttribute('class', 'hit');
      hp.setAttribute('data-id', he.id);
      hp.setAttribute('d', he.path);
      hp.setAttribute('vector-effect', 'non-scaling-stroke');
      hp.setAttribute('fill', 'none');
      hp.setAttribute('stroke', 'transparent');
      hp.setAttribute('stroke-width', String(HIT_PX));
      hp.setAttribute('stroke-linejoin', 'round');
      hp.style.pointerEvents = 'all';
      hp.style.cursor = 'pointer';
      hitFrag.appendChild(hp);
    }
    hitG.appendChild(hitFrag);
    g.insertBefore(hitG, g.firstChild); // beneath the visible paths: never steals a neighbour's click

    frag.appendChild(svg);
    containerEl.appendChild(frag);

    // --- View state: current viewBox as [x, y, w, h]. ---
    var view = fullExtent.slice();
    var interactive = true;
    var destroyed = false;

    function applyViewBox() {
      svg.setAttribute('viewBox', view[0] + ' ' + view[1] + ' ' + view[2] + ' ' + view[3]);
    }

    function clampView(v) {
      var w = clamp(v[2], W / MAX_ZOOM, W / MIN_ZOOM);
      var h = w * (H / W);
      var cx = v[0] + v[2] / 2;
      var cy = v[1] + v[3] / 2;
      var x = cx - w / 2;
      var y = cy - h / 2;
      // Clamp so the viewBox stays within the full extent.
      if (w >= W) {
        x = (W - w) / 2;
      } else {
        x = clamp(x, 0, W - w);
      }
      if (h >= H) {
        y = (H - h) / 2;
      } else {
        y = clamp(y, 0, H - h);
      }
      return [x, y, w, h];
    }

    // --- Animated transition from current view to a target view. ---
    var animRAF = null;
    var animTarget = null; // destination of the in-flight animation, if any
    function animateTo(target, ms) {
      if (animRAF) {
        cancelAnimationFrame(animRAF);
        animRAF = null;
      }
      var start = view.slice();
      target = clampView(target);
      animTarget = target.slice();
      var t0 = null;
      var duration = ms == null ? ZOOM_ANIM_MS : ms;
      if (duration <= 0) {
        view = target;
        animTarget = null;
        applyViewBox();
        return;
      }
      function step(ts) {
        if (t0 === null) t0 = ts;
        var t = clamp((ts - t0) / duration, 0, 1);
        var e = easeInOutCubic(t);
        view = [
          start[0] + (target[0] - start[0]) * e,
          start[1] + (target[1] - start[1]) * e,
          start[2] + (target[2] - start[2]) * e,
          start[3] + (target[3] - start[3]) * e
        ];
        applyViewBox();
        if (t < 1) {
          animRAF = requestAnimationFrame(step);
        } else {
          animRAF = null;
          animTarget = null;
        }
      }
      animRAF = requestAnimationFrame(step);
    }

    function bboxToView(bbox, padding) {
      var x0 = bbox[0], y0 = bbox[1], x1 = bbox[2], y1 = bbox[3];
      var bw = Math.max(x1 - x0, 0.0001);
      var bh = Math.max(y1 - y0, 0.0001);
      var pad = padding == null ? 0.08 : padding;
      var padX = bw * pad;
      var padY = bh * pad;
      x0 -= padX; x1 += padX;
      y0 -= padY; y1 += padY;
      bw = x1 - x0;
      bh = y1 - y0;
      var cx = (x0 + x1) / 2;
      var cy = (y0 + y1) / 2;
      // Fit bbox into the aspect ratio of the full extent (W:H), whichever
      // dimension is the limiting one.
      var aspect = W / H;
      var w, h;
      if (bw / bh > aspect) {
        w = bw;
        h = w / aspect;
      } else {
        h = bh;
        w = h * aspect;
      }
      return clampView([cx - w / 2, cy - h / 2, w, h]);
    }

    // --- Public: state management ---
    function setState(id, state) {
      var rec = entityMap[id];
      if (!rec) return;
      var cls = rec.pathEl.className.baseVal || '';
      cls = cls.replace(/\bstate-\S+/g, '').replace(/\s+/g, ' ').trim();
      if (state) {
        cls = (cls ? cls + ' ' : '') + 'state-' + state;
      }
      rec.pathEl.setAttribute('class', cls);
      rec.state = state || null;
    }

    function getState(id) {
      var rec = entityMap[id];
      return rec ? rec.state : null;
    }

    function clearStates() {
      for (var id in entityMap) {
        if (Object.prototype.hasOwnProperty.call(entityMap, id)) {
          setState(id, null);
        }
      }
    }

    var flashTimers = Object.create(null);
    function flash(id) {
      var rec = entityMap[id];
      if (!rec) return;
      var cls = rec.pathEl.className.baseVal || '';
      if (!/\bflash\b/.test(cls)) {
        rec.pathEl.setAttribute('class', cls + (cls ? ' ' : '') + 'flash');
      }
      if (flashTimers[id]) {
        clearTimeout(flashTimers[id]);
      }
      flashTimers[id] = setTimeout(function () {
        var rec2 = entityMap[id];
        if (!rec2) return;
        var c = rec2.pathEl.className.baseVal || '';
        c = c.replace(/\bflash\b/g, '').replace(/\s+/g, ' ').trim();
        rec2.pathEl.setAttribute('class', c);
        delete flashTimers[id];
      }, FLASH_MS);
    }

    var hintId = null;
    function setHint(id) {
      if (hintId != null) {
        var prev = entityMap[hintId];
        if (prev) {
          var pc = prev.pathEl.className.baseVal || '';
          pc = pc.replace(/\bhint\b/g, '').replace(/\s+/g, ' ').trim();
          prev.pathEl.setAttribute('class', pc);
        }
      }
      hintId = id || null;
      if (hintId != null) {
        var rec = entityMap[hintId];
        if (rec) {
          var cls = rec.pathEl.className.baseVal || '';
          if (!/\bhint\b/.test(cls)) {
            rec.pathEl.setAttribute('class', cls + (cls ? ' ' : '') + 'hint');
          }
        }
      }
    }

    // --- Public: zoom / pan ---
    function zoomToBBox(bbox, padding) {
      animateTo(bboxToView(bbox, padding));
    }

    function zoomToRegion(regionId) {
      if (regionId === 'world' || !regionId) {
        animateTo(fullExtent.slice());
        return;
      }
      var bbox = null;
      var regions = (data && data.regions) || [];
      for (var r = 0; r < regions.length; r++) {
        if (regions[r].id === regionId && regions[r].bbox) {
          animateTo(bboxToView(regions[r].bbox, 0.03));
          return;
        }
      }
      for (var i = 0; i < entities.length; i++) {
        if (entities[i].region === regionId && entities[i].bbox) {
          bbox = unionBBox(bbox, entities[i].bbox);
        }
      }
      if (!bbox) {
        animateTo(fullExtent.slice());
        return;
      }
      animateTo(bboxToView(bbox, 0.08));
    }

    function resetZoom() {
      animateTo(fullExtent.slice());
    }

    function zoomAroundPoint(factor, px, py) {
      // px, py in viewBox units — the fixed point under cursor/centre.
      var v = view;
      var newW = clamp(v[2] / factor, W / MAX_ZOOM, W / MIN_ZOOM);
      var newH = newW * (H / W);
      var fx = (px - v[0]) / v[2]; // fraction across current view
      var fy = (py - v[1]) / v[3];
      var nx = px - fx * newW;
      var ny = py - fy * newH;
      view = clampView([nx, ny, newW, newH]);
      applyViewBox();
    }

    function zoomBy(factor) {
      // Rapid presses compound on the in-flight destination, not the
      // half-animated view.
      var base = animTarget || view;
      var cx = base[0] + base[2] / 2;
      var cy = base[1] + base[3] / 2;
      var newW = clamp(base[2] / factor, W / MAX_ZOOM, W / MIN_ZOOM);
      var newH = newW * (H / W);
      animateTo([cx - newW / 2, cy - newH / 2, newW, newH]);
    }

    function setInteractive(v) {
      interactive = !!v;
      if (!interactive) clearHover();
    }

    // --- Coordinate helpers ---
    function clientToViewBox(clientX, clientY) {
      var rect = svg.getBoundingClientRect();
      var scale = Math.min(rect.width / view[2], rect.height / view[3]);
      var dispW = view[2] * scale;
      var dispH = view[3] * scale;
      var offX = (rect.width - dispW) / 2;
      var offY = (rect.height - dispH) / 2;
      var localX = clientX - rect.left - offX;
      var localY = clientY - rect.top - offY;
      var vx = view[0] + (localX / scale);
      var vy = view[1] + (localY / scale);
      return { x: vx, y: vy, scale: scale, rect: rect, offX: offX, offY: offY };
    }

    function getLabelScreenPoint(id) {
      var rec = entityMap[id];
      if (!rec) return null;
      var label = rec.entity.label;
      var rect = svg.getBoundingClientRect();
      var scale = Math.min(rect.width / view[2], rect.height / view[3]);
      var dispW = view[2] * scale;
      var dispH = view[3] * scale;
      var offX = (rect.width - dispW) / 2;
      var offY = (rect.height - dispH) / 2;
      var x = rect.left + offX + (label[0] - view[0]) * scale;
      var y = rect.top + offY + (label[1] - view[1]) * scale;
      return { x: x, y: y };
    }

    function getViewBox() {
      return view.slice();
    }

    // --- Interaction: wheel zoom ---
    function onWheel(e) {
      if (destroyed) return;
      e.preventDefault();
      var pt = clientToViewBox(e.clientX, e.clientY);
      var dy = e.deltaY;
      if (e.deltaMode === 1) dy *= 16; else if (e.deltaMode === 2) dy *= 400;
      var factor = Math.exp(-clamp(dy, -200, 200) * 0.0025);
      if (animRAF) { cancelAnimationFrame(animRAF); animRAF = null; animTarget = null; }
      zoomAroundPoint(factor, pt.x, pt.y);
    }
    svg.addEventListener('wheel', onWheel, { passive: false });

    // --- Interaction: drag to pan, pinch to zoom, click-vs-drag detection ---
    var pointers = Object.create(null); // pointerId -> {x, y} (client px)
    var dragState = null; // { pointerId, startClientX, startClientY, startView, moved, captured }
    var pinch = null;     // { ids:[a,b], startDist, startView, anchorX, anchorY }

    function pointerIds() { return Object.keys(pointers); }
    function tryCapture(id) {
      try { svg.setPointerCapture(id); } catch (err) { /* ignore */ }
    }
    function tryRelease(id) {
      try { svg.releasePointerCapture(id); } catch (err) { /* ignore */ }
    }
    function nowMs() { return typeof performance !== 'undefined' ? performance.now() : Date.now(); }

    function startPinch() {
      var ids = pointerIds();
      if (ids.length < 2) return;
      var a = pointers[ids[0]], b = pointers[ids[1]];
      var mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      if (animRAF) { cancelAnimationFrame(animRAF); animRAF = null; animTarget = null; }
      // A drag turning into a pinch must not count as a click later.
      if (dragState) { dragState.moved = true; }
      tryCapture(Number(ids[0])); tryCapture(Number(ids[1]));
      var anchor = clientToViewBox(mid.x, mid.y);
      pinch = {
        ids: [ids[0], ids[1]],
        startDist: Math.max(Math.hypot(a.x - b.x, a.y - b.y), 1),
        startView: view.slice(),
        anchorX: anchor.x,
        anchorY: anchor.y
      };
    }

    function updatePinch() {
      var a = pointers[pinch.ids[0]], b = pointers[pinch.ids[1]];
      if (!a || !b) return;
      var dist = Math.max(Math.hypot(a.x - b.x, a.y - b.y), 1);
      var mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      var sv = pinch.startView;
      var newW = clamp(sv[2] * pinch.startDist / dist, W / MAX_ZOOM, W / MIN_ZOOM);
      var newH = newW * (H / W);
      // Keep the world point first pinched under the fingers' midpoint.
      var rect = svg.getBoundingClientRect();
      var scale = Math.min(rect.width / newW, rect.height / newH);
      var offX = (rect.width - newW * scale) / 2;
      var offY = (rect.height - newH * scale) / 2;
      var nx = pinch.anchorX - (mid.x - rect.left - offX) / scale;
      var ny = pinch.anchorY - (mid.y - rect.top - offY) / scale;
      view = clampView([nx, ny, newW, newH]);
      applyViewBox();
    }

    function endPinch() {
      if (!pinch) return;
      pinch = null;
      suppressClickUntil = nowMs() + 100;
      // Continue as a one-finger pan with any remaining pointer.
      var rest = pointerIds();
      dragState = null;
      if (rest.length === 1) {
        var p = pointers[rest[0]];
        dragState = {
          pointerId: Number(rest[0]), startClientX: p.x, startClientY: p.y,
          startView: view.slice(), moved: true, captured: true
        };
      } else {
        svg.style.cursor = 'grab';
      }
    }

    function onPointerDown(e) {
      if (destroyed) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      clearHover();
      pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
      if (animRAF) { cancelAnimationFrame(animRAF); animRAF = null; animTarget = null; }
      if (pointerIds().length >= 2) {
        if (!pinch) startPinch();
        return;
      }
      dragState = {
        pointerId: e.pointerId,
        startClientX: e.clientX,
        startClientY: e.clientY,
        startView: view.slice(),
        moved: false,
        captured: false
      };
      // Pointer capture is deliberately NOT taken here: capturing on
      // pointerdown makes Chromium retarget the synthetic 'click' to the
      // <svg> instead of the country <path>. We capture once a real drag
      // has started (see onPointerMove).
      svg.style.cursor = 'grabbing';
    }

    function onPointerMove(e) {
      if (destroyed) return;
      // Mouse button released outside the window/iframe: the pointerup never
      // arrived, so end the stuck drag instead of panning with no button down.
      if (e.pointerType === 'mouse' && e.buttons === 0 && (dragState || pointers[e.pointerId])) {
        onPointerCancel(e);
        return;
      }
      if (pointers[e.pointerId]) {
        pointers[e.pointerId].x = e.clientX;
        pointers[e.pointerId].y = e.clientY;
      }
      if (pinch) { updatePinch(); return; }
      if (!dragState || e.pointerId !== dragState.pointerId) return;
      var dxClient = e.clientX - dragState.startClientX;
      var dyClient = e.clientY - dragState.startClientY;
      if (!dragState.moved && Math.sqrt(dxClient * dxClient + dyClient * dyClient) > DRAG_THRESHOLD) {
        dragState.moved = true;
        clearHover();
        if (!dragState.captured) {
          tryCapture(e.pointerId);
          dragState.captured = true;
        }
      }
      if (!dragState.moved) return;
      var rect = svg.getBoundingClientRect();
      var scale = Math.min(rect.width / dragState.startView[2], rect.height / dragState.startView[3]);
      if (scale <= 0) return;
      var v = dragState.startView;
      view = clampView([v[0] - dxClient / scale, v[1] - dyClient / scale, v[2], v[3]]);
      applyViewBox();
    }

    function inPinch(id) { return pinch && (id + '' === pinch.ids[0] || id + '' === pinch.ids[1]); }

    function onPointerUp(e) {
      if (destroyed) return;
      var had = !!pointers[e.pointerId];
      delete pointers[e.pointerId];
      if (inPinch(e.pointerId)) {
        tryRelease(e.pointerId);
        endPinch();
        return;
      }
      if (!had || !dragState || e.pointerId !== dragState.pointerId) return;
      var wasDrag = dragState.moved;
      if (dragState.captured) tryRelease(e.pointerId);
      svg.style.cursor = 'grab';
      dragState = null;
      // The browser still fires a native click after a drag; suppress it.
      if (wasDrag) suppressClickUntil = nowMs() + 50;
    }

    function onPointerCancel(e) {
      delete pointers[e.pointerId];
      if (inPinch(e.pointerId)) {
        tryRelease(e.pointerId);
        endPinch();
        return;
      }
      if (!dragState || e.pointerId !== dragState.pointerId) return;
      if (dragState.captured) tryRelease(e.pointerId);
      svg.style.cursor = 'grab';
      dragState = null;
    }

    svg.addEventListener('pointerdown', onPointerDown);
    svg.addEventListener('pointermove', onPointerMove);
    svg.addEventListener('pointerup', onPointerUp);
    svg.addEventListener('pointercancel', onPointerCancel);

    // --- Interaction: double-click zoom ---
    function onDblClick(e) {
      if (destroyed || !interactive) return;
      var pt = clientToViewBox(e.clientX, e.clientY);
      if (animRAF) { cancelAnimationFrame(animRAF); animRAF = null; animTarget = null; }
      zoomAroundPoint(DBLCLICK_ZOOM_FACTOR, pt.x, pt.y);
    }
    svg.addEventListener('dblclick', onDblClick);

    // --- Click dispatch: single delegated listener on the countries group. ---
    var suppressClickUntil = 0;
    function onClickDelegated(e) {
      if (destroyed) return;
      var now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      if (now < suppressClickUntil) return;
      if (!interactive) return;
      var target = e.target;
      if (!target || !target.getAttribute) return;
      var id = target.getAttribute('data-id');
      if (!id) return;
      clearHover();
      onClick(id);
    }
    g.addEventListener('click', onClickDelegated);

    // --- Hover dispatch ---
    // Also toggles an "is-hover" class on the hovered path (mouse/pen only),
    // so styling does not stick after a touch tap like CSS :hover does.
    var hoveredId = null;
    function setHoverClass(id, on) {
      var rec = id != null ? entityMap[id] : null;
      if (!rec) return;
      var cls = rec.pathEl.className.baseVal || '';
      var has = /\bis-hover\b/.test(cls);
      if (on && !has) rec.pathEl.setAttribute('class', cls + (cls ? ' ' : '') + 'is-hover');
      else if (!on && has) rec.pathEl.setAttribute('class', cls.replace(/\bis-hover\b/g, '').replace(/\s+/g, ' ').trim());
    }
    function clearHover() {
      if (hoveredId !== null) {
        setHoverClass(hoveredId, false);
        hoveredId = null;
        onHover(null);
      }
    }
    function onPointerOver(e) {
      if (destroyed || e.pointerType === 'touch') return;
      var target = e.target;
      if (!target || !target.getAttribute) return;
      var id = target.getAttribute('data-id');
      if (!id) return;
      if (id !== hoveredId) {
        if (hoveredId !== null) setHoverClass(hoveredId, false);
        hoveredId = id;
        if (interactive) setHoverClass(id, true);
        onHover(id);
      }
    }
    function onPointerOut(e) {
      if (destroyed) return;
      var related = e.relatedTarget;
      // Moving between a path and its own hit stroke keeps the hover.
      if (related && related.getAttribute && hoveredId !== null &&
          related.getAttribute('data-id') === hoveredId) return;
      if (related && g.contains(related)) return; // next pointerover updates it
      clearHover();
    }
    g.addEventListener('pointerover', onPointerOver);
    g.addEventListener('pointerout', onPointerOut);

    // --- Destroy ---
    function destroy() {
      if (destroyed) return;
      destroyed = true;
      if (animRAF) {
        cancelAnimationFrame(animRAF);
        animRAF = null;
      }
      for (var id in flashTimers) {
        if (Object.prototype.hasOwnProperty.call(flashTimers, id)) {
          clearTimeout(flashTimers[id]);
        }
      }
      svg.removeEventListener('wheel', onWheel);
      svg.removeEventListener('pointerdown', onPointerDown);
      svg.removeEventListener('pointermove', onPointerMove);
      svg.removeEventListener('pointerup', onPointerUp);
      svg.removeEventListener('pointercancel', onPointerCancel);
      svg.removeEventListener('dblclick', onDblClick);
      g.removeEventListener('click', onClickDelegated);
      g.removeEventListener('pointerover', onPointerOver);
      g.removeEventListener('pointerout', onPointerOut);
      if (svg.parentNode) {
        svg.parentNode.removeChild(svg);
      }
      containerEl.className = containerEl.className
        .replace(/\bgeomap\b/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    }

    return {
      setState: setState,
      getState: getState,
      clearStates: clearStates,
      flash: flash,
      setHint: setHint,
      zoomToBBox: zoomToBBox,
      zoomToRegion: zoomToRegion,
      resetZoom: resetZoom,
      zoomBy: zoomBy,
      setInteractive: setInteractive,
      getLabelScreenPoint: getLabelScreenPoint,
      getViewBox: getViewBox,
      destroy: destroy
    };
  }

  var GeoMap = {
    version: '1.0.0',
    create: create
  };

  window.GeoMap = GeoMap;
})();
