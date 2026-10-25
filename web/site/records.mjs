import { isPublicHandle } from './handles.mjs?v=20261024.5';

export const isScore = value => Number.isSafeInteger(value) && value >= 0;
const isRank = value => value === null || (Number.isInteger(value) && value >= 1 && value <= 10);

export function leaderboardEntries(entries) {
  if (!Array.isArray(entries) || entries.length > 10) throw new TypeError('Invalid ranked leaderboard.');
  const names = new Set();
  return entries.map((entry, i) => {
    if (!entry || entry.rank !== i + 1 || !isPublicHandle(entry.username) || !isScore(entry.score) || entry.score === 0
      || (i > 0 && entry.score > entries[i - 1].score) || names.has(entry.username.toLowerCase())) throw new TypeError('Invalid ranked leaderboard.');
    names.add(entry.username.toLowerCase());
    return { rank: entry.rank, username: entry.username, score: entry.score };
  });
}

export function isRankedResult(result) {
  return Boolean(result && isScore(result.score) && Number.isSafeInteger(result.wave) && result.wave > 0
    && isScore(result.durationMs) && isRank(result.rank) && isRank(result.previousRank)
    && isScore(result.personalBest) && isScore(result.previousBest)
    && typeof result.qualified === 'boolean' && typeof result.newPersonalBest === 'boolean' && typeof result.rankImproved === 'boolean'
    && result.personalBest === Math.max(result.previousBest, result.qualified ? result.score : 0)
    && result.newPersonalBest === (result.qualified && result.score > result.previousBest)
    && result.rankImproved === (result.qualified && result.rank !== null && (result.previousRank === null || result.rank < result.previousRank)));
}

export class FlightRecords {
  constructor({ best, entries = [], username = null }) {
    if (!isScore(best) || (username !== null && !isPublicHandle(username))) throw new TypeError('Invalid personal record.');
    this.best = best;
    this.peak = 0;
    this.announcedBest = false;
    this.entries = leaderboardEntries(entries).filter(entry => entry.username.toLowerCase() !== username?.toLowerCase());
    this.remaining = this.entries.filter(entry => entry.score >= best);
  }

  observe(score) {
    if (!isScore(score)) throw new TypeError('Invalid flight score.');
    if (score <= this.peak) return null;
    this.peak = score;
    const personalBest = !this.announcedBest && score > this.best;
    if (personalBest) this.announcedBest = true;
    const passed = this.remaining.filter(entry => score > entry.score);
    this.remaining = this.remaining.filter(entry => score <= entry.score);
    if (!personalBest && passed.length === 0) return null;
    const rank = passed.length ? this.entries.filter(entry => entry.score >= score).length + 1 : null;
    return { personalBest, passed: passed.length, rank, leader: rank === 1, previousBest: this.best };
  }
}
