'use strict';
const { createClient } = require('redis');

const PREFIX = process.env.REDIS_PREFIX || 'strategie2026:';

// In-memory fallback: only for local development without Redis (data is lost on restart).
function memoryStore() {
  const votes = new Map();
  const submitted = new Set();
  let phase = 'voting';
  let settings = {};
  let catalog = null;
  return {
    kind: 'memory',
    async getCatalog() { return catalog; },
    async setCatalog(str) { catalog = str; },
    async getPhase() { return phase; },
    async setPhase(p) { phase = p; },
    async getVotes(u) { return { ...(votes.get(u) || {}) }; },
    async setVotes(u, v) { votes.set(u, { ...v }); },
    async getSubmitted() { return [...submitted]; },
    async setSubmitted(u, b) { b ? submitted.add(u) : submitted.delete(u); },
    async getSettings() { return { ...settings }; },
    async setSettings(s) { settings = { ...settings, ...s }; },
    async resetVotes() { votes.clear(); submitted.clear(); phase = 'voting'; },
  };
}

async function redisStore(url) {
  const c = createClient({ url });
  c.on('error', (e) => console.error('[redis]', e.message));
  await c.connect();
  const k = (...p) => PREFIX + p.join(':');
  const toStrMap = (obj) => Object.fromEntries(Object.entries(obj).map(([a, b]) => [a, String(b)]));
  const toIntMap = (h) => Object.fromEntries(Object.entries(h).map(([a, b]) => [a, parseInt(b, 10)]));
  return {
    kind: 'redis',
    async getCatalog() { return c.get(k('catalog')); },
    async setCatalog(str) { await c.set(k('catalog'), str); },
    async getPhase() { return (await c.get(k('phase'))) || 'voting'; },
    async setPhase(p) { await c.set(k('phase'), p); },
    async getVotes(u) { return toIntMap(await c.hGetAll(k('votes', u))); },
    async setVotes(u, v) {
      const key = k('votes', u);
      const m = c.multi().del(key);
      if (Object.keys(v).length) m.hSet(key, toStrMap(v));
      await m.exec();
    },
    async getSubmitted() { return c.sMembers(k('submitted')); },
    async setSubmitted(u, b) { if (b) await c.sAdd(k('submitted'), u); else await c.sRem(k('submitted'), u); },
    async getSettings() { return toIntMap(await c.hGetAll(k('settings'))); },
    async setSettings(s) { if (Object.keys(s).length) await c.hSet(k('settings'), toStrMap(s)); },
    async resetVotes() {
      const keys = await c.keys(k('votes', '*'));
      const m = c.multi();
      if (keys.length) m.del(keys);
      m.del(k('submitted')).del(k('phase'));
      await m.exec();
    },
  };
}

async function createStore() {
  if (process.env.REDIS_URL) return redisStore(process.env.REDIS_URL);
  console.warn('[store] REDIS_URL not set -> using in-memory store (data is lost on restart!)');
  return memoryStore();
}

module.exports = { createStore };
