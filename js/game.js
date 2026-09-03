(function() {
  'use strict';

  // Helper: convert number of tries before correct to state string
  function stateForTries(triesBeforeCorrect) {
    switch (triesBeforeCorrect) {
      case 0: return 'correct1';
      case 1: return 'correct2';
      case 2: return 'correct3';
      default: return null;
    }
  }

  // Fisher-Yates shuffle using injected random function
  function shuffle(array, random) {
    const result = array.slice();
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }

  // GeoGame constructor
  function GeoGame(config) {
    // Validate inputs
    if (!Array.isArray(config.ids) || config.ids.length === 0) {
      throw new Error('ids must be a non-empty array');
    }
    const uniqueIds = new Set(config.ids);
    if (uniqueIds.size !== config.ids.length) {
      throw new Error('ids must be unique');
    }
    config.ids.forEach(id => {
      if (typeof id !== 'string') {
        throw new Error('all ids must be strings');
      }
    });

    this.config = {
      ids: config.ids.slice(),
      maxTries: config.maxTries || 3,
      shuffle: config.shuffle !== false,
      random: config.random || Math.random,
      now: config.now || Date.now
    };

    this.init();
  }

  GeoGame.prototype.init = function() {
    const order = this.config.ids.slice();
    if (this.config.shuffle) {
      this.promptOrder = shuffle(order, this.config.random);
    } else {
      this.promptOrder = order;
    }

    // Track state for each prompt
    this.promptState = {};
    this.promptTries = {};
    this.promptOrder.forEach(id => {
      this.promptState[id] = null;
      this.promptTries[id] = 0;
    });

    this.currentIndex = 0;
    this.finished = false;
    this.startTime = this.config.now();
    this.finishTime = null;
  };

  GeoGame.prototype.current = function() {
    if (this.finished || this.currentIndex >= this.promptOrder.length) {
      return null;
    }
    return this.promptOrder[this.currentIndex];
  };

  GeoGame.prototype.guess = function(id) {
    const currentId = this.current();
    const idSet = new Set(this.config.ids);

    // Check if game is finished
    if (this.finished) {
      return {
        ignored: true,
        correct: false,
        triesUsed: this.promptTries[id] || 0,
        state: null,
        revealedId: null,
        finished: true,
        next: null
      };
    }

    if (currentId === null) {
      // Should not happen, but handle it
      return {
        ignored: true,
        correct: false,
        triesUsed: 0,
        state: null,
        revealedId: null,
        finished: true,
        next: null
      };
    }

    // Check if the guessed id has already been answered
    // An id is "answered" if it's in the quiz (in config.ids) and has a non-null state
    if (idSet.has(id) && this.promptState[id] !== null) {
      // Already answered - ignore the guess
      return {
        ignored: true,
        correct: false,
        triesUsed: this.promptTries[id] || 0,
        state: null,
        revealedId: null,
        finished: false,
        next: this.current()
      };
    }

    // Guessing on a non-existent id counts as wrong (same as wrong guess)
    const correct = (id === currentId);

    if (correct) {
      // Correct guess
      const triesUsed = this.promptTries[currentId];
      const state = stateForTries(triesUsed);
      this.promptState[currentId] = state;

      // Move to next prompt
      this.currentIndex++;
      if (this.currentIndex >= this.promptOrder.length) {
        this.finished = true;
        this.finishTime = this.config.now();
      }

      return {
        ignored: false,
        correct: true,
        triesUsed: triesUsed,
        state: state,
        revealedId: null,
        finished: this.finished,
        next: this.current()
      };
    } else {
      // Wrong guess - increment tries for current prompt
      this.promptTries[currentId]++;

      // Check if we've hit max tries
      let revealedId = null;
      if (this.promptTries[currentId] >= this.config.maxTries) {
        // Reveal the answer
        this.promptState[currentId] = 'revealed';
        revealedId = currentId;

        // Move to next prompt
        this.currentIndex++;
        if (this.currentIndex >= this.promptOrder.length) {
          this.finished = true;
          this.finishTime = this.config.now();
        }
      }

      return {
        ignored: false,
        correct: false,
        triesUsed: this.promptTries[currentId],
        state: revealedId !== null ? 'revealed' : 'wrong',
        revealedId: revealedId,
        finished: this.finished,
        next: this.current()
      };
    }
  };

  GeoGame.prototype.stats = function() {
    const total = this.promptOrder.length;
    let answered = 0;
    let firstTry = 0;
    let secondTry = 0;
    let thirdTry = 0;
    let revealed = 0;

    for (const id of this.promptOrder) {
      const state = this.promptState[id];
      if (state === null) continue;

      answered++;
      if (state === 'correct1') {
        firstTry++;
      } else if (state === 'correct2') {
        secondTry++;
      } else if (state === 'correct3') {
        thirdTry++;
      } else if (state === 'revealed') {
        revealed++;
      }
    }

    const remaining = total - answered;
    const scorePercent = total === 0 ? 0 : Math.round(100 * firstTry / total);

    return {
      total: total,
      answered: answered,
      remaining: remaining,
      firstTry: firstTry,
      secondTry: secondTry,
      thirdTry: thirdTry,
      revealed: revealed,
      scorePercent: scorePercent,
      elapsedMs: this.elapsedMs()
    };
  };

  GeoGame.prototype.results = function() {
    const results = [];
    for (const id of this.promptOrder) {
      if (this.promptState[id] !== null) {
        results.push({
          id: id,
          state: this.promptState[id],
          triesUsed: this.promptTries[id]
        });
      }
    }
    return results;
  };

  GeoGame.prototype.isFinished = function() {
    return this.finished;
  };

  GeoGame.prototype.order = function() {
    return this.promptOrder.slice();
  };

  GeoGame.prototype.restart = function() {
    this.init();
  };

  GeoGame.prototype.elapsedMs = function() {
    if (this.finishTime !== null) {
      return this.finishTime - this.startTime;
    }
    return this.config.now() - this.startTime;
  };

  // Static create method
  GeoGame.create = function(config) {
    return new GeoGame(config);
  };

  // Export static helper
  GeoGame.stateForTries = stateForTries;

  // Attach to window if it exists
  if (typeof window !== 'undefined') {
    window.GeoGame = GeoGame;
  }

  // Export for Node
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = GeoGame;
  }
})();
