import { Peer } from 'peerjs';
import { Room } from 'peer-room';
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

// Online duels ride on peer-room: a WebRTC data channel when a path exists and
// an encrypted relay over public MQTT brokers when it does not, with seats
// that survive reloads and a stored move for a player who is offline.
export const APP = 'bullscows';
export function connectionSettings() {
  const settings = window.BC_CONNECTION || {};
  const endpoints = [...(settings.turnCredentialEndpoints || []), ...(settings.turnCredentialEndpoint ? [settings.turnCredentialEndpoint] : [])];
  return { ...settings, turnCredentialEndpoints: endpoints };
}
export class OnlineDuel {
  constructor(session, callbacks, options = {}) {
    this.session = session; this.callbacks = callbacks; this.room = null; this.pending = null; this.closed = false; this.wasOnline = false;
    callbacks.status('connecting', 'Checking connection routes…');
    this.opening = Room.open(session.seat, { seats: 2, members: session.members, settings: connectionSettings(), transports: options.transports }, {
      status: s => callbacks.status(s.kind, s.text, s.path),
      members: list => {
        const them = list.find(member => member.token !== session.seat.token);
        const host = list.find(member => member.role === 'host');
        const config = { members: list.map(member => ({ token: member.token, name: member.name, role: member.role })) };
        if (them) Object.assign(config, { remoteName: them.name, remoteToken: them.token });
        if (host?.meta?.tieRule && session.role === 'guest') config.tieRule = host.meta.tieRule === 'time' ? 'time' : 'rematch';
        callbacks.configured(config);
        const online = !!them?.online;
        if (online && !this.wasOnline) callbacks.ready({ name: them.name, token: them.token });
        this.wasOnline = online;
      },
      data: env => callbacks.data(env.data),
      error: text => callbacks.error(text),
    }).then(room => { if (this.closed) { room.close(false); return; } this.room = room; if (this.pending) room.send(this.pending); })
      .catch(err => callbacks.error(err?.message || 'Couldn’t open the room.'));
  }
  send(rounds) { if (this.room) this.room.send(rounds); else this.pending = rounds; }
  close() { this.closed = true; this.room?.close(); }
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
