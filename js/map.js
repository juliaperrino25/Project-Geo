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
    function animateTo(target, ms) {
      if (animRAF) {
        cancelAnimationFrame(animRAF);
        animRAF = null;
      }
      var start = view.slice();
      var t0 = null;
      var duration = ms == null ? ZOOM_ANIM_MS : ms;
      if (duration <= 0) {
        view = clampView(target);
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
      var cx = view[0] + view[2] / 2;
      var cy = view[1] + view[3] / 2;
      animateTo((function () {
        var newW = clamp(view[2] / factor, W / MAX_ZOOM, W / MIN_ZOOM);
        var newH = newW * (H / W);
        return clampView([cx - newW / 2, cy - newH / 2, newW, newH]);
      })());
    }

    function setInteractive(v) {
      interactive = !!v;
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
      var factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      if (animRAF) { cancelAnimationFrame(animRAF); animRAF = null; }
      zoomAroundPoint(factor, pt.x, pt.y);
    }
    svg.addEventListener('wheel', onWheel, { passive: false });

    // --- Interaction: drag to pan, click-vs-drag detection ---
    var dragState = null; // { pointerId, startClientX, startClientY, startView, moved, targetId }

    function onPointerDown(e) {
      if (destroyed) return;
      if (e.button != null && e.button !== 0) return;
      var targetId = e.target && e.target.getAttribute ? e.target.getAttribute('data-id') : null;
      dragState = {
        pointerId: e.pointerId,
        startClientX: e.clientX,
        startClientY: e.clientY,
        startView: view.slice(),
        moved: false,
        captured: false,
        targetId: targetId
      };
      // Note: pointer capture is deliberately NOT taken here. Capturing
      // immediately on pointerdown causes Chromium to retarget the
      // subsequent synthetic 'click' event to the capturing element (the
      // <svg>) instead of the country <path> under the cursor, which would
      // break plain click detection. We only capture once a real drag has
      // started (see onPointerMove).
      svg.style.cursor = 'grabbing';
    }

    function onPointerMove(e) {
      if (destroyed || !dragState || e.pointerId !== dragState.pointerId) return;
      var dxClient = e.clientX - dragState.startClientX;
      var dyClient = e.clientY - dragState.startClientY;
      if (!dragState.moved && Math.sqrt(dxClient * dxClient + dyClient * dyClient) > DRAG_THRESHOLD) {
        dragState.moved = true;
        if (!dragState.captured) {
          try {
            svg.setPointerCapture(e.pointerId);
            dragState.captured = true;
          } catch (err) { /* ignore */ }
        }
      }
      if (!dragState.moved) return;
      var rect = svg.getBoundingClientRect();
      var scale = Math.min(rect.width / dragState.startView[2], rect.height / dragState.startView[3]);
      if (scale <= 0) return;
      var dx = dxClient / scale;
      var dy = dyClient / scale;
      var v = dragState.startView;
      view = clampView([v[0] - dx, v[1] - dy, v[2], v[3]]);
      applyViewBox();
    }

    function onPointerUp(e) {
      if (destroyed || !dragState || e.pointerId !== dragState.pointerId) return;
      var wasDrag = dragState.moved;
      if (dragState.captured) {
        try {
          svg.releasePointerCapture(e.pointerId);
        } catch (err) { /* ignore */ }
      }
      svg.style.cursor = 'grab';
      dragState = null;
      // Click handling happens on the delegated 'click' listener below, but we
      // must suppress it when this was a drag. We do this by flagging a short
      // "suppress next click" window, since browsers fire a native click after
      // pointerup/mouseup even after a drag.
      if (wasDrag) {
        suppressClickUntil = (typeof performance !== 'undefined' ? performance.now() : Date.now()) + 50;
      }
    }

    function onPointerCancel(e) {
      if (!dragState || e.pointerId !== dragState.pointerId) return;
      if (dragState.captured) {
        try {
          svg.releasePointerCapture(e.pointerId);
        } catch (err) { /* ignore */ }
      }
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
      if (animRAF) { cancelAnimationFrame(animRAF); animRAF = null; }
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
      onClick(id);
    }
    g.addEventListener('click', onClickDelegated);

    // --- Hover dispatch ---
    var hoveredId = null;
    function onPointerOver(e) {
      if (destroyed) return;
      var target = e.target;
      if (!target || !target.getAttribute) return;
      var id = target.getAttribute('data-id');
      if (!id) return;
      if (id !== hoveredId) {
        hoveredId = id;
        onHover(id);
      }
    }
    function onPointerOut(e) {
      if (destroyed) return;
      var related = e.relatedTarget;
      // If moving to another descendant of g (another country path), the
      // subsequent pointerover on that path will update hoveredId; but if
      // leaving the group entirely, clear.
      if (related && g.contains(related)) return;
      if (hoveredId !== null) {
        hoveredId = null;
        onHover(null);
      }
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
