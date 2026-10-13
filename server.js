'use strict';
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createStore } = require('./store');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const PARTICIPANTS = (process.env.PARTICIPANTS || 'Nikki,Tom,Tim').split(',').map((s) => s.trim()).filter(Boolean);
const POINTS = parseInt(process.env.POINTS_PER_PERSON, 10) || 9;
const ACCESS_PIN = process.env.ACCESS_PIN || '';
const DEFAULTS = {
  day2Minutes: parseInt(process.env.DAY2_MINUTES, 10) || 360, // Tag 2: Deep Dive
  pitchMinutes: parseInt(process.env.PITCH_MINUTES, 10) || 5, // Nachmittag: Pitch pro Einzel-Thema
  minVoters: parseInt(process.env.MIN_VOTERS, 10) || 2,       // ab so vielen Personen -> Deep Dive
};
const LIMITS = { categories: 30, topics: 200, name: 80, title: 200, context: 500 };
const TOPICS_FILE = process.env.TOPICS_FILE || path.join(__dirname, 'topics.json');
const seed = JSON.parse(fs.readFileSync(TOPICS_FILE, 'utf8'));

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

const slug = (s) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'kat';
const newId = (p) => `${p}-${crypto.randomBytes(4).toString('hex')}`;

function seedCatalog(rev = 1) {
  const cats = seed.categories.map((c) => ({
    id: c.id || 'c-' + slug(c.name), name: c.name,
    topics: c.topics.map((t) => ({ id: t.id, title: t.title, context: t.context || '' })),
  }));
  const ids = cats.flatMap((c) => c.topics.map((t) => t.id));
  if (new Set(ids).size !== ids.length) throw new Error('topics.json: duplicate topic ids');
  return { rev, updatedBy: null, categories: cats };
}

// ---- live catalog (persisted in Redis, edited through the API) ----
let catalog = null;
let topicList = [];
let topicIds = new Set();
function index() {
  topicList = [];
  for (const cat of catalog.categories) {
    for (const t of cat.topics) topicList.push({ ...t, categoryId: cat.id, category: cat.name, idx: topicList.length });
  }
  topicIds = new Set(topicList.map((t) => t.id));
}

const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
const isInt = (n) => Number.isInteger(n);

function allocate(rows, totalMinutes) {
  // Largest-remainder method in 5-minute units, so the slots add up exactly.
  const unit = 5;
  const units = Math.floor(totalMinutes / unit);
  const pts = rows.reduce((a, r) => a + r.total, 0);
  if (!pts) return;
  const shares = rows.map((r) => (units * r.total) / pts);
  const base = shares.map(Math.floor);
  const rest = units - base.reduce((a, b) => a + b, 0);
  const order = shares.map((s, i) => ({ i, frac: s - base[i], total: rows[i].total }))
    .sort((a, b) => b.frac - a.frac || b.total - a.total || a.i - b.i);
  for (let n = 0; n < rest; n++) base[order[n].i] += 1;
  rows.forEach((r, i) => { r.minutes = base[i] * unit; });
}

function computeResults(votesByUser, settings) {
  const rows = topicList.map((t) => {
    const per = {};
    let total = 0;
    let voters = 0;
    for (const u of PARTICIPANTS) {
      const p = (votesByUser[u] || {})[t.id] || 0;
      per[u] = p; total += p; if (p > 0) voters++;
    }
    return { id: t.id, title: t.title, category: t.category, categoryId: t.categoryId, context: t.context, per, total, voters, idx: t.idx };
  });
  const cmp = (a, b) => b.total - a.total || b.voters - a.voters || a.idx - b.idx;
  const deep = rows.filter((r) => r.voters >= settings.minVoters).sort(cmp);
  const pitch = rows.filter((r) => r.voters > 0 && r.voters < settings.minVoters).sort(cmp);
  const none = rows.filter((r) => r.voters === 0).sort((a, b) => a.idx - b.idx);
  allocate(deep, settings.day2Minutes);
  pitch.forEach((r) => { r.minutes = settings.pitchMinutes; });

  // Category roll-up: sum of the topic points of each category (no separate voting)
  const categories = catalog.categories.map((c, ci) => {
    const rs = rows.filter((r) => r.categoryId === c.id);
    const per = {};
    let total = 0;
    for (const u of PARTICIPANTS) { per[u] = rs.reduce((a, r) => a + r.per[u], 0); total += per[u]; }
    const minutes = [...deep, ...pitch].filter((r) => r.categoryId === c.id).reduce((a, r) => a + r.minutes, 0);
    return {
      id: c.id, name: c.name, ci, per, total, minutes,
      voters: PARTICIPANTS.filter((u) => per[u] > 0).length,
      topicsTotal: rs.length, topicsVoted: rs.filter((r) => r.total > 0).length,
    };
  }).sort((a, b) => b.total - a.total || b.voters - a.voters || a.ci - b.ci);

  return {
    deep, pitch, none, categories,
    totalPoints: rows.reduce((a, r) => a + r.total, 0),
    deepMinutes: deep.reduce((a, r) => a + r.minutes, 0),
    pitchMinutes: pitch.reduce((a, r) => a + r.minutes, 0),
  };
}

