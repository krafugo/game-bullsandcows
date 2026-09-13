import { Peer } from 'peerjs';
import { randomHex } from './game.js';
import { advanceTournament, createSchedule, recordResult, roundComplete } from './tournament.js';

const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const makeCode = () => [...crypto.getRandomValues(new Uint8Array(8))].map(n => alphabet[n % alphabet.length]).join('');
export const normalizeCode = value => value.toUpperCase().replace(/[\s-]/g, '');
export const validCode = value => /^[A-HJ-NP-Z2-9]{8}$/.test(value);
export const createSession = (role, name, code = makeCode(), options = {}) => ({
  version: 2, role, name: name.trim().slice(0, 20) || 'Player', code, token: randomHex(), remoteToken: null, remoteName: null,
  format: options.format === 'tournament' ? 'tournament' : 'duel', connectionKind: options.connectionKind === 'nearby' ? 'nearby' : 'online',
  tieRule: options.tieRule === 'time' ? 'time' : 'rematch',
});

export async function connectionOptions() {
  const settings = window.BC_CONNECTION || {};
  let iceServers = settings.iceServers || [{ urls: 'stun:stun.l.google.com:19302' }];
  if (settings.turnCredentialEndpoint) {
    const response = await fetch(settings.turnCredentialEndpoint, { signal: AbortSignal.timeout(10000), credentials: 'omit' });
    if (!response.ok) throw new Error('The connection relay is unavailable. Please try again.');
    const data = await response.json();
    if (!Array.isArray(data.iceServers)) throw new Error('The connection relay returned invalid settings.');
    iceServers = [...iceServers, ...data.iceServers];
  }
  return { ...settings.peerServer, debug: 0, config: { iceServers, ...(settings.iceTransportPolicy ? { iceTransportPolicy: settings.iceTransportPolicy } : {}) } };
}

