(function () {
  'use strict';

  var DEFAULT_YEAR_ID = '1940';

  var els = {};
  var map = null;
  var game = null;

  var timerHandle = null;
  var wrongTimeouts = Object.create(null);
  var feedbackTimeout = null;
  var hintTimeout = null;

  var currentYearId = null;
  var WORLD = null;   // active snapshot: window.GEOMAPS[currentYearId]
  var NOTES = {};      // active notes: window['NOTES' + currentYearId] || {}
  var noteTimeout = null;

  var lastRegionId = 'world';
  var lastIncludeSmall = false;
  var hasStartedOnce = false;

  // ---------- registry helpers ----------

  function registry() {
    return window.GEOMAPS || {};
  }

  // Year ids ascending by meta.year, e.g. ["1914", "1940"].
  function years() {
    var reg = registry();
    return Object.keys(reg).sort(function (a, b) {
      return reg[a].meta.year - reg[b].meta.year;
    });
  }

  function notesFor(yearId) {
    return window['NOTES' + yearId] || {};
  }

  function pickDefaultYearId() {
    var reg = registry();
    if (reg[DEFAULT_YEAR_ID]) return DEFAULT_YEAR_ID;
    var ys = years();
    return ys.length ? ys[ys.length - 1] : null;
  }

  // ---------- helpers ----------

  function byId(id) {
    return document.getElementById(id);
  }

  function entityById(id) {
    if (!id || !WORLD || !WORLD.entities) return null;
    for (var i = 0; i < WORLD.entities.length; i++) {
      if (WORLD.entities[i].id === id) return WORLD.entities[i];
    }
    return null;
  }

  function entityName(id) {
    var e = entityById(id);
    return e ? e.name : 'the ocean';
  }

  function pad2(n) {
    return n < 10 ? '0' + n : '' + n;
  }

  function formatElapsed(ms) {
    var totalSeconds = Math.floor(Math.max(0, ms) / 1000);
    var hours = Math.floor(totalSeconds / 3600);
    var minutes = Math.floor((totalSeconds % 3600) / 60);
    var seconds = totalSeconds % 60;
    if (hours > 0) {
      return pad2(hours) + ':' + pad2(minutes) + ':' + pad2(seconds);
    }
    return pad2(minutes) + ':' + pad2(seconds);
  }

  function populateRegionSelect() {
    var regions = (WORLD.regions || []).slice();
    regions.sort(function (a, b) {
      if (a.id === 'world') return -1;
      if (b.id === 'world') return 1;
      return 0;
    });
    els.regionSelect.innerHTML = '';
    regions.forEach(function (r) {
      var opt = document.createElement('option');
      opt.value = r.id;
      opt.textContent = r.name;
      els.regionSelect.appendChild(opt);
    });
  }

  function setFeedback(text) {
    if (feedbackTimeout) {
      clearTimeout(feedbackTimeout);
      feedbackTimeout = null;
    }
    els.feedback.textContent = text || '';
    if (text) {
      feedbackTimeout = setTimeout(function () {
        els.feedback.textContent = '';
        feedbackTimeout = null;
      }, 2000);
    }
  }

  function noteFor(id) {
    var n = NOTES[id];
    return n && n.note ? n.note : '';
  }

  function showNote(id) {
    var note = noteFor(id);
    if (!els.note) return;
    if (noteTimeout) {
      clearTimeout(noteTimeout);
      noteTimeout = null;
    }
    if (!note) {
      els.note.hidden = true;
      return;
    }
    els.note.innerHTML = '';
    var name = document.createElement('span');
    name.className = 'note-name';
    name.textContent = entityName(id) + ' — ';
    els.note.appendChild(name);
    els.note.appendChild(document.createTextNode(note));
    els.note.hidden = false;
    noteTimeout = setTimeout(function () {
      els.note.hidden = true;
      noteTimeout = null;
    }, 6000);
  }

  function hideNote() {
    if (noteTimeout) {
      clearTimeout(noteTimeout);
      noteTimeout = null;
    }
    if (els.note) els.note.hidden = true;
  }

  function renderPromptAndStats() {
    if (!game) return;
    var stats = game.stats();
    var currentId = game.current();

    els.promptName.textContent = currentId ? entityName(currentId) : 'Done!';
    els.counter.textContent = stats.answered + ' / ' + stats.total;
    els.score.textContent = stats.scorePercent + '%';
    els.timer.textContent = formatElapsed(stats.elapsedMs);
  }

  function stopTimer() {
    if (timerHandle) {
      clearInterval(timerHandle);
      timerHandle = null;
    }
  }

  function startTimer() {
    stopTimer();
    timerHandle = setInterval(function () {
      if (!game) return;
      els.timer.textContent = formatElapsed(game.elapsedMs());
    }, 250);
  }

  var MISS_LABEL = {
    correct2: '2nd try',
    correct3: '3rd try',
    revealed: 'revealed'
  };

  function showResults() {
    var stats = game.stats();
    els.resultsScore.textContent = stats.scorePercent + '%';
    els.resultsTime.textContent = formatElapsed(stats.elapsedMs);

    els.resultsMisses.innerHTML = '';
    game.results().forEach(function (r) {
      if (r.state === 'correct1') return;
      var li = document.createElement('li');

      var nameSpan = document.createElement('span');
      nameSpan.className = 'miss-name';
      nameSpan.textContent = entityName(r.id);

      var detailSpan = document.createElement('span');
      detailSpan.className = 'miss-detail';
      detailSpan.textContent = MISS_LABEL[r.state] || r.state || '';

      li.appendChild(nameSpan);
      li.appendChild(detailSpan);
      var note = noteFor(r.id);
      if (note) {
        var noteDiv = document.createElement('div');
        noteDiv.className = 'miss-note';
        noteDiv.textContent = note;
        li.appendChild(noteDiv);
      }
      els.resultsMisses.appendChild(li);
    });

    var sources = (WORLD.meta && WORLD.meta.sources) || [];
    els.resultsSources.textContent = sources.join(' · ');

    els.results.hidden = false;
  }

  function hideResults() {
    els.results.hidden = true;
  }

  // ---------- year toggle ----------

  function buildYearToggle() {
    if (!els.yearToggle) return;
    els.yearToggle.innerHTML = '';
    var reg = registry();
    years().forEach(function (yid) {
      var meta = reg[yid].meta || {};
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'year-btn';
      btn.setAttribute('data-year', yid);
      btn.textContent = meta.label != null ? meta.label : yid;
      var isActive = yid === currentYearId;
      if (isActive) btn.className += ' is-active';
      btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      btn.addEventListener('click', function () {
        setYear(yid);
      });
      els.yearToggle.appendChild(btn);
    });
  }

  function updateYearToggleUI() {
    if (!els.yearToggle) return;
    var btns = els.yearToggle.querySelectorAll('.year-btn');
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      var isActive = b.getAttribute('data-year') === currentYearId;
      b.classList.toggle('is-active', isActive);
      b.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    }
  }

  function updateSubtitle() {
    if (els.subtitle && WORLD && WORLD.meta) {
      els.subtitle.textContent = WORLD.meta.title || '';
    }
  }

  function resetHeaderToPreGame() {
    els.promptName.textContent = 'Press Start';
    els.counter.textContent = '0 / 0';
    els.score.textContent = '0%';
    els.timer.textContent = '00:00';
  }

  // ---------- app API ----------

  function start(regionId, opts) {
    opts = opts || {};
    var includeSmall = !!opts.includeSmall;

    var ids = WORLD.entities
      .filter(function (e) {
        return (regionId === 'world' || e.region === regionId) &&
          (e.quiz || includeSmall);
      })
      .map(function (e) { return e.id; });

    lastRegionId = regionId;
    lastIncludeSmall = includeSmall;

    hideResults();
    setFeedback('');
    hideNote();
    if (hintTimeout) {
      clearTimeout(hintTimeout);
      hintTimeout = null;
    }

    game = window.GeoGame.create({ ids: ids, shuffle: true });

    map.clearStates();
    map.setHint(null);
    map.zoomToRegion(regionId);
    map.setInteractive(true);

    renderPromptAndStats();
    startTimer();

    hasStartedOnce = true;
    els.startBtn.textContent = 'Restart';
  }

  function currentId() {
    return game ? game.current() : null;
  }

  function currentYear() {
    return currentYearId;
  }

  // Switch the active map year. No-op if `yearId` is already active or unknown.
  // Rebuilds the map from scratch, discards any in-progress game, repopulates
  // the region select (keeping the current region when it still exists in the
  // new snapshot, else falling back to "world"), and resets the header stats
  // and any transient UI (note/feedback/results/hint) to the pre-game state.
  function setYear(yearId) {
    if (!yearId || yearId === currentYearId) return;
    var reg = registry();
    var nextData = reg[yearId];
    if (!nextData) return;

    // Abandon any in-progress game and transient UI state.
    game = null;
    stopTimer();
    hideResults();
    setFeedback('');
    hideNote();
    if (hintTimeout) {
      clearTimeout(hintTimeout);
      hintTimeout = null;
    }

    currentYearId = yearId;
    WORLD = nextData;
    NOTES = notesFor(yearId);

    // Rebuild the map for the new snapshot.
    if (map) map.destroy();
    map = window.GeoMap.create(els.map, WORLD, {
      onClick: onMapClick,
      onHover: onMapHover
    });
    map.setInteractive(false);

    // Repopulate the region select, preserving the current region when it
    // still exists in the new snapshot, else falling back to "world". The
    // "current region" is the live <select> value, not the possibly-stale
    // lastRegionId bookkeeping var (which only tracks the last *started*
    // game) -- the user may have changed the dropdown without starting.
    var currentSelection = els.regionSelect.value;
    var regions = WORLD.regions || [];
    var stillExists = regions.some(function (r) { return r.id === currentSelection; });
    var nextRegionId = stillExists ? currentSelection : 'world';
    populateRegionSelect();
    els.regionSelect.value = nextRegionId;
    lastRegionId = els.regionSelect.value || nextRegionId;

    resetHeaderToPreGame();
    updateSubtitle();
    updateYearToggleUI();
  }

  // ---------- map event handlers ----------

  function onMapHover(/* idOrNull */) {
    // No additional UI hook required beyond the map's own hover style.
  }

  function onMapClick(id) {
    if (!game || game.isFinished()) return;

    // Defensive guard: an entity already carrying a persistent state
    // (correct1/2/3 or revealed) has already been scored this game, so a
    // click on it must be a no-op with no penalty, regardless of whether
    // it happens to be the entity currently being asked about.
    if (id) {
      var st = map.getState(id);
      if (st && st !== 'wrong') return;   // 'wrong' is only a transient flash, not a score
    }

    var r = game.guess(id);
    if (r.ignored) return;

    if (r.correct) {
      map.setState(id, r.state);
      showNote(id);
    } else {
      if (id) {
        map.setState(id, 'wrong');
        (function (clickedId) {
          setTimeout(function () {
            if (map.getState(clickedId) === 'wrong') {
              map.setState(clickedId, null);
            }
          }, 600);
        })(id);
      }
      setFeedback('That was ' + entityName(id) + '.');
    }

    if (r.revealedId) {
      map.setState(r.revealedId, 'revealed');
      map.flash(r.revealedId);
      showNote(r.revealedId);
      if (map.setHint) {
        map.setHint(r.revealedId);
        if (hintTimeout) clearTimeout(hintTimeout);
        hintTimeout = setTimeout(function () {
          map.setHint(null);
          hintTimeout = null;
        }, 1000);
      }
    }

    renderPromptAndStats();

    if (r.finished) {
      hideNote();
      stopTimer();
      map.setInteractive(false);
      showResults();
    }
  }

  // ---------- wiring ----------

  function wireControls() {
    els.startBtn.addEventListener('click', function () {
      start(els.regionSelect.value, { includeSmall: els.includeSmall.checked });
    });

    els.playAgainBtn.addEventListener('click', function () {
      hideResults();
      start(lastRegionId, { includeSmall: lastIncludeSmall });
    });

    els.regionSelect.addEventListener('change', function () {
      if (game && !game.isFinished()) {
        map.zoomToRegion(els.regionSelect.value);
      }
    });

    els.zoomIn.addEventListener('click', function () {
      map.zoomBy(1.5);
    });
    els.zoomOut.addEventListener('click', function () {
      map.zoomBy(1 / 1.5);
    });
    els.zoomReset.addEventListener('click', function () {
      map.resetZoom();
    });

    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && !els.results.hidden) {
        hideResults();
      }
    });
  }

  function cacheEls() {
    els.map = byId('map');
    els.promptName = byId('prompt-name');
    els.counter = byId('counter');
    els.timer = byId('timer');
    els.score = byId('score');
    els.regionSelect = byId('region-select');
    els.includeSmall = byId('include-small');
    els.startBtn = byId('start-btn');
    els.zoomIn = byId('zoom-in');
    els.zoomOut = byId('zoom-out');
    els.zoomReset = byId('zoom-reset');
    els.feedback = byId('feedback');
    els.results = byId('results');
    els.resultsScore = byId('results-score');
    els.resultsTime = byId('results-time');
    els.resultsMisses = byId('results-misses');
    els.resultsSources = byId('results-sources');
    els.playAgainBtn = byId('play-again-btn');
    els.note = byId('note');
    els.yearToggle = byId('year-toggle');
    els.subtitle = byId('game-subtitle');
  }

  function init() {
    cacheEls();

    currentYearId = pickDefaultYearId();
    WORLD = registry()[currentYearId] || { meta: {}, regions: [], entities: [] };
    NOTES = notesFor(currentYearId);

    populateRegionSelect();
    updateSubtitle();
    buildYearToggle();

    map = window.GeoMap.create(els.map, WORLD, {
      onClick: onMapClick,
      onHover: onMapHover
    });
    map.setInteractive(false);

    wireControls();

    Object.defineProperty(window.GeoApp, 'data', {
      get: function () { return WORLD; },
      configurable: true
    });
    Object.defineProperty(window.GeoApp, 'game', {
      get: function () { return game; },
      configurable: true
    });
    Object.defineProperty(window.GeoApp, 'map', {
      get: function () { return map; },
      configurable: true
    });
  }

  window.GeoApp = {
    years: years,
    currentYear: currentYear,
    setYear: setYear,
    start: start,
    currentId: currentId
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
