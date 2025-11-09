import React, { useEffect, useMemo, useState, useCallback } from 'react';
import axios from 'axios';

const API = '';

export default function App() {
  const [team, setTeam] = useState('Glendale Desert Dogs');
  const [playerName, setPlayerName] = useState('Cade Doughty');
  const [date, setDate] = useState(() => new Date().toISOString().slice(0,10));
  const [gamePk, setGamePk] = useState('');
  const [simulate, setSimulate] = useState(false);
  const [status, setStatus] = useState(null);
  const [banner, setBanner] = useState({ type: 'idle', text: 'Loading player status…' });
  const [watchId, setWatchId] = useState(null);
  const [emailTo, setEmailTo] = useState('');

  const params = useMemo(() => ({
    team, playerName, date, gamePk: gamePk.trim(), simulate
  }), [team, playerName, date, gamePk, simulate]);

  const resetBanner = useCallback(() => setBanner({ type: 'idle', text: 'Loading player status…' }), []);

  useEffect(() => {
    let kill = false;
    const fetch = async () => {
      try {
        const qs = new URLSearchParams();
        if (params.simulate) qs.set('simulate', '1');
        if (params.gamePk) qs.set('gamePk', params.gamePk);
        if (params.playerName) qs.set('playerName', params.playerName);
        if (params.team) qs.set('team', params.team);
        const { data } = await axios.get(`${API}/api/playerStatus?${qs.toString()}`);
        if (kill) return;
        setStatus(data);
        if (data.inGame) setBanner({ type: 'ok', text: `✅ ALERT: ${params.playerName} is now in the game!` });
        else setBanner({ type: 'waiting', text: `🕒 Waiting for ${params.playerName} to enter the game...` });
      } catch (e) {
        if (kill) return;
        setStatus(null);
        setBanner({ type: 'err', text: e?.response?.data?.error || e.message });
      }
    };
    resetBanner();
    fetch();
    const id = setInterval(fetch, 15000);
    return () => { kill = true; clearInterval(id); };
  }, [params, resetBanner]);

  const findGamePk = async () => {
    try {
      const qs = new URLSearchParams({ team, date });
      const { data } = await axios.get(`${API}/api/afl/gamePk?${qs.toString()}`);
      if (data?.gamePk) {
        setGamePk(String(data.gamePk));
      } else {
        alert(data?.status || 'No game found');
      }
    } catch (e) {
      alert(e?.response?.data?.error || e.message);
    }
  };

  const startServerWatcher = async () => {
    try {
      const body = {
        team, playerName, date,
        gamePk: gamePk || undefined,
        simulate,
        emailTo: emailTo || undefined,
        cooldownSec: 300,
        stopAfterAlert: true
      };
      const { data } = await axios.post(`${API}/api/watch/start`, body);
      setWatchId(data.id);
      if (!gamePk) setGamePk(String(data.gamePk || ''));
      alert(`Server watcher started. id=${data.id}, gamePk=${data.gamePk}`);
    } catch (e) {
      alert(e?.response?.data?.error || e.message);
    }
  };

  const stopServerWatcher = async () => {
    if (!watchId) return;
    try {
      const { data } = await axios.post(`${API}/api/watch/stop`, { id: watchId });
      if (data.ok) { setWatchId(null); alert('Watcher stopped'); }
    } catch (e) {
      alert(e?.response?.data?.error || e.message);
    }
  };

  const sendTestEmail = async () => {
    if (!emailTo) return alert('Enter an email address first.');
    try {
      const { data } = await axios.post(`${API}/api/test/email`, {
        to: emailTo,
        subject: 'Player Alert — Test Email ✅',
        html: `<h2>It works!</h2><p>Server can send emails.</p>`
      });
      if (data.ok) alert('Email sent 👍');
    } catch (e) {
      alert(e?.response?.data?.error || e.message);
    }
  };

  const bannerStyle = {
    padding: '12px 16px',
    borderRadius: 12,
    marginTop: 12,
    color: '#111',
    background: banner.type === 'ok' ? '#b7f7b7'
            : banner.type === 'err' ? '#ffd1d1'
            : '#f0f0f0'
  };

  return (
    <div style={{ maxWidth: 720, margin: '24px auto', fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif' }}>
      <h1>⚾ Player Entry Alert (AFL)</h1>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <label>Team
          <input value={team} onChange={e => setTeam(e.target.value)} style={{ width:'100%' }}/>
        </label>
        <label>Player
          <input value={playerName} onChange={e => setPlayerName(e.target.value)} style={{ width:'100%' }}/>
        </label>
        <label>Date
          <input type="date" value={date} onChange={e => setDate(e.target.value)} style={{ width:'100%' }}/>
        </label>
        <label>Manual gamePk (optional)
          <input value={gamePk} onChange={e => setGamePk(e.target.value)} style={{ width:'100%' }}/>
        </label>
      </div>

      <div style={{ marginTop: 8 }}>
        <button onClick={findGamePk}>Find Today’s gamePk</button>
        <label style={{ marginLeft: 16 }}>
          <input type="checkbox" checked={simulate} onChange={e => setSimulate(e.target.checked)} />
          {' '}Simulation Mode
        </label>
      </div>

      <div style={{ marginTop: 16 }}>
        <label>Email To (for alerts / test):
          <input value={emailTo} onChange={e => setEmailTo(e.target.value)} placeholder="you@example.com" style={{ width:'100%', marginTop: 4 }}/>
        </label>
        <div style={{ marginTop: 8 }}>
          <button onClick={sendTestEmail}>Send Test Email</button>
          <button onClick={startServerWatcher} style={{ marginLeft: 8 }}>Start Server Watcher</button>
          <button onClick={stopServerWatcher} disabled={!watchId} style={{ marginLeft: 8 }}>Stop Watcher</button>
        </div>
      </div>

      <div style={bannerStyle}>{banner.text}</div>

      <div style={{ marginTop: 16, fontSize: 14, opacity: 0.8 }}>
        <div><b>GamePk:</b> {gamePk || '—'}</div>
        <div><b>Game Status:</b> {status?.rawGameState || 'Loading…'}</div>
        {status && (
          <pre style={{ background:'#fafafa', padding:12, borderRadius:8, overflow:'auto' }}>
{JSON.stringify(status, null, 2)}
          </pre>
        )}
      </div>
    </div>
  );
}
