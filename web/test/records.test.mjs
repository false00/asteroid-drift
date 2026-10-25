import test from 'node:test';
import assert from 'node:assert/strict';
import { FlightRecords, isRankedResult, leaderboardEntries } from '../site/records.mjs';

const entries = [
  { rank: 1, username: 'Leader', score: 1500 },
  { rank: 2, username: 'Rival', score: 900 },
  { rank: 3, username: 'Pilot_01', score: 500 },
];

test('personal records celebrate once per flight, strictly above the starting best', () => {
  const records = new FlightRecords({ best: 500 });
  assert.equal(records.observe(500), null);
  assert.deepEqual(records.observe(501), { personalBest: true, passed: 0, rank: null, leader: false, previousBest: 500 });
  for (const score of [501, 600, 1000, 900]) assert.equal(records.observe(score), null);
  assert.throws(() => records.observe(Infinity), TypeError);
  assert.throws(() => new FlightRecords({ best: -1 }), TypeError);
});

test('ranked overtakes exclude the owner and ties, and collapse multiple opponents into one cue', () => {
  const records = new FlightRecords({ best: 500, username: 'pilot_01', entries });
  records.observe(600);
  assert.equal(records.observe(900), null);
  assert.deepEqual(records.observe(901), { personalBest: false, passed: 1, rank: 2, leader: false, previousBest: 500 });
  assert.equal(records.observe(1500), null);
  assert.deepEqual(records.observe(1501), { personalBest: false, passed: 1, rank: 1, leader: true, previousBest: 500 });
  assert.equal(records.observe(2000), null);
  assert.deepEqual(new FlightRecords({ best: 500, username: 'Pilot_01', entries }).observe(2000),
    { personalBest: true, passed: 2, rank: 1, leader: true, previousBest: 500 });
});

test('a retained higher account best does not repeatedly celebrate already-beaten leaderboard rows', () => {
  const records = new FlightRecords({ best: 2000, username: 'Pilot_01', entries });
  assert.equal(records.observe(1600), null);
  assert.deepEqual(records.observe(2001), { personalBest: true, passed: 0, rank: null, leader: false, previousBest: 2000 });
});

test('leaderboard presentation rejects malformed, duplicate, unsorted and unsafe aliases', () => {
  assert.deepEqual(leaderboardEntries(entries), entries);
  for (const invalid of [
    null, Array(11).fill(entries[0]), [{ ...entries[0], rank: 2 }], [{ ...entries[0], username: '<img>' }],
    [{ ...entries[0], score: Infinity }], [entries[0], { ...entries[1], score: 2000 }],
    [entries[0], { ...entries[1], username: 'LEADER' }],
  ]) assert.throws(() => leaderboardEntries(invalid), TypeError);
});

test('verified results require consistent server-owned bests and actual placement improvements', () => {
  const result = {
    score: 2000, wave: 3, durationMs: 40000, qualified: true,
    personalBest: 2000, previousBest: 500, newPersonalBest: true,
    rank: 1, previousRank: 3, rankImproved: true,
  };
  assert.equal(isRankedResult(result), true);
  for (const change of [
    { personalBest: 9000 }, { previousBest: -1 }, { newPersonalBest: false }, { rank: 11 },
    { previousRank: 1 }, { rankImproved: false }, { qualified: false }, { score: NaN }, { wave: 0 },
  ]) assert.equal(isRankedResult({ ...result, ...change }), false);
  assert.equal(isRankedResult({
    ...result, score: 100, personalBest: 500, newPersonalBest: false, qualified: false,
    rank: 3, previousRank: 3, rankImproved: false,
  }), true);
});
