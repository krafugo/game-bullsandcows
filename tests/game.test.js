import test from 'node:test';
import assert from 'node:assert/strict';
import { Game, score, validNumber } from '../src/game.js';

async function pair() {
  const a = new Game('TESTROOM'), b = new Game('TESTROOM');
  const settle = async () => {
    for (let n = 0; n < 12; n++) {
      const before = JSON.stringify([a.snapshot(), b.snapshot()]);
      await a.receive(b.snapshot()); await b.receive(a.snapshot());
      if (before === JSON.stringify([a.snapshot(), b.snapshot()])) return;
    }
    throw new Error('Protocol did not settle');
  };
  return { a, b, settle };
}

test('classic scoring and valid zero-leading codes', () => {
  for (const [secret, guess, expected] of [
    ['1234','1234',{bulls:4,cows:0}], ['1234','4321',{bulls:0,cows:4}],
    ['0123','0456',{bulls:1,cows:0}], ['1234','1356',{bulls:1,cows:1}], ['1234','5678',{bulls:0,cows:0}],
  ]) assert.deepEqual(score(secret, guess), expected);
  ['0012','123','12345','abcd','12.3',1234].forEach(v => assert.equal(validNumber(v), false));
  assert.equal(validNumber('0123'), true);
});

test('all 5040 valid guesses preserve scoring invariants', () => {
  let total = 0;
  for (let i = 0; i < 10000; i++) {
    const guess = String(i).padStart(4,'0');
    if (!validNumber(guess)) continue;
    total++;
    const r = score('0123', guess);
    assert.ok(r.bulls + r.cows <= 4);
    assert.equal(r.bulls + r.cows, [...guess].filter(d => '0123'.includes(d)).length);
    assert.equal(r.bulls === 4, guess === '0123');
  }
  assert.equal(total, 5040);
});

test('secrets and faster guess are withheld until both guesses lock', async () => {
  const {a,b,settle} = await pair();
  await a.lockSecret('0123'); await b.lockSecret('5678'); await settle();
  assert.equal(a.view().ready,true);
  assert.ok(!JSON.stringify(a.snapshot()).includes('0123'));
  await a.lockGuess('5678'); await settle();
  assert.equal(a.view().history.length,0); assert.equal(b.view().otherLocked,true);
  assert.equal(a.own.turns[0].reveal,undefined);
  assert.equal(a.own.secretReveal,undefined);
  await b.lockGuess('9012'); await settle();
  assert.equal(a.view().outcome,'win'); assert.equal(b.view().outcome,'loss');
  assert.equal(a.view().history.length,1); assert.equal(b.view().history.length,1);
  assert.equal(a.view().verified,true); assert.equal(a.view().otherSecret,'5678');
});

test('multiple simultaneous attempts, tie, mutual replay and new secrets', async () => {
  const {a,b,settle} = await pair();
  await Promise.all([a.lockSecret('0123'),b.lockSecret('5678')]); await settle();
  await Promise.all([a.lockGuess('9876'),b.lockGuess('9012')]); await settle();
  assert.equal(a.view().attempt,2); assert.equal(b.view().attempt,2);
  await assert.rejects(a.lockGuess('9876'), /already tried/);
  await Promise.all([a.lockGuess('5678'),b.lockGuess('0123')]); await settle();
  assert.equal(a.view().outcome,'tie'); assert.equal(b.view().outcome,'tie');
  await a.nextRound(); await settle(); assert.equal(a.view().round,1);
  await b.nextRound(); await settle(); assert.equal(a.view().round,2); assert.equal(b.view().round,2);
  assert.equal(a.view().history.length,0);
  await assert.rejects(a.lockSecret('0123'), /new secret/);
  await a.lockSecret('1234'); await b.lockSecret('6789'); await settle();
  await a.lockGuess('6789'); await b.lockGuess('5678'); await settle();
  assert.equal(a.view().outcome,'win'); assert.equal(b.view().outcome,'loss');
});

test('restoration and missed snapshot replay preserve a locked guess', async () => {
  const {a,b,settle} = await pair();
  await a.lockSecret('0123'); await b.lockSecret('5678'); await settle();
  await a.lockGuess('9876');
  const restored = new Game('TESTROOM',a.saved());
  await b.lockGuess('9012');
  for (let i=0;i<5;i++) {await restored.receive(b.snapshot()); await b.receive(restored.snapshot());}
  assert.equal(restored.view().history.length,1);
  assert.deepEqual(restored.view().history[0], {guess:'9876',bulls:1,cows:2,opponent:{bulls:0,cows:3}});
  const older = [{turns:[]}]; await restored.receive(older);
  assert.equal(restored.view().history.length,1);
  await b.receive(restored.snapshot()); assert.equal(b.view().history.length,1);
});

test('cannot lock twice, guess early, change commitments, or reveal early', async () => {
  const {a,b,settle} = await pair();
  await assert.rejects(a.lockGuess('1234'), /Wait/);
  await a.lockSecret('0123'); await b.lockSecret('5678'); await settle();
  await assert.rejects(a.lockSecret('1234'), /already locked/);
  await a.lockGuess('9876'); await assert.rejects(a.lockGuess('8765'), /Wait/);
  const changed = b.snapshot(); changed[0].secretCommit = 'a'.repeat(64);
  await assert.rejects(a.receive(changed), /does not match/);
  const fresh = await pair(); await fresh.a.lockSecret('0123'); await fresh.b.lockSecret('5678'); await fresh.settle();
  const early = fresh.b.snapshot(); early[0].secretReveal = fresh.b.private.secret;
  await assert.rejects(fresh.a.receive(early), /before the round/);
});

test('tampered feedback cannot produce a verified victory', async () => {
  const {a,b,settle} = await pair();
  await a.lockSecret('0123'); await b.lockSecret('5678'); await settle();
  await a.lockGuess('9876'); await b.lockGuess('0123');
  await a.receive(b.snapshot()); await b.receive(a.snapshot());
  const forged = b.snapshot(); forged[0].turns[0].feedback = {bulls:4,cows:0};
  await a.receive(forged);
  assert.equal(a.view().verified,false);
  forged[0].secretReveal = b.private.secret;
  await assert.rejects(a.receive(forged), /feedback does not match/);
  assert.equal(a.view().verified,false);
});

test('speed tie-breaker selects the player with less thinking time', async () => {
  const a = new Game('TIME', null, () => {}, { tieRule: 'time' });
  const b = new Game('TIME', null, () => {}, { tieRule: 'time' });
  const settle = async () => { for (let i = 0; i < 10; i++) { await a.receive(b.snapshot()); await b.receive(a.snapshot()); } };
  await a.lockSecret('0123'); await b.lockSecret('5678'); await settle();
  await a.lockGuess('9876', 1200); await b.lockGuess('9012', 2400); await settle();
  await a.lockGuess('5678', 800); await b.lockGuess('0123', 1800); await settle();
  assert.equal(a.view().outcome, 'win'); assert.equal(b.view().outcome, 'loss');
  assert.equal(a.view().timedDecision, true); assert.equal(a.view().ownTime, 2000); assert.equal(a.view().otherTime, 4200);
});

test('a timed commitment cannot be changed after the move is sent', async () => {
  const { a, b, settle } = await pair();
  await a.lockSecret('0123'); await b.lockSecret('5678'); await settle();
  await a.lockGuess('9876', 1234); await b.receive(a.snapshot()); const forged = a.snapshot(); forged[0].turns[0].timeMs = 1;
  await assert.rejects(b.receive(forged), /does not match/);
});
