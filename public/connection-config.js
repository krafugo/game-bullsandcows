// Optional hosting configuration. This file is public: never put a private API key here.
// See README.md for the full description of each option.
window.BC_CONNECTION = {
  // Free public STUN servers. The browser tries all of them; they only reveal the public address.
  iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }],
  // TURN relays for networks that block direct connections. Each is probed when a room opens; only the ones that answer are used.
  turnServers: [
    // { urls: ['turn:a.relay.example:80', 'turn:a.relay.example:443?transport=tcp'], username: '…', credential: '…' },
  ],
  // Or endpoints you operate that mint short-lived credentials and answer { "iceServers": [...] }:
  turnCredentialEndpoints: [],
  // Store-and-forward relay for online duels: public MQTT brokers over WebSocket, all used at once. An empty list turns it off.
  brokers: ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt', 'wss://test.mosquitto.org:8081'],
  // A custom PeerServer: { host: 'peer.example', port: 443, path: '/', secure: true }
  // peerServer: undefined,
};