function cleanText(v, max, label, required = true) {
  if (v === undefined || v === null) v = '';
  if (typeof v !== 'string') throw new HttpError(400, `${label}: ungültig`);
  const s = v.replace(/\s+/g, ' ').trim();
  if (required && !s) throw new HttpError(400, `${label} darf nicht leer sein`);
  if (s.length > max) throw new HttpError(400, `${label}: maximal ${max} Zeichen`);
  return s;
}

async function main() {
  const store = await createStore();
  console.log(`[store] using ${store.kind}`);

  const raw = await store.getCatalog();
  if (raw) { catalog = JSON.parse(raw); } else { catalog = seedCatalog(); await store.setCatalog(JSON.stringify(catalog)); }
  index();

  const settingsNow = async () => ({ ...DEFAULTS, ...(await store.getSettings()) });

  // serialise catalog edits so concurrent requests cannot overwrite each other
  let lock = Promise.resolve();
  const withLock = (fn) => { const run = lock.then(fn); lock = run.catch(() => {}); return run; };

  async function pruneVotes() {
    for (const u of PARTICIPANTS) {
      const v = await store.getVotes(u);
      const kept = Object.fromEntries(Object.entries(v).filter(([id]) => topicIds.has(id)));
      if (Object.keys(kept).length !== Object.keys(v).length) await store.setVotes(u, kept);
    }
  }

  // apply an edit to a copy of the catalog, persist it, then swap it in
  function mutate(user, fn) {
    return withLock(async () => {
      if ((await store.getPhase()) === 'revealed') throw new HttpError(409, 'Ergebnisse sind aufgedeckt – die Themenliste ist gesperrt');
      const next = JSON.parse(JSON.stringify(catalog));
      const out = fn(next) || {};
      next.rev = catalog.rev + 1;
      next.updatedBy = user;
      await store.setCatalog(JSON.stringify(next));
      catalog = next;
      index();
      if (out.removed && out.removed.length) await pruneVotes();
      return out;
    });
  }

  const findCat = (c, id) => { const x = c.categories.find((k) => k.id === id); if (!x) throw new HttpError(404, 'Kategorie nicht gefunden'); return x; };
  const findTopic = (c, id) => {
    for (const cat of c.categories) { const i = cat.topics.findIndex((t) => t.id === id); if (i >= 0) return { cat, i, topic: cat.topics[i] }; }
    throw new HttpError(404, 'Thema nicht gefunden');
  };
  const countTopics = (c) => c.categories.reduce((a, k) => a + k.topics.length, 0);
  const uniqueName = (c, name, exceptId) => {
    if (c.categories.some((k) => k.id !== exceptId && k.name.toLowerCase() === name.toLowerCase())) throw new HttpError(400, 'Eine Kategorie mit diesem Namen existiert bereits');
  };
  const swap = (arr, i, dir) => {
    const j = i + (dir < 0 ? -1 : 1);
    if (j < 0 || j >= arr.length) return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
  };

  const app = express();
  app.use(express.json({ limit: '50kb' }));

  app.get('/healthz', (req, res) => res.json({ ok: true, store: store.kind }));
  app.get('/api/hello', (req, res) => res.json({
    title: seed.title, participants: PARTICIPANTS, points: POINTS, pinRequired: !!ACCESS_PIN,
  }));

  // everything below needs the (optional) PIN and a valid participant
  app.use('/api', (req, res, next) => {
    if (ACCESS_PIN && req.get('x-pin') !== ACCESS_PIN) return res.status(401).json({ error: 'PIN falsch oder fehlt' });
    const user = req.get('x-user');
    if (!PARTICIPANTS.includes(user)) return res.status(400).json({ error: 'Unbekannte Person' });
    req.user = user;
    next();
  });

  const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
    if (e instanceof HttpError) return res.status(e.status).json({ error: e.message });
    console.error(e);
    res.status(500).json({ error: 'Serverfehler: ' + e.message });
  });

  app.get('/api/state', wrap(async (req, res) => {
    const [phase, submittedArr, mine, settings] = await Promise.all([
      store.getPhase(), store.getSubmitted(), store.getVotes(req.user), settingsNow(),
    ]);
    const submitted = Object.fromEntries(PARTICIPANTS.map((p) => [p, submittedArr.includes(p)]));
    let results = null;
    if (phase === 'revealed') {
      const all = {};
      for (const u of PARTICIPANTS) all[u] = await store.getVotes(u);
      results = computeResults(all, settings);
    }
    const clean = {};
    for (const [id, v] of Object.entries(mine)) if (topicIds.has(id)) clean[id] = v;
    res.json({
      participants: PARTICIPANTS, points: POINTS, title: seed.title,
      categories: catalog.categories, rev: catalog.rev, updatedBy: catalog.updatedBy,
      phase, submitted, settings, results,
      me: { user: req.user, votes: clean, submitted: submitted[req.user] },
    });
  }));

  /* ---------- votes ---------- */
  app.put('/api/votes', wrap(async (req, res) => {
    if ((await store.getPhase()) !== 'voting') return res.status(409).json({ error: 'Voting ist bereits abgeschlossen' });
    if ((await store.getSubmitted()).includes(req.user)) return res.status(409).json({ error: 'Du hast bereits abgegeben – zuerst Abgabe zurückziehen' });
    const input = (req.body && req.body.votes) || {};
    const clean = {};
    for (const [id, v] of Object.entries(input)) {
      if (!topicIds.has(id)) return res.status(400).json({ error: 'Unbekanntes Thema: ' + id });
      if (!isInt(v) || v < 0 || v > POINTS) return res.status(400).json({ error: `Ungültiger Wert (0–${POINTS})` });
      if (v > 0) clean[id] = v;
    }
    if (sum(clean) > POINTS) return res.status(400).json({ error: `Maximal ${POINTS} Punkte insgesamt` });
    await store.setVotes(req.user, clean);
    res.json({ ok: true, used: sum(clean) });
  }));

  app.post('/api/submit', wrap(async (req, res) => {
    if ((await store.getPhase()) !== 'voting') return res.status(409).json({ error: 'Voting ist bereits abgeschlossen' });
    await store.setSubmitted(req.user, true);
    res.json({ ok: true });
  }));

  app.post('/api/unsubmit', wrap(async (req, res) => {
    if ((await store.getPhase()) !== 'voting') return res.status(409).json({ error: 'Ergebnisse sind bereits aufgedeckt' });
    await store.setSubmitted(req.user, false);
    res.json({ ok: true });
  }));

  app.post('/api/reveal', wrap(async (req, res) => {
    const submitted = await store.getSubmitted();
    const all = PARTICIPANTS.every((p) => submitted.includes(p));
    if (!all && !(req.body && req.body.force)) return res.status(409).json({ error: 'Noch nicht alle haben abgegeben' });
    await store.setPhase('revealed');
    res.json({ ok: true });
  }));

  /* ---------- categories ---------- */
  app.post('/api/categories', wrap(async (req, res) => {
    const name = cleanText(req.body && req.body.name, LIMITS.name, 'Name');
    const out = await mutate(req.user, (c) => {
      if (c.categories.length >= LIMITS.categories) throw new HttpError(400, `Maximal ${LIMITS.categories} Kategorien`);
      uniqueName(c, name);
      const cat = { id: newId('c'), name, topics: [] };
      c.categories.push(cat);
      return { id: cat.id };
    });
    res.json({ ok: true, id: out.id });
  }));

  app.patch('/api/categories/:id', wrap(async (req, res) => {
    const name = cleanText(req.body && req.body.name, LIMITS.name, 'Name');
    await mutate(req.user, (c) => { const cat = findCat(c, req.params.id); uniqueName(c, name, cat.id); cat.name = name; });
    res.json({ ok: true });
  }));

  app.delete('/api/categories/:id', wrap(async (req, res) => {
    await mutate(req.user, (c) => {
      const cat = findCat(c, req.params.id);
      c.categories = c.categories.filter((k) => k.id !== cat.id);
      return { removed: cat.topics.map((t) => t.id) };
    });
    res.json({ ok: true });
  }));

  app.post('/api/categories/:id/move', wrap(async (req, res) => {
    const dir = req.body && req.body.dir;
    if (dir !== -1 && dir !== 1) throw new HttpError(400, 'dir muss -1 oder 1 sein');
    await mutate(req.user, (c) => { findCat(c, req.params.id); swap(c.categories, c.categories.findIndex((k) => k.id === req.params.id), dir); });
    res.json({ ok: true });
  }));

  /* ---------- topics ---------- */
  app.post('/api/topics', wrap(async (req, res) => {
    const b = req.body || {};
    const title = cleanText(b.title, LIMITS.title, 'Titel');
    const context = cleanText(b.context, LIMITS.context, 'Kontext', false);
    const out = await mutate(req.user, (c) => {
      if (countTopics(c) >= LIMITS.topics) throw new HttpError(400, `Maximal ${LIMITS.topics} Themen`);
      const cat = findCat(c, b.categoryId);
      const t = { id: newId('t'), title, context };
      cat.topics.push(t);
      return { id: t.id };
    });
    res.json({ ok: true, id: out.id });
  }));

  app.patch('/api/topics/:id', wrap(async (req, res) => {
    const b = req.body || {};
    const title = b.title === undefined ? undefined : cleanText(b.title, LIMITS.title, 'Titel');
    const context = b.context === undefined ? undefined : cleanText(b.context, LIMITS.context, 'Kontext', false);
    await mutate(req.user, (c) => {
      const { cat, i, topic } = findTopic(c, req.params.id);
      if (title !== undefined) topic.title = title;
      if (context !== undefined) topic.context = context;
      if (b.categoryId && b.categoryId !== cat.id) {
        const target = findCat(c, b.categoryId);
        cat.topics.splice(i, 1);
        target.topics.push(topic);
      }
    });
    res.json({ ok: true });
  }));

  app.delete('/api/topics/:id', wrap(async (req, res) => {
    await mutate(req.user, (c) => {
      const { cat, i, topic } = findTopic(c, req.params.id);
      cat.topics.splice(i, 1);
      return { removed: [topic.id] };
    });
    res.json({ ok: true });
  }));

  app.post('/api/topics/:id/move', wrap(async (req, res) => {
    const dir = req.body && req.body.dir;
    if (dir !== -1 && dir !== 1) throw new HttpError(400, 'dir muss -1 oder 1 sein');
    await mutate(req.user, (c) => { const { cat, i } = findTopic(c, req.params.id); swap(cat.topics, i, dir); });
    res.json({ ok: true });
  }));

  // restore the original topic list from topics.json (also clears all votes)
  app.post('/api/catalog/reset', wrap(async (req, res) => {
    if (!(req.body && req.body.confirm === true)) throw new HttpError(400, 'Bestätigung fehlt');
    await withLock(async () => {
      if ((await store.getPhase()) === 'revealed') throw new HttpError(409, 'Ergebnisse sind aufgedeckt – zuerst Stimmen zurücksetzen');
      catalog = seedCatalog(catalog.rev + 1);
      catalog.updatedBy = req.user;
      await store.setCatalog(JSON.stringify(catalog));
      index();
      await store.resetVotes();
    });
    res.json({ ok: true });
  }));

  /* ---------- settings / reset ---------- */
  app.post('/api/settings', wrap(async (req, res) => {
    const b = req.body || {};
    const next = {};
    const rules = { day2Minutes: [30, 1440], pitchMinutes: [1, 60], minVoters: [1, PARTICIPANTS.length] };
    for (const [key, [lo, hi]] of Object.entries(rules)) {
      if (b[key] === undefined) continue;
      if (!isInt(b[key]) || b[key] < lo || b[key] > hi) return res.status(400).json({ error: `${key}: erlaubt ${lo}–${hi}` });
      next[key] = b[key];
    }
    await store.setSettings(next);
    res.json({ ok: true });
  }));

  app.post('/api/reset', wrap(async (req, res) => {
    if (!(req.body && req.body.confirm === true)) return res.status(400).json({ error: 'Bestätigung fehlt' });
    await store.resetVotes();   // votes only; the topic list is kept
    res.json({ ok: true });
  }));

  app.use(express.static(path.join(__dirname, 'public')));
  app.listen(PORT, () => console.log(`Voting läuft auf http://localhost:${PORT}  (Teilnehmer: ${PARTICIPANTS.join(', ')}, ${POINTS} Punkte)`));
}

main().catch((e) => { console.error(e); process.exit(1); });
