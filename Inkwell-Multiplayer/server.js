'use strict';

const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.get('/health', (_req, res) => res.json({ ok: true, service: 'inkwell-server', time: new Date().toISOString() }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling']
});

const PORT = Number(process.env.PORT || 10000);
const rooms = new Map();
const socketRoom = new Map();

const COLORS = ['var(--teamA)', 'var(--teamB)', 'var(--teamC)', 'var(--teamD)'];
const WORD_CACHE = new Map();
const REVEAL_MS = 2500;
const RESULT_SHOW_MS = 1800;
const MAX_PLAYERS = 20;
const ROOM_TTL_MS = 60 * 60 * 1000;
const DISCONNECT_GRACE_MS = 60 * 1000;

function roomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = 'INK-';
  for (let i = 0; i < 4; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function uniqueRoomCode() {
  let code;
  do code = roomCode(); while (rooms.has(code));
  return code;
}

function cleanName(name) {
  return String(name || '').replace(/[<>]/g, '').trim().slice(0, 24) || 'Player';
}

function cleanCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 8);
}

function normalizeSettings(input = {}) {
  const teamMode = !!input.teamMode;
  const numTeams = Math.max(2, Math.min(4, Number(input.numTeams) || 2));
  const mode = ['two', 'all', 'time'].includes(input.mode) ? input.mode : 'two';
  const matchMinutes = Math.max(1, Math.min(30, Number(input.matchMinutes) || 10));
  const turnSeconds = Math.max(5, Math.min(60, Number(input.turnSeconds) || 20));
  return { teamMode, numTeams, mode, matchMinutes, turnSeconds };
}

function newRoom(hostId, hostName) {
  const code = uniqueRoomCode();
  const now = Date.now();
  const room = {
    code,
    hostId,
    createdAt: now,
    lastActivity: now,
    phase: 'lobby',
    settings: normalizeSettings(),
    letter: '?',
    currentPlayerId: '',
    turnDeadline: 0,
    matchStart: 0,
    revealEndsAt: 0,
    usedWords: [],
    lastResult: null,
    teams: [],
    players: new Map(),
    turnOrder: [],
    turnIndex: -1,
    endingAt: 0,
    endReason: ''
  };
  room.players.set(hostId, {
    id: hostId, name: hostName, score: 0, teamId: 0, eliminated: false,
    connected: true, disconnectedAt: 0, isHost: true, joinedAt: now
  });
  rooms.set(code, room);
  return room;
}

function snapshot(room) {
  const players = Array.from(room.players.values()).map(p => ({
    id: p.id, name: p.name, score: p.score, teamId: p.teamId,
    eliminated: p.eliminated, connected: p.connected, isHost: p.isHost
  }));
  return {
    code: room.code,
    hostId: room.hostId,
    phase: room.phase,
    settings: room.settings,
    letter: room.letter,
    currentPlayerId: room.currentPlayerId,
    turnDeadline: room.turnDeadline,
    matchStart: room.matchStart,
    matchDurationMs: room.settings.matchMinutes * 60 * 1000,
    revealEndsAt: room.revealEndsAt,
    usedWords: room.usedWords.slice(-80),
    lastResult: room.lastResult,
    teams: room.teams,
    players,
    endReason: room.endReason,
    serverNow: Date.now()
  };
}

function broadcast(room) {
  room.lastActivity = Date.now();
  io.to(room.code).emit('state', snapshot(room));
}

function activePlayers(room) {
  return Array.from(room.players.values()).filter(p => !isEliminated(room, p));
}

function isEliminated(room, p) {
  return !!(p.eliminated || (room.settings.teamMode && room.teams[p.teamId] && room.teams[p.teamId].eliminated));
}

function buildTeams(room) {
  room.teams = Array.from({ length: room.settings.numTeams }, (_, i) => ({
    id: i, name: `Team ${i + 1}`, score: 0, eliminated: false, color: COLORS[i]
  }));
  const players = Array.from(room.players.values());
  players.forEach((p, i) => { p.teamId = i % room.settings.numTeams; });
}

