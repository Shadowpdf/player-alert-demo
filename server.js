// server.js
// Player Entry Alert API — Real-time watcher + static React serving (single service)
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

// Optional providers
const twilio = require('twilio');
const sgMail = require('@sendgrid/mail');

const app = express();
app.use(cors());
app.use(express.json());

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_FROM,
  SENDGRID_API_KEY,
  SENDGRID_FROM,
  PORT
} = process.env;

let twilioClient = null;
if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
  twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
}
if (SENDGRID_API_KEY) sgMail.setApiKey(SENDGRID_API_KEY);

// ---------- Helpers ----------
function ymd(d = new Date()) {
  const dt = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return dt.toISOString().slice(0, 10);
}

async function fetchTeamsAFL() {
  const { data } = await axios.get('https://statsapi.mlb.com/api/v1/teams', {
    params: { sportId: 11, season: 2025, activeStatus: 'Y' },
  });
  return data.teams || [];
}

async function getTeamIdByName(teamName) {
  const teams = await fetchTeamsAFL();
  let hit =
    teams.find(t => t.name.toLowerCase() === teamName.toLowerCase()) ||
    teams.find(t => (t.teamName || '').toLowerCase() === teamName.toLowerCase()) ||
    teams.find(t => t.name.toLowerCase().includes(teamName.toLowerCase()));
  if (!hit) throw new Error(`Could not resolve team id for "${teamName}". Try entering a gamePk or enable Simulation Mode.`);
  return hit.id;
}

async function getScheduleForDate(teamId, date) {
  const { data } = await axios.get('https://statsapi.mlb.com/api/v1/schedule', {
    params: { sportId: 11, teamId, date },
  });
  const game = data.dates?.[0]?.games?.[0];
  return game
    ? { gamePk: game.gamePk, status: game.status?.detailedState || 'Scheduled', date }
    : null;
}

async function fetchLiveFeed(gamePk) {
  const { data } = await axios.get(`https://statsapi.mlb.com/api/v1.1/game/${gamePk}/feed/live`);
  return data;
}

function playerAppearedFromBoxscore(match) {
  if (!match) return false;
  const bo = match?.battingOrder;
  const bat = match?.stats?.batting || {};
  const fld = match?.stats?.fielding || {};
  const pit = match?.stats?.pitching || {};

  const battingActivity =
    (bat.atBats || 0) > 0 ||
    (bat.plateAppearances || 0) > 0 ||
    (bat.hits || 0) > 0 ||
    (bat.runs || 0) > 0 ||
    (bat.rbi || 0) > 0;

  const fieldingActivity =
    (fld.putOuts || 0) > 0 ||
    (fld.assists || 0) > 0 ||
    (fld.chances || 0) > 0;

  const pitchingActivity =
    (pit.battersFaced || 0) > 0 ||
    (pit.pitchesThrown || 0) > 0 ||
    (pit.inningsPitched && pit.inningsPitched !== '0.0');

  return Boolean(bo || battingActivity || fieldingActivity || pitchingActivity);
}

function playerAppearedFromPlays(allPlays = [], playerName) {
  if (!allPlays?.length || !playerName) return false;
  const needle = playerName.toLowerCase();
  const keywords = [
    'defensive substitution',
    'pinch-hits','pinch hits',
    'pinch-running','pinch runs',
    'enters the game','replaces',
  ];
  for (const p of allPlays) {
    const desc = (p?.result?.description || '').toLowerCase();
    if (!desc.includes(needle)) continue;
    if (keywords.some(k => desc.includes(k))) return true;
  }
  return false;
}

