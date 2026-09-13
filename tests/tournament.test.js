import test from 'node:test';
import assert from 'node:assert/strict';
import { activeMatch, advanceTournament, createSchedule, recordResult, roundComplete, standings } from '../src/tournament.js';

const players = [{ token: 'a', name: 'A' }, { token: 'b', name: 'B' }, { token: 'c', name: 'C' }, { token: 'd', name: 'D' }];

test('round robin schedule gives four players two simultaneous matches', () => {
  const t = createSchedule(players);
  assert.equal(t.rounds.length, 3);
  assert.equal(t.rounds[0].length, 2);
  assert.equal(new Set(t.rounds.flatMap(round => round.flatMap(match => [match.a, match.b]))).size, 4);
  assert.equal(activeMatch(t, 'a')?.id, 'r1m1');
});

test('three-player schedule gives one bye each round', () => {
  const t = createSchedule(players.slice(0, 3));
  assert.equal(t.rounds.length, 3);
  assert.deepEqual(t.rounds.map(round => round.length), [1, 1, 1]);
  assert.equal(new Set(t.rounds.flatMap(round => round.flatMap(match => [match.a, match.b]))).size, 3);
});

test('results produce standings and advance only after every match reports', () => {
  const t = createSchedule(players);
  const [m1, m2] = t.rounds[0];
  assert.equal(recordResult(t, m1.id, m1.a, { outcome: 'win', attempts: 2, timeMs: 1000 }), true);
  assert.equal(roundComplete(t), false);
  assert.equal(recordResult(t, m1.id, m1.b, { outcome: 'loss', attempts: 2, timeMs: 2000 }), true);
  assert.equal(recordResult(t, m2.id, m2.a, { outcome: 'tie', attempts: 3, timeMs: 2000 }), true);
  assert.equal(recordResult(t, m2.id, m2.b, { outcome: 'tie', attempts: 3, timeMs: 2000 }), true);
  assert.equal(roundComplete(t), true);
  const table = standings(t);
  assert.equal(table[0].token, m1.a); assert.equal(table[0].points, 3);
  assert.equal(advanceTournament(t), true); assert.equal(t.roundIndex, 1);
});
