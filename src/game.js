export const validNumber = value => typeof value === 'string' && /^\d{4}$/.test(value) && new Set(value).size === 4;
export function score(secret, guess) {
  if (!validNumber(secret) || !validNumber(guess)) throw new Error('Use four different digits.');
  const bulls = [...guess].filter((digit, i) => secret[i] === digit).length;
  return { bulls, cows: [...guess].filter(digit => secret.includes(digit)).length - bulls };
}
export function randomHex(bytes = 16) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
}
export async function commitment(room, round, kind, value, salt) {
  const input = JSON.stringify(['bc-v1', room, round, kind, value, salt]);
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input)))].map(n => n.toString(16).padStart(2, '0')).join('');
}
const copy = value => JSON.parse(JSON.stringify(value));
const hash = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const proof = v => v && validNumber(v.value) && /^[a-f0-9]{32}$/.test(v.salt) && Object.keys(v).length === 2;
const result = v => v && Number.isInteger(v.bulls) && Number.isInteger(v.cows) && v.bulls >= 0 && v.cows >= 0 && v.bulls + v.cows <= 4 && Object.keys(v).length === 2;
function assert(value, message = 'The game data does not match. Please start a new room.') { if (!value) throw new Error(message); }
function unchanged(old, next) {
  if (old === null || typeof old !== 'object') return old === next;
  return next && typeof next === 'object' && Object.keys(old).every(k => unchanged(old[k], next[k]));
}
function validateRound(r) {
  assert(r && typeof r === 'object' && !Array.isArray(r));
  assert(Object.keys(r).every(k => ['secretCommit', 'turns', 'secretReveal', 'next'].includes(k)));
  assert(!r.secretCommit || hash(r.secretCommit));
  assert(Array.isArray(r.turns) && r.turns.length <= 5040);
  assert(!r.secretReveal || proof(r.secretReveal));
  assert(r.next === undefined || r.next === true);
  for (const t of r.turns) {
    assert(t && Object.keys(t).every(k => ['commit', 'reveal', 'feedback', 'timeMs'].includes(k)));
    assert(!t.commit || hash(t.commit));
    assert(t.timeMs === undefined || (Number.isInteger(t.timeMs) && t.timeMs >= 0 && t.timeMs <= 86400000));
    assert(!t.reveal || proof(t.reveal));
    assert(!t.feedback || result(t.feedback));
  }
}

