const test = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('child_process');
const { createContext, runInContext } = require('vm');
const path = require('path');
const fs = require('fs');

// Load GeoGame from the main file
const GeoGame = require('../js/game.js');

// Simple LCG (Linear Congruential Generator) for deterministic testing
class SeededRandom {
  constructor(seed) {
    this.seed = seed;
  }
  next() {
    this.seed = (this.seed * 1103515245 + 12345) & 0x7fffffff;
    return this.seed / 0x7fffffff;
  }
}

test('Input validation: empty ids array', () => {
  assert.throws(() => {
    GeoGame.create({ ids: [] });
  }, /non-empty array/);
});

test('Input validation: duplicate ids', () => {
  assert.throws(() => {
    GeoGame.create({ ids: ['a', 'b', 'a'] });
  }, /unique/);
});

test('Input validation: non-string ids', () => {
  assert.throws(() => {
    GeoGame.create({ ids: ['a', 123, 'c'] });
  }, /string/);
});

test('Create game with defaults', () => {
  const game = GeoGame.create({ ids: ['a', 'b', 'c'] });
  assert.equal(game.config.maxTries, 3);
  assert.equal(game.config.shuffle, true);
  assert.equal(typeof game.config.random, 'function');
  assert.equal(typeof game.config.now, 'function');
});

test('Deterministic order with seeded random', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  const rng1 = new SeededRandom(42);
  const rng2 = new SeededRandom(42);

  const game1 = GeoGame.create({ ids: ids, random: () => rng1.next() });
  const game2 = GeoGame.create({ ids: ids, random: () => rng2.next() });

  assert.deepEqual(game1.order(), game2.order());
});

test('No shuffle when shuffle: false', () => {
  const ids = ['a', 'b', 'c'];
  const game = GeoGame.create({ ids: ids, shuffle: false });
  assert.deepEqual(game.order(), ids);
});

test('current() returns first prompt', () => {
  const game = GeoGame.create({ ids: ['a', 'b', 'c'], shuffle: false });
  assert.equal(game.current(), 'a');
});

test('First try is correct1', () => {
  const game = GeoGame.create({ ids: ['a', 'b', 'c'], shuffle: false });
  const result = game.guess('a');
  assert.equal(result.correct, true);
  assert.equal(result.state, 'correct1');
  assert.equal(result.triesUsed, 0);
  assert.equal(result.ignored, false);
  assert.equal(result.revealedId, null);
});

test('Second try is correct2', () => {
  const game = GeoGame.create({ ids: ['a', 'b', 'c'], shuffle: false });
  game.guess('x'); // wrong
  const result = game.guess('a'); // correct on second try
  assert.equal(result.state, 'correct2');
  assert.equal(result.triesUsed, 1);
});

test('Third try is correct3', () => {
  const game = GeoGame.create({ ids: ['a', 'b', 'c'], shuffle: false });
  game.guess('x'); // wrong
  game.guess('y'); // wrong
  const result = game.guess('a'); // correct on third try
  assert.equal(result.state, 'correct3');
  assert.equal(result.triesUsed, 2);
});

test('Wrong guess increments tries and returns state "wrong"', () => {
  const game = GeoGame.create({ ids: ['a', 'b', 'c'], shuffle: false });
  const result = game.guess('x');
  assert.equal(result.correct, false);
  assert.equal(result.state, 'wrong');
  assert.equal(result.triesUsed, 1);
  assert.equal(result.ignored, false);
});

test('Unknown id counts as wrong', () => {
  const game = GeoGame.create({ ids: ['a', 'b', 'c'], shuffle: false });
  const result = game.guess('unknown');
  assert.equal(result.state, 'wrong');
  assert.equal(result.triesUsed, 1);
  assert.equal(result.ignored, false);
});

test('Reveal after maxTries wrong clicks', () => {
  const game = GeoGame.create({ ids: ['a', 'b', 'c'], maxTries: 3, shuffle: false });
  game.guess('x'); // try 1
  game.guess('y'); // try 2
  const result = game.guess('z'); // try 3 - should reveal
  assert.equal(result.state, 'revealed');
  assert.equal(result.revealedId, 'a');
  assert.equal(result.triesUsed, 3);
});

