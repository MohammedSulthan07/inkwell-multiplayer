(function () {
  'use strict';

  const SERVER_URL = String(window.INKWELL_SERVER_URL || '').replace(/\/$/, '');
  const $ = id => document.getElementById(id);
  const state = { socket: null, room: null, roomCode: '', isHost: false, playerName: localStorage.getItem('inkwell-player-name') || '', intent: 'join', theme: localStorage.getItem('inkwell-theme') || '', clockTimer: null, roundEndTimer: null };
  const screens = ['home','name','lobby','reveal','game','end'].reduce((m, n) => (m[n] = $('screen-' + n), m), {});

  function show(name) { Object.values(screens).forEach(s => s.classList.add('hidden')); screens[name].classList.remove('hidden'); }
  function alertMsg(text, type = 'error') { const el = $('appAlert'); el.textContent = text; el.className = 'app-alert ' + (type === 'good' ? 'good' : ''); el.classList.remove('hidden'); }
  function clearAlert() { $('appAlert').classList.add('hidden'); $('appAlert').textContent = ''; }
  function setConnection(ok, text) { $('connectionPill').classList.toggle('online', !!ok); $('connectionText').textContent = text; }
  function escapeHtml(str) { return String(str ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function normalizeCode(v) { return String(v || '').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0,8); }
  function inviteUrl(code) { return location.origin + location.pathname + '?room=' + encodeURIComponent(code); }
  function myPlayer() { return state.room?.players?.find(p => p.id === state.socket?.id); }
  function currentPlayer() { return state.room?.players?.find(p => p.id === state.room.currentPlayerId); }
  function currentTeam() { const p = currentPlayer(); return p && state.room.teams?.find(t => t.id === p.teamId); }
  function isHost() { return !!(state.room && state.socket && state.room.hostId === state.socket.id); }
  function formatTime(ms) { const total = Math.max(0, Math.floor(ms / 1000)); return String(Math.floor(total/60)).padStart(2,'0') + ':' + String(total%60).padStart(2,'0'); }

  function updateTheme() {
    document.body.className = state.theme;
    document.querySelectorAll('.theme-swatch').forEach(b => b.classList.toggle('active', (b.dataset.theme || '') === state.theme));
  }
  function setupTheme() {
    updateTheme();
    $('themeToggleBtn').addEventListener('click', e => { e.stopPropagation(); $('themeMenu').classList.toggle('hidden'); });
    document.addEventListener('click', () => $('themeMenu').classList.add('hidden'));
    document.querySelectorAll('.theme-swatch').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); state.theme = b.dataset.theme || ''; localStorage.setItem('inkwell-theme', state.theme); updateTheme(); $('themeMenu').classList.add('hidden'); }));
  }

  function connect() {
    if (!SERVER_URL || SERVER_URL.includes('YOUR_')) { setConnection(false, 'Server URL missing'); alertMsg('Set your Render URL in public/config.js before deploying the frontend. For local testing, use http://localhost:10000.'); return; }
    state.socket = io(SERVER_URL, { transports: ['websocket', 'polling'], reconnection: true, reconnectionAttempts: Infinity });
    state.socket.on('connect', () => { setConnection(true, 'Online'); clearAlert(); });
    state.socket.on('disconnect', () => setConnection(false, 'Reconnecting…'));
    state.socket.on('connect_error', () => setConnection(false, 'Server unavailable'));
    state.socket.on('state', applyState);
  }

  function createRoom() {
    state.intent = 'create';
    $('nameTitle').textContent = 'Create your room'; $('nameSubtitle').textContent = 'Choose your host name. You can invite players next.';
    $('joinCodeField').classList.add('hidden'); $('playerNameInput').value = state.playerName; $('btnContinueName').textContent = 'Create room'; clearAlert(); show('name'); $('playerNameInput').focus();
  }
  function joinRoom(code = '') {
    state.intent = 'join';
    $('nameTitle').textContent = 'Join Inkwell'; $('nameSubtitle').textContent = 'Enter your name and the room code.';
    $('joinCodeField').classList.remove('hidden'); $('roomCodeInput').value = normalizeCode(code); $('playerNameInput').value = state.playerName; $('btnContinueName').textContent = 'Join room'; clearAlert(); show('name'); $('playerNameInput').focus();
  }

  function continueName() {
    const name = $('playerNameInput').value.trim().slice(0,24) || 'Player';
    state.playerName = name; localStorage.setItem('inkwell-player-name', name);
    if (!state.socket || !state.socket.connected) { alertMsg('The game server is not connected yet.'); return; }
    const action = state.intent === 'create' ? 'room:create' : 'room:join';
    const payload = state.intent === 'create' ? { name } : { name, code: normalizeCode($('roomCodeInput').value) };
    state.socket.emit(action, payload, result => {
      if (!result?.ok) { alertMsg(result?.error || 'Could not enter the room.'); return; }
      state.roomCode = result.code; applyState(result.state);
    });
  }

  function applyState(room) {
    state.room = room; state.roomCode = room.code; state.isHost = isHost();
    if (room.phase === 'lobby') renderLobby();
    else if (room.phase === 'reveal') renderReveal();
    else if (room.phase === 'game') renderGame();
    else if (room.phase === 'end') renderEnd();
  }

  function renderLobby() {
    clearAlert(); show('lobby'); $('lobbyRoomCode').textContent = state.room.code; $('roomCodeLarge').textContent = state.room.code; $('roomLinkText').textContent = inviteUrl(state.room.code); $('lobbyRole').textContent = isHost() ? 'HOST' : 'PLAYER';
    $('hostSettings').classList.toggle('hidden', !isHost()); $('lobbyHint').textContent = isHost() ? 'Share the room code or QR link, then start when everyone is ready.' : 'Waiting for the host to start the duel.';
    const players = state.room.players || [];
    $('lobbyPlayers').innerHTML = players.length ? players.map(p => `<div class="player-chip ${p.isHost?'host':''}"><span class="player-meta"><span class="player-avatar"></span><span>${escapeHtml(p.name)}</span></span><span class="player-role">${p.isHost?'Host':'Player'}</span></div>`).join('') : '<div class="empty-state">No players yet.</div>';
    if (isHost()) syncSettingsForm();
    $('qrCode').innerHTML = '';
    try { new QRCode($('qrCode'), { text: inviteUrl(state.room.code), width: 128, height: 128, correctLevel: QRCode.CorrectLevel.M }); } catch {}
  }

  function syncSettingsForm() {
    const s = state.room.settings; $('toggleSolo').classList.toggle('on', !s.teamMode); $('toggleTeams').classList.toggle('on', s.teamMode); $('numTeams').disabled = !s.teamMode; $('numTeams').value = s.numTeams; $('modeSelect').value = s.mode; $('minutesInput').value = s.matchMinutes; $('turnSecondsInput').value = s.turnSeconds;
  }
  function pushSettings() {
    if (!isHost()) return;
    state.socket.emit('room:settings', { teamMode: $('toggleTeams').classList.contains('on'), numTeams: Number($('numTeams').value), mode: $('modeSelect').value, matchMinutes: Number($('minutesInput').value), turnSeconds: Number($('turnSecondsInput').value) });
  }

  function renderReveal() {
    show('reveal'); const s = state.room, p = currentPlayer(); $('revealLetter').textContent = s.letter; $('revealRulesText').textContent = `${s.settings.turnSeconds} seconds per turn · +10 correct · −5 wrong or timeout`; $('revealStarter').textContent = p ? p.name + (s.settings.teamMode ? ` (${(s.teams.find(t=>t.id===p.teamId)||{}).name || ''})` : '') : '—'; $('revealWaitHint').textContent = isHost() ? 'The duel is opening…' : 'The host has started the duel…';
  }

  function renderGame() {
    show('game'); const s = state.room, p = currentPlayer(), me = myPlayer(); $('gameLetter').textContent = s.letter; $('roundInfo').textContent = `Letter ${s.letter} · ${s.usedWords.length} word${s.usedWords.length===1?'':'s'} claimed`; $('clockInfo').textContent = formatTime(Date.now() - s.matchStart); $('curPlayerName').textContent = p?.name || '—';
    if (s.settings.teamMode) { $('curTeamWrap').classList.remove('hidden'); $('curTeamName').textContent = currentTeam()?.name || '—'; } else $('curTeamWrap').classList.add('hidden');
    $('timerNum').textContent = Math.max(0, Math.ceil((s.turnDeadline - Date.now()) / 1000));
    const myTurn = !!(me && s.currentPlayerId === me.id);
    $('wordInput').disabled = !myTurn; $('btnSubmit').disabled = !myTurn; $('wordInput').placeholder = myTurn ? 'Type a word…' : 'Wait for your turn…';
    renderResult(s.lastResult); renderScoreboard(); $('usedWordsBox').innerHTML = s.usedWords.length ? '<b>Claimed:</b> ' + s.usedWords.map(escapeHtml).join(', ') : '';
    clearInterval(state.clockTimer); state.clockTimer = setInterval(() => { if (!state.room || state.room.phase !== 'game') return; $('clockInfo').textContent = formatTime(Date.now() - state.room.matchStart); $('timerNum').textContent = Math.max(0, Math.ceil((state.room.turnDeadline - Date.now()) / 1000)); }, 250);
  }

  function renderResult(result) {
    if (!result) { $('resultBanner').innerHTML = ''; return; }
    const cls = result.type === 'good' ? 'good' : result.type === 'bad' ? 'bad' : 'neutral';
    const label = result.points > 0 ? `+${result.points}` : `${result.points}`;
    const player = state.room.players.find(p => p.id === result.playerId);
    $('resultBanner').innerHTML = `<div class="result-banner ${cls}"><span class="stamp">${label}</span><span class="result-text"><b>${escapeHtml(result.word ? '"'+result.word+'"' : (player?.name || 'Player'))} ${result.points > 0 ? 'accepted' : 'rejected'}</b><span class="meaning">${escapeHtml(result.message || '')}</span></span></div>`;
  }

  function renderScoreboard() {
    const s = state.room, box = $('sbRows');
    if (s.settings.teamMode) {
      box.innerHTML = s.teams.map(t => { const active = s.players.find(p => p.id === s.currentPlayerId)?.teamId === t.id && !t.eliminated; const scoreCls = t.score < 0 ? 'neg' : t.score > 0 ? 'pos' : ''; let html = `<div class="sb-row team-head ${active?'active':''} ${t.eliminated?'eliminated':''}"><span><span class="team-swatch" style="background:${t.color}"></span>${escapeHtml(t.name)}${t.eliminated?' (out)':''}</span><span class="sb-score ${scoreCls}">${t.score>0?'+':''}${t.score}</span></div>`; s.players.filter(p => p.teamId === t.id).forEach(p => { const sc = p.score < 0 ? 'neg' : p.score > 0 ? 'pos' : ''; html += `<div class="sb-row member"><span>${escapeHtml(p.name)}</span><span class="sb-score ${sc}">${p.score>0?'+':''}${p.score}</span></div>`; }); return html; }).join('');
    } else {
      box.innerHTML = s.players.map(p => { const sc = p.score < 0 ? 'neg' : p.score > 0 ? 'pos' : ''; return `<div class="sb-row ${p.id===s.currentPlayerId&&!p.eliminated?'active':''} ${p.eliminated?'eliminated':''}"><span>${escapeHtml(p.name)}${p.eliminated?' (out)':''}</span><span class="sb-score ${sc}">${p.score>0?'+':''}${p.score}</span></div>`; }).join('');
    }
  }

  function renderEnd() {
    show('end'); clearInterval(state.clockTimer); const s = state.room;
    let rows = [], winner = null;
    if (s.settings.teamMode) { rows = [...s.teams].sort((a,b)=>b.score-a.score); winner = rows[0]; $('winnerName').textContent = winner ? `${winner.name} wins` : 'Draw'; $('finalRows').innerHTML = rows.map((t,i)=>`<div class="final-row ${i===0?'win':''}"><span>${i+1}. ${escapeHtml(t.name)}${t.eliminated?' (out)':''}</span><span>${t.score>0?'+':''}${t.score}</span></div>` + s.players.filter(p=>p.teamId===t.id).map(p=>`<div class="final-row member"><span>${escapeHtml(p.name)}</span><span>${p.score>0?'+':''}${p.score}</span></div>`).join('')).join(''); }
    else { rows = [...s.players].sort((a,b)=>b.score-a.score); winner = rows[0]; $('winnerName').textContent = winner ? `${winner.name} wins` : 'Draw'; $('finalRows').innerHTML = rows.map((p,i)=>`<div class="final-row ${i===0?'win':''}"><span>${i+1}. ${escapeHtml(p.name)}${p.eliminated?' (out)':''}</span><span>${p.score>0?'+':''}${p.score}</span></div>`).join(''); }
    $('endReason').textContent = s.endReason || 'The match has ended.';
  }

  function submitWord() {
    if (!state.socket || !state.room || state.room.phase !== 'game') return;
    const me = myPlayer(); if (!me || state.room.currentPlayerId !== me.id) return;
    const raw = $('wordInput').value.trim(); if (!raw) return;
    $('btnSubmit').disabled = true; $('wordInput').disabled = true;
    state.socket.emit('game:submit', { word: raw }, res => { if (!res?.ok) { alertMsg(res?.error || 'Submission failed.'); renderGame(); } else $('wordInput').value = ''; });
  }

  function copyInvite() { navigator.clipboard?.writeText(inviteUrl(state.roomCode)).then(() => alertMsg('Invite link copied.', 'good')).catch(() => alertMsg(inviteUrl(state.roomCode), 'good')); }
  function leaveRoom() { if (state.socket) state.socket.emit('room:leave', {}, () => { state.room = null; state.roomCode = ''; show('home'); }); else show('home'); }

  $('btnCreateRoom').addEventListener('click', createRoom);
  $('btnShowJoin').addEventListener('click', () => joinRoom(new URLSearchParams(location.search).get('room') || ''));
  $('btnBackHome').addEventListener('click', () => show('home'));
  $('btnContinueName').addEventListener('click', continueName);
  $('playerNameInput').addEventListener('keydown', e => { if (e.key === 'Enter') continueName(); });
  $('roomCodeInput').addEventListener('input', e => e.target.value = normalizeCode(e.target.value));
  $('btnCopyInvite').addEventListener('click', copyInvite);
  $('btnLeaveRoom').addEventListener('click', leaveRoom);
  $('btnStartLobby').addEventListener('click', () => { if (!isHost()) return; $('btnStartLobby').disabled = true; state.socket.emit('room:settings', { teamMode: $('toggleTeams').classList.contains('on'), numTeams: Number($('numTeams').value), mode: $('modeSelect').value, matchMinutes: Number($('minutesInput').value), turnSeconds: Number($('turnSecondsInput').value) }, () => state.socket.emit('game:start', {}, result => { $('btnStartLobby').disabled = false; if (!result?.ok) alertMsg(result?.error || 'Could not start the game.'); })); });
  $('toggleSolo').addEventListener('click', () => { $('toggleSolo').classList.add('on'); $('toggleTeams').classList.remove('on'); $('numTeams').disabled = true; pushSettings(); });
  $('toggleTeams').addEventListener('click', () => { $('toggleTeams').classList.add('on'); $('toggleSolo').classList.remove('on'); $('numTeams').disabled = false; pushSettings(); });
  ['numTeams','modeSelect','minutesInput','turnSecondsInput'].forEach(id => $(id).addEventListener('change', pushSettings));
  $('btnSubmit').addEventListener('click', submitWord); $('wordInput').addEventListener('keydown', e => { if (e.key === 'Enter') submitWord(); });
  $('btnBackToLobby').addEventListener('click', () => { if (!isHost()) { alertMsg('Only the host can start another duel in this room.'); return; } state.socket.emit('game:reset', {}, result => { if (!result?.ok) alertMsg(result?.error || 'Could not reset the room.'); }); });
  $('btnNewRoom').addEventListener('click', () => { state.room = null; state.roomCode = ''; show('home'); });

  window.addEventListener('beforeunload', () => { if (state.socket && state.socket.connected) state.socket.disconnect(); });
  setupTheme(); connect();
  const inviteCode = new URLSearchParams(location.search).get('room'); if (inviteCode) setTimeout(() => joinRoom(inviteCode), 300);
})();