function startGame(room) {
  if (room.phase !== 'lobby') return false;
  if (room.players.size < 2) throw new Error('At least 2 players are required.');
  room.settings = normalizeSettings(room.settings);
  buildTeams(room);
  room.letter = String.fromCharCode(65 + Math.floor(Math.random() * 26));
  room.usedWords = [];
  room.lastResult = null;
  room.turnOrder = activePlayers(room).map(p => p.id).sort(() => Math.random() - 0.5);
  room.turnIndex = Math.floor(Math.random() * room.turnOrder.length);
  room.phase = 'reveal';
  room.revealEndsAt = Date.now() + REVEAL_MS;
  room.matchStart = 0;
  room.currentPlayerId = room.turnOrder[room.turnIndex];
  room.turnDeadline = 0;
  room.endReason = '';
  broadcast(room);
  setTimeout(() => beginTurn(room.code), REVEAL_MS);
  return true;
}

function beginTurn(code) {
  const room = rooms.get(code);
  if (!room || room.phase !== 'reveal') return;
  room.phase = 'game';
  if (!room.matchStart) room.matchStart = Date.now();
  room.turnDeadline = Date.now() + room.settings.turnSeconds * 1000;
  room.lastResult = null;
  broadcast(room);
}

function nextActivePlayer(room) {
  const n = room.turnOrder.length;
  if (!n) return null;
  for (let step = 1; step <= n; step++) {
    const idx = (room.turnIndex + step) % n;
    const p = room.players.get(room.turnOrder[idx]);
    if (p && !isEliminated(room, p)) {
      room.turnIndex = idx;
      return p;
    }
  }
  return null;
}

function checkEnd(room) {
  if (room.settings.teamMode) {
    const eliminated = room.teams.filter(t => t.eliminated).length;
    const remaining = room.teams.filter(t => !t.eliminated);
    if (remaining.length <= 1) {
      room.endReason = remaining.length ? `${remaining[0].name} is the last team standing.` : 'Every team has gone into the red.';
      return true;
    }
    if (room.settings.mode === 'two' && eliminated >= 2) {
      room.endReason = 'Two teams have gone into the red.';
      return true;
    }
    if (room.settings.mode === 'all' && eliminated >= room.teams.length) {
      room.endReason = 'Every team has gone into the red.';
      return true;
    }
  } else {
    const active = room.players.size - Array.from(room.players.values()).filter(p => p.eliminated).length;
    const eliminated = Array.from(room.players.values()).filter(p => p.eliminated).length;
    if (active <= 1) {
      const survivor = activePlayers(room)[0];
      room.endReason = survivor ? `${survivor.name} is the last one standing.` : 'Every player has gone into the red.';
      return true;
    }
    if (room.settings.mode === 'two' && eliminated >= 2) {
      room.endReason = 'Two players have gone into the red.';
      return true;
    }
    if (room.settings.mode === 'all' && eliminated >= room.players.size) {
      room.endReason = 'Every player has gone into the red.';
      return true;
    }
  }
  if (room.settings.mode === 'time' && room.matchStart && Date.now() - room.matchStart >= room.settings.matchMinutes * 60 * 1000) {
    room.endReason = `The ${room.settings.matchMinutes}-minute clock ran out.`;
    return true;
  }
  return false;
}

function endGame(room) {
  room.phase = 'end';
  room.turnDeadline = 0;
  room.endingAt = Date.now();
  broadcast(room);
}

function resultForWord(room, player, correct, message, word = '', unverified = false) {
  player.score += correct ? 10 : -5;
  if (room.settings.teamMode && room.teams[player.teamId]) room.teams[player.teamId].score += correct ? 10 : -5;
  if (!correct && room.settings.teamMode) {
    const t = room.teams[player.teamId];
    if (t.score < 0) t.eliminated = true;
  }
  if (!correct && !room.settings.teamMode && player.score < 0) player.eliminated = true;
  room.lastResult = {
    type: correct ? (unverified ? 'neutral' : 'good') : 'bad',
    points: correct ? 10 : -5,
    word,
    message,
    playerId: player.id,
    at: Date.now()
  };
  if (correct && word) room.usedWords.push(word);
}