// Public PeerServer is used only for discovery/signaling. Game messages travel
// through a reliable WebRTC data channel, never a same-browser broadcast channel.
export class RoomConnection {
  constructor(session, callbacks, options) {
    this.session = session; this.callbacks = callbacks; this.options = options;
    this.closed = false; this.lastSeen = 0; this.connected = false;
    this.start();
    this.interval = setInterval(() => this.tick(), 5000);
    this.wake = () => this.tick();
    window.addEventListener('online', this.wake);
    document.addEventListener('visibilitychange', this.wake);
  }
  status(kind, message) { this.callbacks.status(kind, message); }
  start() {
    if (this.closed) return;
    this.status('connecting', this.session.role === 'host' ? 'Opening your room…' : 'Finding your friend…');
    const id = this.session.role === 'host' ? `bc2-${this.session.code}` : `bc2-player-${this.session.token}`;
    this.peer = new Peer(id, this.options);
    const peer = this.peer;
    peer.on('open', () => {
      if (this.closed || this.peer !== peer) return;
      this.status('waiting', this.session.role === 'host' ? 'Room open · invite your friend' : 'Connecting to your friend…');
      if (this.session.role === 'guest') this.dial();
    });
    peer.on('connection', conn => {
      if (this.session.role !== 'host') { conn.on('open', () => conn.close()); return; }
      this.attach(conn);
    });
    peer.on('error', error => {
      if (this.closed || this.peer !== peer || this.connected) return;
      const text = error.type === 'peer-unavailable' ? 'Room not found yet. Check the code and ask your friend to keep their room open.'
        : error.type === 'unavailable-id' ? 'This room is already open in another tab, or still reconnecting. Close the extra tab and retry.'
        : 'Couldn’t connect. Check your internet or try another network. Some networks need a relay.';
      this.status('offline', text);
    });
    peer.on('disconnected', () => { if (!this.connected && !this.closed) this.status('offline', 'Connection interrupted. Your game is saved in this tab. Retrying…'); });
  }
  dial() {
    if (this.closed || this.conn || this.peer.disconnected || this.peer.destroyed) return;
    this.attach(this.peer.connect(`bc2-${this.session.code}`, { reliable: true, serialization: 'json', metadata: { version: 2, code: this.session.code, token: this.session.token } }));
  }
  attach(conn) {
    let accepted = false;
    const timeout = setTimeout(() => { if (!accepted) { conn.close(); if (this.conn === conn) this.conn = null; if (!this.connected) this.status('offline', 'Your friend hasn’t connected yet. Keep both screens open, check the code, or try another network.'); } }, 20000);
    const reject = reason => { try { conn.send({ type: 'reject', reason }); } catch {} setTimeout(() => conn.close(), 150); };
    conn.on('open', () => {
      if (this.closed) { conn.close(); return; }
      if (this.connected && this.conn !== conn && conn.metadata?.token !== this.session.remoteToken) { reject('This room already has two players.'); return; }
      if (this.session.role === 'host' && (conn.metadata?.code !== this.session.code || conn.metadata?.version !== 2 || (this.session.remoteToken && conn.metadata?.token !== this.session.remoteToken))) {
        reject('This room is reserved for the original two players.'); return;
      }
      conn.send({ type: 'hello', version: 2, code: this.session.code, role: this.session.role, token: this.session.token, name: this.session.name, tieRule: this.session.tieRule });
    });
    conn.on('data', message => {
      if (this.closed || !message || typeof message !== 'object') return;
      if (message.type === 'reject' && !accepted && this.session.role === 'guest' && this.conn === conn) { clearTimeout(timeout); this.rejected = true; this.status('rejected', String(message.reason).slice(0, 150)); conn.close(); return; }
      if (message.type === 'hello') {
        if (accepted) return;
        if (message.version !== 2 || message.code !== this.session.code || message.role !== (this.session.role === 'host' ? 'guest' : 'host') || !/^[a-f0-9]{32}$/.test(message.token) || typeof message.name !== 'string' || (this.session.role === 'host' && message.token !== conn.metadata?.token) || (this.session.remoteToken && this.session.remoteToken !== message.token) || (this.connected && this.conn !== conn && message.token !== this.session.remoteToken)) { reject('This room is reserved for the original two players.'); return; }
        accepted = true; clearTimeout(timeout);
        const old = this.conn;
        this.conn = conn; this.connected = true; this.lastSeen = Date.now();
        if (old && old !== conn) old.close();
        this.session.remoteToken = message.token; this.session.remoteName = message.name.slice(0, 20);
        if (this.session.role === 'guest') this.session.tieRule = message.tieRule === 'time' ? 'time' : 'rematch';
        this.callbacks.configured?.({ tieRule: this.session.tieRule, remoteName: this.session.remoteName, remoteToken: this.session.remoteToken });
        this.status('connected', 'Both players connected');
        this.callbacks.ready(message);
        return;
      }
      if (!accepted || this.conn !== conn) return;
      this.lastSeen = Date.now();
      if (message.type === 'ping') conn.send({ type: 'pong' });
      if (message.type === 'sync' && Array.isArray(message.rounds)) {
        if (JSON.stringify(message).length > 1500000) { this.callbacks.error('This room exceeded its data limit. Please start a new room.'); return; }
        this.callbacks.data(message.rounds);
      }
      if (message.type === 'leave') { this.status('left', 'Your friend left the room. Create a new room to play again.'); this.rejected = true; conn.close(); }
    });
    conn.on('close', () => {
      clearTimeout(timeout);
      if (this.conn !== conn || this.closed) return;
      this.conn = null; this.connected = false;
      if (!this.rejected) this.status('offline', 'Your friend is reconnecting. Your guesses are saved. Keep this tab open.');
    });
    conn.on('error', () => { clearTimeout(timeout); conn.close(); });
    // Reserve the outbound attempt so repeated timer ticks cannot race it.
    if (this.session.role === 'guest' && !this.conn) this.conn = conn;
  }
  send(rounds) { if (this.connected && this.conn?.open) this.conn.send({ type: 'sync', rounds }); }
  tick() {
    if (this.closed || this.rejected) return;
    if (this.connected) {
      if (Date.now() - this.lastSeen > 25000) { this.conn?.close(); return; }
      this.conn?.send({ type: 'ping' }); return;
    }
    this.retry();
  }
  retry() {
    if (this.closed || this.rejected || this.connected) return;
    if (this.peer.destroyed) this.start();
    else if (this.peer.disconnected) { try { this.peer.reconnect(); } catch {} }
    else if (this.session.role === 'guest') this.dial();
  }
  close() {
    try { if (this.connected) this.conn?.send({ type: 'leave' }); } catch {}
    this.closed = true; clearInterval(this.interval); this.peer?.destroy();
    window.removeEventListener('online', this.wake);
    document.removeEventListener('visibilitychange', this.wake);
  }
}

