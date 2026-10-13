'use strict';
const express = require('express');
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
const TOPICS_FILE = process.env.TOPICS_FILE || path.join(__dirname, 'topics.json');
const config = JSON.parse(fs.readFileSync(TOPICS_FILE, 'utf8'));

const topicList = [];
for (const cat of config.categories) {
  for (const t of cat.topics) topicList.push({ ...t, category: cat.name, idx: topicList.length });
}
const topicIds = new Set(topicList.map((t) => t.id));
if (topicIds.size !== topicList.length) throw new Error('topics.json: duplicate topic ids');

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
  let rest = units - base.reduce((a, b) => a + b, 0);
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
    return { id: t.id, title: t.title, category: t.category, context: t.context, per, total, voters, idx: t.idx };
  });
  const cmp = (a, b) => b.total - a.total || b.voters - a.voters || a.idx - b.idx;
  const deep = rows.filter((r) => r.voters >= settings.minVoters).sort(cmp);
  const pitch = rows.filter((r) => r.voters > 0 && r.voters < settings.minVoters).sort(cmp);
  const none = rows.filter((r) => r.voters === 0).sort((a, b) => a.idx - b.idx);
  allocate(deep, settings.day2Minutes);
  pitch.forEach((r) => { r.minutes = settings.pitchMinutes; });
  return {
    deep, pitch, none,
    totalPoints: rows.reduce((a, r) => a + r.total, 0),
    deepMinutes: deep.reduce((a, r) => a + r.minutes, 0),
    pitchMinutes: pitch.reduce((a, r) => a + r.minutes, 0),
  };
}

async function main() {
  const store = await createStore();
  console.log(`[store] using ${store.kind}`);
  const settingsNow = async () => ({ ...DEFAULTS, ...(await store.getSettings()) });

  const app = express();
  app.use(express.json({ limit: '50kb' }));

  app.get('/healthz', (req, res) => res.json({ ok: true, store: store.kind }));
  app.get('/api/hello', (req, res) => res.json({
    title: config.title, participants: PARTICIPANTS, points: POINTS, pinRequired: !!ACCESS_PIN,
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
      participants: PARTICIPANTS, points: POINTS, title: config.title,
      categories: config.categories, phase, submitted, settings, results,
      me: { user: req.user, votes: clean, submitted: submitted[req.user] },
    });
  }));

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
    await store.resetVotes();
    res.json({ ok: true });
  }));

  app.use(express.static(path.join(__dirname, 'public')));
  app.listen(PORT, () => console.log(`Voting läuft auf http://localhost:${PORT}  (Teilnehmer: ${PARTICIPANTS.join(', ')}, ${POINTS} Punkte)`));
}

main().catch((e) => { console.error(e); process.exit(1); });