test('Auto-advance to next prompt after reveal', () => {
  const game = GeoGame.create({ ids: ['a', 'b', 'c'], maxTries: 3, shuffle: false });
  game.guess('x');
  game.guess('y');
  game.guess('z');
  assert.equal(game.current(), 'b');
});

test('Guessing already-answered id returns ignored: true', () => {
  const game = GeoGame.create({ ids: ['a', 'b', 'c'], shuffle: false });
  game.guess('a'); // correct
  const result = game.guess('a'); // guessing same id again
  assert.equal(result.ignored, true);
  assert.equal(result.correct, false);
});

test('Already-answered id does not count as a wrong try', () => {
  const game = GeoGame.create({ ids: ['a', 'b', 'c'], shuffle: false });
  game.guess('a'); // correct on first try, moves to 'b'
  game.guess('a'); // guessing already-answered 'a' again (ignored)
  // Current is still 'b', tries on 'b' should be 0
  assert.equal(game.promptTries['b'], 0);
});

test('current() returns null when finished', () => {
  const game = GeoGame.create({ ids: ['a'], shuffle: false });
  game.guess('a');
  assert.equal(game.current(), null);
});

test('isFinished() returns true when game is finished', () => {
  const game = GeoGame.create({ ids: ['a'], shuffle: false });
  assert.equal(game.isFinished(), false);
  game.guess('a');
  assert.equal(game.isFinished(), true);
});

test('Guessing when finished returns ignored: true', () => {
  const game = GeoGame.create({ ids: ['a', 'b'], shuffle: false });
  game.guess('a');
  game.guess('b');
  const result = game.guess('c');
  assert.equal(result.ignored, true);
  assert.equal(result.finished, true);
});

test('finished flag in guess result', () => {
  const game = GeoGame.create({ ids: ['a'], shuffle: false });
  const result = game.guess('a');
  assert.equal(result.finished, true);
});

test('next field in guess result points to next current', () => {
  const game = GeoGame.create({ ids: ['a', 'b'], shuffle: false });
  const result = game.guess('a');
  assert.equal(result.next, 'b');
});

test('stats() returns correct counts', () => {
  const game = GeoGame.create({ ids: ['a', 'b', 'c', 'd'], shuffle: false, maxTries: 3 });
  game.guess('a'); // correct1
  game.guess('x');
  game.guess('b'); // correct2
  game.guess('x');
  game.guess('y');
  game.guess('c'); // correct3
  const stats = game.stats();
  assert.equal(stats.total, 4);
  assert.equal(stats.answered, 3);
  assert.equal(stats.remaining, 1);
  assert.equal(stats.firstTry, 1);
  assert.equal(stats.secondTry, 1);
  assert.equal(stats.thirdTry, 1);
  assert.equal(stats.revealed, 0);
});

test('stats() includes revealed in counts', () => {
  const game = GeoGame.create({ ids: ['a', 'b'], shuffle: false, maxTries: 1 });
  game.guess('a'); // correct1
  game.guess('x'); // wrong, triggers reveal for 'b'
  const stats = game.stats();
  assert.equal(stats.revealed, 1);
});

test('scorePercent calculation', () => {
  const game = GeoGame.create({ ids: ['a', 'b', 'c'], shuffle: false });
  game.guess('a'); // firstTry 1
  game.guess('x'); // wrong on 'b'
  game.guess('b'); // correct2
  // 1 firstTry out of 3 total = 33.33... -> 33%
  const stats = game.stats();
  assert.equal(stats.scorePercent, 33);
});

test('scorePercent rounds correctly', () => {
  // 2 out of 3 = 66.666... -> 67%
  const game = GeoGame.create({ ids: ['a', 'b', 'c'], shuffle: false });
  game.guess('a'); // correct1
  game.guess('b'); // correct1
  const stats = game.stats();
  assert.equal(stats.scorePercent, 67);
});

test('results() returns answered prompts in order', () => {
  const game = GeoGame.create({ ids: ['a', 'b', 'c'], shuffle: false });
  game.guess('a');
  game.guess('x');
  game.guess('b');
  const results = game.results();
  assert.equal(results.length, 2);
  assert.equal(results[0].id, 'a');
  assert.equal(results[0].state, 'correct1');
  assert.equal(results[0].triesUsed, 0);
  assert.equal(results[1].id, 'b');
  assert.equal(results[1].state, 'correct2');
  assert.equal(results[1].triesUsed, 1);
});