// Each player publishes only append-only public state. Private values stay on that
// device until the relevant simultaneous reveal; secrets reveal only at round end.
export class Game {
  constructor(room, saved, onChange = () => {}, options = {}) {
    this.room = room;
    this.data = saved || { own: [{ turns: [] }], other: [{ turns: [] }], private: [{}] };
    this.onChange = onChange;
    this.tieRule = options.tieRule === 'time' ? 'time' : 'rematch';
    this.queue = Promise.resolve();
    this.error = '';
  }
  get round() { return this.data.own.length - 1; }
  get own() { return this.data.own[this.round]; }
  get other() { return this.data.other[this.round] || { turns: [] }; }
  get private() { return this.data.private[this.round]; }
  snapshot() { return copy(this.data.own); }
  saved() { return copy(this.data); }
  task(fn) {
    const pending = this.queue.then(async () => {
      if (this.error) throw new Error(this.error);
      await fn(); await this.pump(); this.onChange();
    });
    this.queue = pending.catch(() => {});
    return pending;
  }
  async receive(rounds) {
    return this.task(async () => {
      try {
        assert(Array.isArray(rounds) && rounds.length > 0 && rounds.length <= 100);
        rounds.forEach(validateRound);
        // A delayed snapshot is harmless, but committed values can never change.
        const old = this.data.other;
        if (rounds.length < old.length || (rounds.length === old.length && unchanged(rounds, old))) return;
        assert(unchanged(old, rounds));
        assert(rounds.length <= this.data.own.length + (this.own.next ? 1 : 0));
        this.data.other = copy(rounds);
        await this.audit();
      } catch (error) { this.error = error.message; this.onChange(); throw error; }
    });
  }
  lockSecret(value) {
    return this.task(async () => {
      assert(validNumber(value), 'Enter four different digits, from 0 to 9.');
      assert(!this.own.secretCommit, 'Your secret is already locked.');
      assert(this.round === 0 || value !== this.data.private[this.round - 1].secret.value, 'Pick a new secret for this round.');
      this.private.secret = { value, salt: randomHex() };
      this.own.secretCommit = await commitment(this.room, this.round, 'secret', value, this.private.secret.salt);
    });
  }
  lockGuess(value, timeMs = 0) {
    return this.task(async () => {
      const v = this.view();
      assert(validNumber(value), 'Enter four different digits, from 0 to 9.');
      assert(Number.isInteger(timeMs) && timeMs >= 0 && timeMs <= 86400000, 'The turn timer is invalid.');
      assert(v.ready && !v.ended && !v.locked, 'Wait for the next guess.');
      assert(!this.own.turns.some(t => t.reveal?.value === value), 'You already tried that number. Try a different one.');
      const n = v.attempt - 1;
      const p = { value, salt: randomHex() };
      (this.private.guesses ||= [])[n] = p;
      this.own.turns[n] ||= {};
      this.own.turns[n].timeMs = timeMs;
      this.own.turns[n].commit = await commitment(this.room, this.round, `guess:${n}`, `${value}:${timeMs}`, p.salt);
    });
  }
  nextRound() {
    return this.task(async () => {
      assert(this.view().verified, 'Wait for the round result.');
      assert(this.round < 99, 'This room has reached 100 rounds. Create a new room to keep playing.');
      this.own.next = true;
    });
  }
  view() {
    const a = this.own, b = this.other;
    const history = [];
    let ended = false, outcome = null;
    for (let n = 0; n < a.turns.length; n++) {
      const x = a.turns[n], y = b.turns[n];
      if (!x.feedback || !y?.feedback) break;
      history.push({ guess: x.reveal.value, ...y.feedback, opponent: x.feedback });
      if (x.feedback.bulls === 4 || y.feedback.bulls === 4) {
        ended = true;
        if (x.feedback.bulls !== y.feedback.bulls) outcome = y.feedback.bulls === 4 ? 'win' : 'loss';
        else if (this.tieRule === 'time') {
          const ownTime = a.turns.reduce((sum, turn) => sum + (turn.timeMs || 0), 0);
          const otherTime = b.turns.reduce((sum, turn) => sum + (turn.timeMs || 0), 0);
          outcome = ownTime === otherTime ? 'tie' : ownTime < otherTime ? 'win' : 'loss';
        } else outcome = 'tie';
        break;
      }
    }
    const n = history.length;
    const ownTime = a.turns.reduce((sum, turn) => sum + (turn.timeMs || 0), 0);
    const otherTime = b.turns.reduce((sum, turn) => sum + (turn.timeMs || 0), 0);
    const bothSolved = a.turns.some(turn => turn.feedback?.bulls === 4) && b.turns.some(turn => turn.feedback?.bulls === 4);
    return { round: this.round + 1, ready: !!(a.secretCommit && b.secretCommit), secretLocked: !!a.secretCommit,
      otherSecretLocked: !!b.secretCommit, history, attempt: n + 1, locked: !!a.turns[n]?.commit,
      otherLocked: !!b.turns[n]?.commit, ended, outcome, verified: ended && !!this.verifiedRound,
      ownNext: !!a.next, otherNext: !!b.next, otherSecret: ended && this.verifiedRound ? b.secretReveal?.value : null,
      ownTime, otherTime, tieRule: this.tieRule, timedDecision: bothSolved && this.tieRule === 'time' && ownTime !== otherTime };
  }
  async audit() {
    const a = this.own, b = this.other;
    const ready = a.secretCommit && b.secretCommit;
    let ended = false;
    for (let n = 0; n < Math.max(a.turns.length, b.turns.length); n++) {
      const x = a.turns[n] || {}, y = b.turns[n] || {};
      assert(ready && !ended);
      if (n) assert(a.turns[n - 1]?.feedback && b.turns[n - 1]?.feedback);
      if (y.reveal) {
        assert(x.commit && y.commit);
        assert(Number.isInteger(y.timeMs));
        assert(await commitment(this.room, this.round, `guess:${n}`, `${y.reveal.value}:${y.timeMs}`, y.reveal.salt) === y.commit, 'Your friend’s locked guess or time changed. This round cannot count.');
      }
      if (y.feedback) assert(x.reveal);
      if (x.feedback && y.feedback) ended = x.feedback.bulls === 4 || y.feedback.bulls === 4;
    }
    if (b.secretReveal) {
      assert(ended, 'A secret was revealed before the round was finished.');
      assert(await commitment(this.room, this.round, 'secret', b.secretReveal.value, b.secretReveal.salt) === b.secretCommit, 'Your friend’s secret changed. This round cannot count.');
      if (this.round) assert(b.secretReveal.value !== this.data.other[this.round - 1].secretReveal.value, 'Your friend reused their previous secret. Start a new room.');
      for (let n = 0; n < a.turns.length; n++) {
        const expected = score(b.secretReveal.value, a.turns[n].reveal.value);
        assert(expected.bulls === b.turns[n].feedback.bulls && expected.cows === b.turns[n].feedback.cows, 'The feedback does not match the secret. This round cannot count.');
      }
      this.verifiedRound = true;
    }
    if (b.next) assert(ended && b.secretReveal);
  }
  async pump() {
    await this.audit();
    const a = this.own, b = this.other;
    if (a.secretCommit && b.secretCommit) {
      for (let n = 0; n < Math.max(a.turns.length, b.turns.length); n++) {
        const x = a.turns[n] ||= {}, y = b.turns[n] || {};
        if (x.commit && y.commit && !x.reveal) x.reveal = copy(this.private.guesses[n]);
        if (y.reveal && !x.feedback) x.feedback = score(this.private.secret.value, y.reveal.value);
      }
    }
    if (this.view().ended && !a.secretReveal) a.secretReveal = copy(this.private.secret);
    await this.audit();
    if (a.next && b.next && this.verifiedRound) {
      this.data.own.push({ turns: [] });
      this.data.private.push({});
      this.verifiedRound = false;
      if (!this.data.other[this.round]) this.data.other.push({ turns: [] });
      await this.audit();
    }
  }
}