// ---------- API: gamePk ----------
app.get('/api/afl/gamePk', async (req, res) => {
  try {
    const teamName = req.query.team || 'Glendale Desert Dogs';
    const baseDate = req.query.date || ymd(new Date()); // <-- fixed extra parenthesis
    const teamId = await getTeamIdByName(teamName);

    const exact = await getScheduleForDate(teamId, baseDate);
    if (exact) return res.json(exact);

    for (let i = 1; i <= 3; i++) {
      const d = new Date(baseDate); d.setDate(d.getDate() - i);
      const found = await getScheduleForDate(teamId, ymd(d));
      if (found) return res.json(found);
    }
    for (let i = 1; i <= 3; i++) {
      const d = new Date(baseDate); d.setDate(d.getDate() + i);
      const found = await getScheduleForDate(teamId, ymd(d));
      if (found) return res.json(found);
    }
    return res.json({ gamePk: null, status: 'No game found in +/-3 days', date: baseDate });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- API: playerStatus ----------
app.get('/api/playerStatus', async (req, res) => {
  try {
    const { gamePk, playerName, team, simulate } = req.query;

    if (simulate === '1') {
      return res.json({
        player: playerName || 'Sample Player',
        inGame: true,
        side: 'home',
        battingOrder: '501',
        position: '2B',
        rawGameState: 'In Progress (Simulated)',
        simulated: true,
      });
    }

    if (!gamePk || !playerName) {
      return res.status(400).json({ error: 'gamePk and playerName are required (or use simulate=1)' });
    }

    const data = await fetchLiveFeed(gamePk);
    const state = data?.gameData?.status?.detailedState || 'Unknown';

    const homeTeamName = data?.gameData?.teams?.home?.name || '';
    const awayTeamName = data?.gameData?.teams?.away?.name || '';
    if (team) {
      const t = team.toLowerCase();
      const matchesTeam =
        homeTeamName.toLowerCase().includes(t) || awayTeamName.toLowerCase().includes(t);
      if (!matchesTeam) {
        return res.status(409).json({
          error: `Team mismatch: "${team}" not found in this game.`,
          gameTeams: { home: homeTeamName, away: awayTeamName },
          code: 'TEAM_MISMATCH'
        });
      }
    }

    const home = data?.liveData?.boxscore?.teams?.home;
    const away = data?.liveData?.boxscore?.teams?.away;
    if (!home || !away) {
      return res.json({ player: playerName, inGame: false, rawGameState: state, reason: 'Boxscore not available yet' });
    }

    const findByName = side => {
      const entries = Object.values(side.players || {});
      return entries.find(p => p?.person?.fullName?.toLowerCase() === playerName.toLowerCase());
    };

    const homeMatch = findByName(home);
    const awayMatch = findByName(away);
    if (!homeMatch && !awayMatch) {
      return res.status(404).json({
        error: `Player "${playerName}" not listed on either roster for gamePk ${gamePk}.`,
        code: 'PLAYER_NOT_IN_GAME',
        rawGameState: state,
        gameTeams: { home: homeTeamName, away: awayTeamName }
      });
    }

    const whichSide = homeMatch ? 'home' : 'away';
    const match = homeMatch || awayMatch;

    const entered =
      playerAppearedFromBoxscore(match) ||
      playerAppearedFromPlays(data?.liveData?.plays?.allPlays, playerName);

    return res.json({
      player: playerName,
      inGame: entered,
      side: whichSide,
      battingOrder: match?.battingOrder || null,
      position: match?.position?.abbreviation || null,
      rawGameState: state,
    });
  } catch (e) {
    const msg = e?.response?.data?.message || e.message || 'Unknown error';
    const status = e?.response?.status || 500;
    res.status(status).json({ error: msg });
  }
});

// ---------- Email test ----------
async function sendEmail(to, subject, html) {
  if (!SENDGRID_API_KEY || !SENDGRID_FROM) throw new Error('SendGrid is not configured');
  const msg = { to, from: SENDGRID_FROM, subject, html };
  return sgMail.send(msg);
}
app.post('/api/test/email', async (req, res) => {
  try {
    const { to, subject, html } = req.body || {};
    if (!to) return res.status(400).json({ error: 'Missing "to" email address' });
    const subj = subject || 'Test Email from Player Alert System ✅';
    const body = html || '<h2>Test Email</h2><p>This is a test from the Player Alert System.</p>';
    await sendEmail(to, subj, body);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------- Real-time watcher (adaptive) ----------
const POLL_FAST = 5000;
const POLL_SLOW = 30000;
const POLL_FINAL = 60000;

const watchers = new Map();
let nextWatchId = 1;

async function resolveGamePkIfNeeded(team, date, gamePk, simulate) {
  if (simulate) return '(simulation)';
  if (gamePk) return gamePk.toString();

  const teamId = await getTeamIdByName(team);
  const exact = await getScheduleForDate(teamId, date || ymd(new Date()));
  if (exact?.gamePk) return exact.gamePk.toString();

  for (let i = 1; i <= 3; i++) {
    const d = new Date(date); d.setDate(d.getDate() - i);
    const back = await getScheduleForDate(teamId, ymd(d));
    if (back?.gamePk) return back.gamePk.toString();
  }
  for (let i = 1; i <= 3; i++) {
    const d = new Date(date); d.setDate(d.getDate() + i);
    const fwd = await getScheduleForDate(teamId, ymd(d));
    if (fwd?.gamePk) return fwd.gamePk.toString();
  }
  throw new Error('No game found for team near the given date');
}

function formatAlertText({ team, playerName, gamePk }, status) {
  const now = new Date().toLocaleString();
  const hdr = `ALERT: ${playerName} just entered the game`;
  const body =
    `Team: ${team}\n` +
    `GamePk: ${gamePk}\n` +
    `When: ${now}\n` +
    `Side: ${status.side || '-'}\n` +
    `Batting Order: ${status.battingOrder || '-'}\n` +
    `Position: ${status.position || '-'}\n` +
    `State: ${status.rawGameState || '-'}`;
  return { subject: hdr, html: `<h2>${hdr}</h2><pre>${body}</pre>` };
}

async function getStatusOnce({ gamePk, playerName, team, simulate }) {
  if (simulate) {
    return { inGame: true, side: 'home', battingOrder: '501', position: '2B', rawGameState: 'In Progress (Simulated)' };
  }
  const data = await fetchLiveFeed(gamePk);
  const state = data?.gameData?.status?.detailedState || 'Unknown';

  const home = data?.liveData?.boxscore?.teams?.home;
  const away = data?.liveData?.boxscore?.teams?.away;

  let side = null;
  let match = null;
  if (home && away) {
    const findByName = s => {
      const entries = Object.values(s.players || {});
      return entries.find(p => p?.person?.fullName?.toLowerCase() === playerName.toLowerCase());
    };
    const h = findByName(home);
    const a = findByName(away);
    side = h ? 'home' : (a ? 'away' : null);
    match = h || a;
  }

  const entered =
    playerAppearedFromBoxscore(match) ||
    playerAppearedFromPlays(data?.liveData?.plays?.allPlays, playerName);

  return {
    inGame: Boolean(entered),
    side,
    battingOrder: match?.battingOrder || null,
    position: match?.position?.abbreviation || null,
    rawGameState: state,
  };
}

function startAdaptiveWatcher(params) {
  const {
    team, playerName, date, gamePk, simulate,
    emailTo, cooldownSec = 300, stopAfterAlert = true,
  } = params;

  const id = (nextWatchId++).toString();
  const state = { id, params: { ...params }, lastInGame: false, lastAlertAt: 0, stopped: false, timer: null };

  const scheduleNext = (ms) => {
    if (state.stopped) return;
    clearTimeout(state.timer);
    state.timer = setTimeout(loop, ms);
  };

  const loop = async () => {
    try {
      const s = await getStatusOnce({ gamePk, playerName, team, simulate });

      let interval = POLL_SLOW;
      const st = (s.rawGameState || '').toLowerCase();
      if (st.includes('progress')) interval = POLL_FAST;
      else if (st.includes('final')) interval = POLL_FINAL;

      if (!state.lastInGame && s.inGame) {
        const now = Date.now();
        if (now - state.lastAlertAt >= (cooldownSec * 1000)) {
          const { subject, html } = formatAlertText({ team, playerName, gamePk }, s);
          if (emailTo) { try { await sendEmail(emailTo, subject, html); } catch (e) { console.error('Email error:', e.message); } }
          state.lastAlertAt = now;
          if (stopAfterAlert) { stopWatcher(id); return; }
        }
      }

      state.lastInGame = s.inGame;
      scheduleNext(interval);
    } catch (e) {
      console.error('Watcher error:', e.message);
      scheduleNext(POLL_SLOW);
    }
  };

  loop();
  watchers.set(id, state);
  return { id };
}

function stopWatcher(id) {
  const st = watchers.get(id);
  if (!st) return false;
  st.stopped = true;
  if (st.timer) clearTimeout(st.timer);
  watchers.delete(id);
  return true;
}

app.post('/api/watch/start', async (req, res) => {
  try {
    const {
      team = 'Glendale Desert Dogs',
      playerName,
      date = ymd(new Date()),
      gamePk,
      simulate = false,
      emailTo,
      cooldownSec = 300,
      stopAfterAlert = true,
    } = req.body || {};
    if (!playerName) return res.status(400).json({ error: 'playerName is required' });

    const pk = await resolveGamePkIfNeeded(team, date, gamePk, simulate);
    const { id } = startAdaptiveWatcher({ team, playerName, date, gamePk: pk, simulate, emailTo, cooldownSec, stopAfterAlert });
    res.json({ id, gamePk: pk });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/watch/stop', (req, res) => {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: 'id is required' });
  const ok = stopWatcher(id);
  res.json({ ok });
});

app.get('/api/watch', (req, res) => {
  const list = [...watchers.values()].map(w => ({
    id: w.id,
    playerName: w.params.playerName,
    team: w.params.team,
    gamePk: w.params.gamePk,
    simulate: w.params.simulate,
    lastInGame: w.lastInGame,
    lastAlertAt: w.lastAlertAt
  }));
  res.json({ watchers: list });
});

// ---------- Serve React build ----------
// Serve static assets
const buildPath = path.join(__dirname, 'client', 'build');
app.use(express.static(buildPath));

// Health/root
app.get('/', (_req, res) => res.sendFile(path.join(buildPath, 'index.html')));

// Catch-all for any non-API route (Express 5-safe)
app.get(/^(?!\/api\/).+/, (req, res) => {
  res.sendFile(path.join(buildPath, 'index.html'));
});

const LISTEN_PORT = PORT || 5000;
app.listen(LISTEN_PORT, () => console.log(`✅ Server running on port ${LISTEN_PORT}`));
