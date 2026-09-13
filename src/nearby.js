import { compressSync, decompressSync, strFromU8, strToU8 } from 'fflate';

const prefix = 'BC-NEARBY-2:';
const base64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromBase64url = text => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - text.length % 4) % 4)), char => char.charCodeAt(0));

export function encodePairing(value) {
  return prefix + base64url(compressSync(strToU8(JSON.stringify(value)), { level: 9 }));
}

export function decodePairing(text) {
  if (typeof text !== 'string' || !text.trim().startsWith(prefix)) throw new Error('That is not a Bulls & Cows nearby pairing code.');
  try {
    const value = JSON.parse(strFromU8(decompressSync(fromBase64url(text.trim().slice(prefix.length)))));
    if (value?.v !== 2 || !['offer', 'answer'].includes(value.type) || !value.sdp) throw new Error();
    return value;
  } catch {
    throw new Error('The nearby pairing code is damaged or incomplete. Scan or copy it again.');
  }
}

function waitForIce(pc) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise(resolve => {
    const timeout = setTimeout(done, 8000);
    function done() { clearTimeout(timeout); pc.removeEventListener('icegatheringstatechange', check); resolve(); }
    function check() { if (pc.iceGatheringState === 'complete') done(); }
    pc.addEventListener('icegatheringstatechange', check);
  });
}

export class NearbyConnection {
  constructor(session, callbacks) {
    this.session = session;
    this.callbacks = callbacks;
    this.closed = false;
    this.connected = false;
    this.lastSeen = Date.now();
    this.pc = new RTCPeerConnection({ iceServers: [] });
    this.pc.onconnectionstatechange = () => {
      if (this.closed) return;
      if (['failed', 'disconnected', 'closed'].includes(this.pc.connectionState)) {
        this.connected = false;
        this.callbacks.status('offline', 'Nearby connection ended. Start nearby pairing again to reconnect.');
      }
    };
    this.pc.ondatachannel = event => this.attach(event.channel);
    this.interval = setInterval(() => this.tick(), 5000);
    if (session.role === 'host') this.makeOffer();
    else this.callbacks.status('pairing', 'Scan the host’s pairing QR code');
  }

  async makeOffer() {
    try {
      this.callbacks.status('pairing', 'Creating a nearby pairing code…');
      this.attach(this.pc.createDataChannel('bulls-and-cows', { ordered: true }));
      await this.pc.setLocalDescription(await this.pc.createOffer());
      await waitForIce(this.pc);
      this.callbacks.pairing(encodePairing({ v: 2, type: 'offer', code: this.session.code, tieRule: this.session.tieRule, name: this.session.name, token: this.session.token, sdp: this.pc.localDescription }));
      this.callbacks.status('pairing', 'Let your friend scan this QR code');
    } catch (error) { this.callbacks.error(error.message || 'Couldn’t create nearby pairing.'); }
  }

  async acceptPairing(text) {
    const bundle = decodePairing(text);
    if (this.session.role === 'guest') {
      if (bundle.type !== 'offer') throw new Error('Scan the host’s offer first.');
      this.session.code = bundle.code;
      this.session.tieRule = bundle.tieRule === 'time' ? 'time' : 'rematch';
      this.callbacks.configured({ code: this.session.code, tieRule: this.session.tieRule, remoteName: bundle.name, remoteToken: bundle.token });
      await this.pc.setRemoteDescription(bundle.sdp);
      await this.pc.setLocalDescription(await this.pc.createAnswer());
      await waitForIce(this.pc);
      this.callbacks.pairing(encodePairing({ v: 2, type: 'answer', code: this.session.code, name: this.session.name, token: this.session.token, sdp: this.pc.localDescription }));
      this.callbacks.status('pairing', 'Now let the host scan your answer QR code');
    } else {
      if (bundle.type !== 'answer' || bundle.code !== this.session.code) throw new Error('Scan the answer created for this nearby room.');
      this.callbacks.configured({ code: this.session.code, tieRule: this.session.tieRule, remoteName: bundle.name, remoteToken: bundle.token });
      await this.pc.setRemoteDescription(bundle.sdp);
      this.callbacks.status('connecting', 'Opening the direct nearby connection…');
    }
  }

  attach(channel) {
    this.channel = channel;
    channel.onopen = () => channel.send(JSON.stringify({ type: 'hello', v: 2, code: this.session.code, role: this.session.role, name: this.session.name, token: this.session.token }));
    channel.onmessage = event => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (!message || typeof message !== 'object') return;
      this.lastSeen = Date.now();
      if (message.type === 'hello') {
        if (message.v !== 2 || message.code !== this.session.code || message.role === this.session.role) { this.close(); return; }
        this.session.remoteName = String(message.name || 'Player').slice(0, 20);
        this.session.remoteToken = message.token;
        this.connected = true;
        this.callbacks.status('connected', 'Nearby · both players connected');
        this.callbacks.ready(message);
      } else if (message.type === 'sync' && Array.isArray(message.rounds)) this.callbacks.data(message.rounds);
      else if (message.type === 'ping') channel.send(JSON.stringify({ type: 'pong' }));
      else if (message.type === 'leave') { this.connected = false; this.callbacks.status('left', 'Your friend left the nearby room.'); }
    };
    channel.onclose = () => {
      if (!this.closed) { this.connected = false; this.callbacks.status('offline', 'Nearby connection ended. Start pairing again to reconnect.'); }
    };
  }

  send(rounds) { if (this.connected && this.channel?.readyState === 'open') this.channel.send(JSON.stringify({ type: 'sync', rounds })); }
  tick() { if (this.connected && this.channel?.readyState === 'open') this.channel.send(JSON.stringify({ type: 'ping' })); }
  close() {
    try { if (this.connected) this.channel?.send(JSON.stringify({ type: 'leave' })); } catch {}
    this.closed = true;
    clearInterval(this.interval);
    this.channel?.close();
    this.pc?.close();
  }
}