test('order() returns frozen prompt order', () => {
  const ids = ['a', 'b', 'c'];
  const game = GeoGame.create({ ids: ids, shuffle: false });
  const order1 = game.order();
  const order2 = game.order();
  assert.deepEqual(order1, order2);
  assert.notStrictEqual(order1, order2); // different array objects
});

test('restart() reshuffles and resets state', () => {
  const ids = ['a', 'b', 'c'];
  const game = GeoGame.create({ ids: ids, shuffle: false });

  // Play some game
  game.guess('a');
  assert.equal(game.current(), 'b');
  let stats = game.stats();
  assert.equal(stats.answered, 1);

  // Restart
  game.restart();

  // Verify state is reset
  assert.equal(game.current(), 'a');
  assert.equal(game.isFinished(), false);
  stats = game.stats();
  assert.equal(stats.answered, 0);
  assert.equal(stats.remaining, 3);
});

test('elapsedMs starts at 0 and increases', () => {
  let currentTime = 1000;
  const game = GeoGame.create({
    ids: ['a'],
    now: () => currentTime
  });

  const elapsed1 = game.elapsedMs();
  assert.equal(elapsed1, 0);

  currentTime = 1010;
  const elapsed2 = game.elapsedMs();
  assert.equal(elapsed2, 10);
  assert(elapsed2 > elapsed1);
});

test('elapsedMs freezes at finish', () => {
  let currentTime = 1000;
  const game = GeoGame.create({
    ids: ['a', 'b'],
    now: () => currentTime,
    shuffle: false
  });

  game.guess('a');
  currentTime = 2000;
  game.guess('b');
  const elapsedAtFinish = game.elapsedMs();

  currentTime = 3000;
  const elapsedAfter = game.elapsedMs();

  assert.equal(elapsedAtFinish, 1000);
  assert.equal(elapsedAfter, 1000); // should not increase
});

test('stateForTries helper function', () => {
  assert.equal(GeoGame.stateForTries(0), 'correct1');
  assert.equal(GeoGame.stateForTries(1), 'correct2');
  assert.equal(GeoGame.stateForTries(2), 'correct3');
  assert.equal(GeoGame.stateForTries(3), null);
});

test('Module exports to window when window exists', () => {
  const gameCode = fs.readFileSync(path.join(__dirname, '../js/game.js'), 'utf8');
  const context = createContext({ module: {}, window: {} });
  runInContext(gameCode, context);
  assert(context.window.GeoGame);
  assert.equal(typeof context.window.GeoGame.create, 'function');
  assert.equal(typeof context.window.GeoGame.stateForTries, 'function');
});

test('Module exports to module.exports for Node', () => {
  const gameCode = fs.readFileSync(path.join(__dirname, '../js/game.js'), 'utf8');
  const context = createContext({
    module: { exports: {} },
    window: undefined
  });
  runInContext(gameCode, context);
  assert(context.module.exports);
  assert.equal(typeof context.module.exports.create, 'function');
});

test('Complete game flow', () => {
  const game = GeoGame.create({
    ids: ['a', 'b', 'c'],
    shuffle: false,
    maxTries: 3
  });

  // Play through game
  assert.equal(game.current(), 'a');

  // Answer 'a' correctly on first try
  let result = game.guess('a');
  assert.equal(result.correct, true);
  assert.equal(result.state, 'correct1');

  // Answer 'b' on second try
  game.guess('x');
  result = game.guess('b');
  assert.equal(result.state, 'correct2');

  // Answer 'c' on third try
  game.guess('y');
  game.guess('z');
  result = game.guess('c');
  assert.equal(result.state, 'correct3');

  assert.equal(game.isFinished(), true);

  // Check stats
  const stats = game.stats();
  assert.equal(stats.total, 3);
  assert.equal(stats.answered, 3);
  assert.equal(stats.remaining, 0);
  assert.equal(stats.firstTry, 1);
  assert.equal(stats.secondTry, 1);
  assert.equal(stats.thirdTry, 1);
  assert.equal(stats.scorePercent, 33); // 1/3 = 33%

  // Check results
  const results = game.results();
  assert.equal(results.length, 3);
  assert.equal(results[0].state, 'correct1');
  assert.equal(results[1].state, 'correct2');
  assert.equal(results[2].state, 'correct3');
});