async function validateWord(word) {
  const key = word.toLowerCase();
  if (WORD_CACHE.has(key)) return WORD_CACHE.get(key);
  try {
    const res = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(key)}`);
    if (res.status === 404) {
      const v = { ok: false, meaning: `"${word}" is not in the dictionary.` };
      WORD_CACHE.set(key, v); return v;
    }
    if (!res.ok) return { ok: true, unverified: true, meaning: 'Definition unavailable — word accepted.' };
    const data = await res.json();
    const meaningBlock = data?.[0]?.meanings?.[0];
    const def = meaningBlock?.definitions?.[0]?.definition || 'Definition unavailable.';
    const pos = meaningBlock?.partOfSpeech || '';
    const v = { ok: true, meaning: pos ? `(${pos}) ${def}` : def };
    WORD_CACHE.set(key, v); return v;
  } catch {
    return { ok: true, unverified: true, meaning: "Dictionary service couldn't be reached — word accepted." };
  }
}

async function submitWord(room, socketId, rawWord) {
  if (room.phase !== 'game') return { error: 'The game is not accepting words right now.' };
  const player = room.players.get(socketId);
  if (!player) return { error: 'You are not in this room.' };
  if (socketId !== room.currentPlayerId) return { error: "It isn't your turn." };
  if (Date.now() > room.turnDeadline) return { error: "Time's up." };
  const raw = String(rawWord || '').trim();
  const word = raw.toLowerCase();
  if (!/^[a-z]+$/.test(word) || word.length < 2) return { error: 'Enter a single alphabetic word.' };
  if (word[0] !== room.letter.toLowerCase()) return { error: `That word does not start with "${room.letter}".` };
  if (room.usedWords.includes(word)) return { error: `"${raw}" was already claimed this game.` };
  const verdict = await validateWord(word);
  if (!verdict.ok) {
    resultForWord(room, player, false, verdict.meaning, raw);
  } else {
    resultForWord(room, player, true, verdict.meaning, raw, !!verdict.unverified);
  }
  if (checkEnd(room)) {
    endGame(room);
  } else {
    const next = nextActivePlayer(room);
    if (!next) endGame(room);
    else {
      room.phase = 'game';
      room.currentPlayerId = next.id;
      room.turnDeadline = Date.now() + room.settings.turnSeconds * 1000;
      broadcast(room);
    }
  }
  return { ok: true };
}

function handleTimeout(room) {
  if (room.phase !== 'game' || !room.currentPlayerId || Date.now() < room.turnDeadline) return;
  const player = room.players.get(room.currentPlayerId);
  if (!player) return;
  resultForWord(room, player, false, "Time's up — no word submitted.");
  if (checkEnd(room)) return endGame(room);
  const next = nextActivePlayer(room);
  if (!next) return endGame(room);
  room.currentPlayerId = next.id;
  room.turnDeadline = Date.now() + room.settings.turnSeconds * 1000;
  broadcast(room);
}

io.on('connection', socket => {
  socket.emit('server:hello', { version: '2.0.0', serverNow: Date.now() });

  socket.on('room:create', ({ name } = {}, ack) => {
    try {
      const clean = cleanName(name);
      const room = newRoom(socket.id, clean);
      socket.join(room.code);
      socketRoom.set(socket.id, room.code);
      broadcast(room);
      ack?.({ ok: true, code: room.code, state: snapshot(room) });
    } catch (e) { ack?.({ ok: false, error: e.message }); }
  });

  socket.on('room:join', ({ code, name } = {}, ack) => {
    try {
      const cleanCodeValue = cleanCode(code);
      const room = rooms.get(cleanCodeValue);
      if (!room) throw new Error('That room does not exist.');
      if (room.phase !== 'lobby') throw new Error('That game has already started.');
      if (room.players.size >= MAX_PLAYERS) throw new Error('This room is full.');
      const clean = cleanName(name);
      room.players.set(socket.id, {
        id: socket.id, name: clean, score: 0, teamId: (room.players.size % room.settings.numTeams),
        eliminated: false, connected: true, disconnectedAt: 0, isHost: false, joinedAt: Date.now()
      });
      socket.join(room.code);
      socketRoom.set(socket.id, room.code);
      broadcast(room);
      ack?.({ ok: true, code: room.code, state: snapshot(room) });
    } catch (e) { ack?.({ ok: false, error: e.message }); }
  });

  socket.on('room:settings', (settings, ack) => {
    const code = socketRoom.get(socket.id); const room = rooms.get(code);
    if (!room || room.hostId !== socket.id || room.phase !== 'lobby') return ack?.({ ok: false, error: 'Only the host can change lobby settings.' });
    room.settings = normalizeSettings(settings);
    buildTeams(room);
    broadcast(room); ack?.({ ok: true });
  });

  socket.on('game:reset', (_payload, ack) => {
    const code = socketRoom.get(socket.id); const room = rooms.get(code);
    if (!room) return ack?.({ ok: false, error: 'Room not found.' });
    if (room.hostId !== socket.id) return ack?.({ ok: false, error: 'Only the host can reset the room.' });
    if (room.phase !== 'end') return ack?.({ ok: false, error: 'The match has not ended.' });
    room.phase = 'lobby';
    room.letter = '?';
    room.currentPlayerId = '';
    room.turnDeadline = 0;
    room.matchStart = 0;
    room.revealEndsAt = 0;
    room.usedWords = [];
    room.lastResult = null;
    room.endReason = '';
    room.turnOrder = [];
    room.turnIndex = -1;
    for (const player of room.players.values()) {
      player.score = 0; player.eliminated = false; player.connected = true;
    }
    buildTeams(room);
    broadcast(room);
    ack?.({ ok: true });
  });

  socket.on('game:start', (_payload, ack) => {
    const code = socketRoom.get(socket.id); const room = rooms.get(code);
    try {
      if (!room) throw new Error('Room not found.');
      if (room.hostId !== socket.id) throw new Error('Only the host can start the game.');
      startGame(room);
      ack?.({ ok: true });
    } catch (e) { ack?.({ ok: false, error: e.message }); }
  });

  socket.on('game:submit', async ({ word } = {}, ack) => {
    const room = rooms.get(socketRoom.get(socket.id));
    try {
      if (!room) throw new Error('Room not found.');
      const result = await submitWord(room, socket.id, word);
      if (result.error) { ack?.({ ok: false, error: result.error }); return; }
      ack?.({ ok: true });
    } catch (e) { ack?.({ ok: false, error: e.message }); }
  });

  socket.on('room:leave', (_payload, ack) => {
    leaveRoom(socket, true);
    ack?.({ ok: true });
  });

  socket.on('disconnect', () => leaveRoom(socket, false));
});

function leaveRoom(socket, explicit) {
  const code = socketRoom.get(socket.id);
  socketRoom.delete(socket.id);
  if (!code) return;
  const room = rooms.get(code);
  if (!room) return;
  const player = room.players.get(socket.id);
  if (!player) return;
  if (!explicit && room.phase !== 'lobby' && room.phase !== 'end') {
    player.connected = false;
    player.disconnectedAt = Date.now();
    broadcast(room);
    return;
  }
  room.players.delete(socket.id);
  if (room.hostId === socket.id) {
    const next = Array.from(room.players.values()).sort((a,b) => a.joinedAt - b.joinedAt)[0];
    if (next) { room.hostId = next.id; next.isHost = true; }
    else { rooms.delete(code); return; }
  }
  if (room.phase === 'lobby') buildTeams(room);
  broadcast(room);
}

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.phase === 'game') {
      if (room.settings.mode === 'time' && room.matchStart && now - room.matchStart >= room.settings.matchMinutes * 60 * 1000) endGame(room);
      else if (now >= room.turnDeadline) handleTimeout(room);
    }
    for (const [id, p] of room.players) {
      if (!p.connected && p.disconnectedAt && now - p.disconnectedAt > DISCONNECT_GRACE_MS) {
        room.players.delete(id);
        if (room.hostId === id) {
          const next = Array.from(room.players.values()).sort((a,b) => a.joinedAt - b.joinedAt)[0];
          if (next) { room.hostId = next.id; next.isHost = true; }
        }
      }
    }
    if (room.phase === 'lobby' && room.players.size === 0) rooms.delete(code);
    if (now - room.lastActivity > ROOM_TTL_MS && io.sockets.adapter.rooms.get(code)?.size !== undefined) rooms.delete(code);
  }
}, 500);

server.listen(PORT, '0.0.0.0', () => console.log(`Inkwell server listening on ${PORT}`));
