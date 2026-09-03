(function () {
  'use strict';

  var WORLD = window.WORLD1940;

  var els = {};
  var map = null;
  var game = null;

  var timerHandle = null;
  var wrongTimeouts = Object.create(null);
  var feedbackTimeout = null;
  var hintTimeout = null;

  var NOTES = window.NOTES1940 || {};
  var noteTimeout = null;

  var lastRegionId = 'world';
  var lastIncludeSmall = false;
  var hasStartedOnce = false;

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
  }

  function init() {
    cacheEls();
    populateRegionSelect();

    map = window.GeoMap.create(els.map, WORLD, {
      onClick: onMapClick,
      onHover: onMapHover
    });
    map.setInteractive(false);

    wireControls();

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
    data: WORLD,
    start: start,
    currentId: currentId
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