export class TournamentConnection {
  constructor(session, callbacks, options) {
    this.session = session; this.callbacks = callbacks; this.options = options;
    this.closed = false; this.connections = new Map(); this.connected = session.role === 'host';
    this.tournament = session.tournament || { members: [{ token: session.token, name: session.name }], started: false, complete: false, rounds: [], roundIndex: 0 };
    this.session.tournament = this.tournament;
    this.start();
    this.interval = setInterval(() => this.tick(), 5000);
  }
  status(kind, text) { this.callbacks.status(kind, text); }
  start() {
    const id = this.session.role === 'host' ? `bct2-${this.session.code}` : `bct2-player-${this.session.token}`;
    this.peer = new Peer(id, this.options);
    const peer = this.peer;
    peer.on('open', () => {
      if (this.closed || this.peer !== peer) return;
      if (this.session.role === 'guest') this.dial();
      else { this.status('waiting', 'Tournament lobby open'); this.emitTournament(); }
    });
    peer.on('connection', conn => {
      if (this.session.role !== 'host') { conn.on('open', () => conn.close()); return; }
      this.attachHost(conn);
    });
    peer.on('error', error => {
      if (this.closed) return;
      const text = error.type === 'peer-unavailable' ? 'Tournament not found. Check the room code.' : 'Couldn’t connect to the tournament. Try again.';
      this.status('offline', text);
    });
  }
  dial() {
    if (this.closed || this.conn?.open) return;
    this.status('connecting', 'Joining the tournament…');
    this.attachGuest(this.peer.connect(`bct2-${this.session.code}`, { reliable: true, serialization: 'json', metadata: { version: 2, code: this.session.code, token: this.session.token, name: this.session.name } }));
  }
  attachHost(conn) {
    let token = conn.metadata?.token;
    conn.on('open', () => {
      const known = this.tournament.members.some(member => member.token === token);
      if (conn.metadata?.version !== 2 || conn.metadata?.code !== this.session.code || !/^[a-f0-9]{32}$/.test(token) || (this.tournament.started && !known) || (!known && this.tournament.members.length >= 4)) {
        conn.send({ type: 'reject', reason: this.tournament.started ? 'This tournament already started.' : 'This tournament already has four players.' });
        setTimeout(() => conn.close(), 150); return;
      }
      if (!known) this.tournament.members.push({ token, name: String(conn.metadata?.name || 'Player').slice(0, 20) });
      const old = this.connections.get(token); if (old && old !== conn) old.close();
      this.connections.set(token, conn);
      conn.send({ type: 'welcome', tournament: this.tournament });
      this.broadcastTournament();
      this.status('connected', `${this.tournament.members.length} players in the tournament`);
    });
    conn.on('data', message => this.receiveHost(token, message));
    conn.on('close', () => { if (this.connections.get(token) === conn) this.connections.delete(token); this.broadcastTournament(); });
    conn.on('error', () => conn.close());
  }
  attachGuest(conn) {
    this.conn = conn;
    conn.on('data', message => {
      if (!message || typeof message !== 'object') return;
      if (message.type === 'reject') { this.status('rejected', String(message.reason)); conn.close(); }
      else if (message.type === 'welcome' || message.type === 'tournament') {
        this.connected = true; this.tournament = message.tournament; this.session.tournament = this.tournament;
        this.status('connected', `${this.tournament.members.length} players in the tournament`); this.emitTournament();
      } else if (message.type === 'match') this.callbacks.data(message.rounds, message.matchId, message.from);
      else if (message.type === 'ping') conn.send({ type: 'pong' });
    });
    conn.on('close', () => { if (!this.closed) { this.connected = false; this.status('offline', 'Disconnected from the tournament. Retrying…'); } });
    conn.on('error', () => conn.close());
  }
  receiveHost(token, message) {
    if (!message || typeof message !== 'object' || !this.connections.has(token)) return;
    if (message.type === 'match') this.routeMatch(token, message.matchId, message.rounds);
    else if (message.type === 'result') { if (recordResult(this.tournament, message.matchId, token, message.report)) this.broadcastTournament(); }
    else if (message.type === 'ping') this.connections.get(token)?.send({ type: 'pong' });
  }
  routeMatch(from, matchId, rounds) {
    if (!Array.isArray(rounds)) return;
    const match = this.tournament.rounds?.[this.tournament.roundIndex]?.find(item => item.id === matchId && [item.a, item.b].includes(from));
    if (!match) return;
    const target = match.a === from ? match.b : match.a;
    if (target === this.session.token) this.callbacks.data(rounds, matchId, from);
    else this.connections.get(target)?.send({ type: 'match', from, matchId, rounds });
  }
  send(rounds, matchId) {
    if (this.session.role === 'host') this.routeMatch(this.session.token, matchId, rounds);
    else if (this.conn?.open) this.conn.send({ type: 'match', matchId, rounds });
  }
  reportResult(matchId, report) {
    if (this.session.role === 'host') { if (recordResult(this.tournament, matchId, this.session.token, report)) this.broadcastTournament(); }
    else this.conn?.send({ type: 'result', matchId, report });
  }
  startTournament() {
    if (this.session.role !== 'host' || this.tournament.started) return false;
    this.tournament = createSchedule(this.tournament.members); this.session.tournament = this.tournament; this.broadcastTournament(); return true;
  }
  advanceTournament() {
    if (this.session.role !== 'host' || !advanceTournament(this.tournament)) return false;
    this.broadcastTournament(); return true;
  }
  broadcastTournament() {
    this.session.tournament = this.tournament;
    for (const conn of this.connections.values()) if (conn.open) conn.send({ type: 'tournament', tournament: this.tournament });
    this.emitTournament();
  }
  emitTournament() { this.callbacks.tournament(this.tournament, { roundComplete: roundComplete(this.tournament) }); }
  tick() {
    if (this.closed) return;
    if (this.session.role === 'guest') {
      if (this.conn?.open) this.conn.send({ type: 'ping' });
      else if (!this.peer.disconnected && !this.peer.destroyed) this.dial();
    } else for (const conn of this.connections.values()) if (conn.open) conn.send({ type: 'ping' });
  }
  close() {
    this.closed = true; clearInterval(this.interval);
    try { this.conn?.close(); } catch {}
    for (const conn of this.connections.values()) try { conn.close(); } catch {}
    this.peer?.destroy();
  }
}
