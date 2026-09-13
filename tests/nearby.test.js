import test from 'node:test';
import assert from 'node:assert/strict';
import { decodePairing, encodePairing } from '../src/nearby.js';

test('nearby pairing bundles survive compression and QR-safe encoding', () => {
  const offer = { v: 2, type: 'offer', code: 'ABCD2345', tieRule: 'time', name: 'Host', token: 'a'.repeat(32), sdp: { type: 'offer', sdp: 'v=0\r\na='.repeat(30) } };
  const encoded = encodePairing(offer);
  assert.match(encoded, /^BC-NEARBY-2:[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodePairing(encoded), offer);
  assert.throws(() => decodePairing('not a pairing code'), /not a Bulls/);
});
