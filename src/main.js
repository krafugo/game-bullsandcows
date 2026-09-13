import './style.css';
import { Game } from './game.js';
import { createSession, normalizeCode, validCode, RoomConnection, connectionOptions } from './network.js';

const root = document.querySelector('#app');
const storageKey = 'bulls-cows-session-v1';
let session = null, game = null, network = null, state = 'home', status = '', message = '', fatal = '', busy = false;
let joining = !!new URLSearchParams(location.hash.slice(1)).get('room');
let draftName = '', draftCode = new URLSearchParams(location.hash.slice(1)).get('room') || '', draftDigits = '';
let showSecret = false, rulesOpen = false, leaveOpen = false, lastSent = '', storageWarning = '';
let resume = null;
try { const raw = JSON.parse(sessionStorage.getItem(storageKey)); if (raw?.version === 1 && validCode(raw.code) && ['host', 'guest'].includes(raw.role) && raw.token && raw.game) resume = raw; } catch {}

const e = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const arrow = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 12h14m-6-6 6 6-6 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const lock = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="3" stroke="currentColor" stroke-width="1.8"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 4v3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
const mark = '<span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i><i></i></span>';
const tiles = (value, cls = '') => `<div class="tiles ${cls}" aria-label="${e(value === '••••' ? 'Four hidden digits' : value)}">${[...value].map((d, i) => `<span class="digit digit-${i}" aria-hidden="true">${e(d)}</span>`).join('')}</div>`;
const rules = () => `<div class="rules-content"><div class="rule-line"><span class="count bull">B</span><div><strong>Bull</strong><p>Right digit. Right place.</p></div></div><div class="rule-line"><span class="count cow">C</span><div><strong>Cow</strong><p>Right digit. Different place.</p></div></div><div class="example"><span class="eyebrow">FOR EXAMPLE</span><div><span>Secret <b>1234</b></span><span>Guess <b>1356</b></span></div><p><strong>1 bull · 1 cow</strong><br>1 is in place. 3 belongs elsewhere.</p></div><ol><li>Choose four different digits, 0–9. A zero can come first: <b>0285</b> is valid.</li><li>Both players lock a guess. Feedback appears after both are ready. There’s no timer.</li><li>Crack the code in fewer guesses to win. You always get equal attempts.</li><li>Solve on the same attempt? Pick new secrets and play a tiebreaker until someone wins.</li></ol></div>`;

function persist() {
  if (!session || !game) return;
  session.game = game.saved();
  try { sessionStorage.setItem(storageKey, JSON.stringify(session)); }
  catch { storageWarning = 'This browser can’t save your game. Keep this tab open; refreshing will lose your place.'; }
}
function sync(force = false) {
  if (!game) return;
  const snapshot = game.snapshot(), text = JSON.stringify(snapshot);
  if (force || text !== lastSent) { network?.send(snapshot); lastSent = text; }
}
async function start(role, existing = null) {
  if (busy) return;
  if (!crypto.subtle || !window.RTCPeerConnection) { message = 'Use a current browser on HTTPS (or localhost) to play online.'; render(); return; }
  const code = normalizeCode(draftCode);
  if (!existing && role === 'guest' && !validCode(code)) { message = 'Enter the 8-character room code from your friend.'; render(); document.querySelector('#room-code')?.focus(); return; }
  busy = true; message = ''; render();
  try {
    const options = await connectionOptions();
    session = existing || createSession(role, draftName, role === 'guest' ? code : undefined);
    state = 'connecting'; status = 'Opening a connection…';
    game = new Game(session.code, session.game, () => { persist(); sync(); render(); });
    await game.task(async () => {});
    network = new RoomConnection(session, {
      status(kind, text) { state = kind; status = text; render(); },
      ready() { persist(); sync(true); render(); },
      data(rounds) { game.receive(rounds).catch(err => { fatal = err.message; render(); }); },
      error(text) { fatal = text; render(); },
    }, options);
    persist();
  } catch (err) { message = err.message || 'Couldn’t open the room. Please try again.'; if (!network) { session = null; game = null; state = 'home'; } }
  busy = false; render();
}
function inviteURL() { const url = new URL(location.href); url.hash = `room=${session.code}`; return url.href; }
async function copyInvite(share = false) {
  try {
    if (share && navigator.share) await navigator.share({ title: 'Bulls & Cows', text: 'Your move. Join my game of Bulls & Cows!', url: inviteURL() });
    else { await navigator.clipboard.writeText(inviteURL()); message = 'Invite link copied. Send it to your friend.'; render(); }
  } catch (err) { if (err.name !== 'AbortError') { message = 'Copy the invite link below and send it to your friend.'; render(); document.querySelector('#invite-link')?.select(); } }
}
function home() {
  return `<div class="lobby-grid"><section class="start-panel"><div class="eyebrow"><span class="tiny-line"></span> A GAME FOR TWO</div><h1>Crack their code.<br><span>Keep yours close.</span></h1><p class="intro">One friend. Four secret digits. <br>A little logic goes a long way.</p><div class="play-box">
    ${resume ? `<div class="resume"><div><strong>Your room is still here</strong><p>${e(resume.code)} · ${e(resume.name)}</p></div><button class="button small" data-action="resume">Resume ${arrow}</button></div>` : ''}
    <div class="tabs" role="tablist" aria-label="Choose how to play"><button id="create-tab" role="tab" aria-selected="${!joining}" aria-controls="play-form" tabindex="${joining ? -1 : 0}" data-action="create-tab">Create a room</button><button id="join-tab" role="tab" aria-selected="${joining}" aria-controls="play-form" tabindex="${joining ? 0 : -1}" data-action="join-tab">Join a friend</button></div>
    <form id="play-form" role="tabpanel" aria-labelledby="${joining ? 'join-tab' : 'create-tab'}"><label for="player-name">Your name <span>optional</span></label><input id="player-name" name="name" autocomplete="nickname" maxlength="20" placeholder="What should we call you?" value="${e(draftName)}" />${joining ? `<label for="room-code">Room code</label><input id="room-code" class="code-input" name="room" autocapitalize="characters" autocomplete="off" spellcheck="false" maxlength="12" placeholder="ABCD EFGH" value="${e(draftCode)}" aria-describedby="form-message" required />` : ''}<button class="button primary" type="submit" ${busy ? 'disabled' : ''}>${busy ? 'Connecting…' : joining ? 'Join the game' : 'Create a room'} ${arrow}</button><p class="form-note">${joining ? 'Your friend should have their room open.' : 'Get an invite link. Send it to your favorite rival.'}</p></form>
  </div><div id="form-message" class="message ${message ? '' : 'empty'}" role="status">${e(message)}</div><div class="lobby-meta"><span>01 vs 01</span><span>No timer</span><span>No sign-up</span></div></section>
  <aside class="intro-aside"><div class="sample-board"><div class="board-top"><span class="eyebrow">THE CODE IS THE CHALLENGE</span>${lock}</div>${tiles('1234')}<div class="sample-divider"></div><div class="sample-row"><span>A guess</span><span class="sample-number">1356</span></div><div class="sample-feedback"><div><b>1<span class="square-symbol">■</span></b><span>Bull · right place</span></div><div><b>1<span class="circle-symbol">●</span></b><span>Cow · wrong place</span></div></div></div><div class="quick-rules"><span class="eyebrow">SMALL RULES. BIG BRAIN ENERGY.</span><h2>Think it through. <br>Take your time.</h2><p>Lock your guesses together. Solve in fewer attempts to win. A tie means new secrets and another round.</p><button class="text-button" data-action="rules">The full rules <span>↗</span></button></div></aside></div>`;
}
function entryForm(secret, v) {
  return `<form id="digits-form"><label for="digits">${secret ? 'Your secret number' : 'Your next guess'}</label><div class="number-entry"><input id="digits" class="digits-input" type="${secret && !showSecret ? 'password' : 'text'}" name="digits" inputmode="numeric" pattern="[0-9]{4}" minlength="4" maxlength="4" autocomplete="off" autocorrect="off" spellcheck="false" value="${e(draftDigits)}" placeholder="${secret ? '••••' : '0000'}" aria-describedby="digits-hint game-message" required ${busy ? 'disabled' : ''}/>${secret ? `<button type="button" class="reveal-button" data-action="show-secret" aria-pressed="${showSecret}">${showSecret ? 'Hide' : 'Show'}</button>` : ''}</div><p id="digits-hint" class="hint">4 different digits. Zero can come first.</p><button class="button primary" type="submit" ${busy || state !== 'connected' ? 'disabled' : ''}>${secret ? `${lock} Lock my secret` : `Lock guess ${String(v.attempt).padStart(2, '0')} ${arrow}`}</button></form>`;
}
function history(v) {
  return `<section class="history"><div class="section-heading"><h2>Your guesses</h2><span>${v.history.length} ${v.history.length === 1 ? 'attempt' : 'attempts'}</span></div>${v.history.length ? `<table><thead><tr><th scope="col">#</th><th scope="col">Number</th><th scope="col">Bulls <span class="square-symbol">■</span></th><th scope="col">Cows <span class="circle-symbol">●</span></th></tr></thead><tbody>${[...v.history].reverse().map((h, reverse) => `<tr class="${h.bulls === 4 ? 'solved-row' : ''}"><td>${String(v.history.length - reverse).padStart(2, '0')}</td><td class="guess-number">${h.guess}</td><td><span class="count bull">${h.bulls}</span></td><td><span class="count cow">${h.cows}</span></td></tr>`).join('')}</tbody></table>` : `<div class="empty-history"><span class="empty-digits" aria-hidden="true">— — — —</span><p>Every guess gets you closer.<br>Your clues will appear here.</p></div>`}</section>`;
}
function room() {
  const v = game.view(), friend = e(session.remoteName || 'Your friend');
  const hasFriend = !!session.remoteToken;
  let content;
  if (fatal || game.error) content = `<div class="phase-label">ROUND PAUSED</div><h1>Let’s start fresh.</h1><p>${e(fatal || game.error)}</p><button class="button primary" data-action="leave">Back to the lobby ${arrow}</button>`;
  else if (!hasFriend) content = `<div class="phase-label">YOUR ROOM IS ${state === 'waiting' ? 'READY' : 'OPENING'}</div><h1>Better with<br><span>a worthy rival.</span></h1><p>Invite one friend. Keep this screen open while they join.</p><div class="invite-box"><span class="eyebrow">ROOM CODE</span><div class="room-code">${e(session.code.slice(0, 4))}<span> </span>${e(session.code.slice(4))}</div><div class="invite-actions"><button class="button primary" data-action="share" ${state === 'connecting' ? 'disabled' : ''}>Send invite ${arrow}</button><button class="button secondary" data-action="copy">Copy link</button></div><label class="sr-only" for="invite-link">Invite link</label><input id="invite-link" readonly value="${e(inviteURL())}" /></div>`;
  else if (!v.secretLocked) content = `<div class="phase-label">ROUND ${String(v.round).padStart(2, '0')} · SECRET SETUP</div><h1>${v.round === 1 ? 'Keep a little<br><span>mystery.</span>' : 'New round.<br><span>New secret.</span>'}</h1><p>${v.round === 1 ? 'Choose a code for your friend to crack. Your secret stays on this phone until the round ends.' : 'Pick a different code from your last round. Both players start again with zero guesses.'}</p>${entryForm(true, v)}`;
  else if (!v.ready) content = `<div class="phase-label">ROUND ${String(v.round).padStart(2, '0')} · SECRET LOCKED</div><h1>Your secret<br><span>is safe.</span></h1><div class="waiting-visual">${lock}<span>Waiting for ${friend} to choose a secret.</span></div><p>Once you’re both ready, the guessing begins.</p>`;
  else if (v.ended) {
    const title = v.outcome === 'win' ? 'Beautifully<br><span>deduced.</span>' : v.outcome === 'loss' ? 'A worthy<br><span>opponent.</span>' : 'Great minds<br><span>think alike.</span>';
    content = `<div class="phase-label">${v.verified ? v.outcome === 'tie' ? 'IT’S A TIE · TIEBREAKER NEXT' : v.outcome === 'win' ? 'YOU WIN THIS DUEL' : `${friend} WINS` : 'VERIFYING THE ROUND…'}</div><h1>${title}</h1><p>${v.outcome === 'tie' ? `You both cracked it in ${v.history.length} ${v.history.length === 1 ? 'guess' : 'guesses'}. The duel continues with new secrets.` : v.outcome === 'win' ? `You cracked the code in ${v.history.length} ${v.history.length === 1 ? 'guess' : 'guesses'}. Both players had the same number of attempts.` : `${friend} solved your code in ${v.history.length} ${v.history.length === 1 ? 'guess' : 'guesses'}. Another duel awaits.`}</p>${v.verified ? `<div class="result-secret"><span>${friend}’s secret</span><strong>${e(v.otherSecret)}</strong><span class="verified">✓ Verified</span></div><button class="button primary" data-action="next" ${v.ownNext || state !== 'connected' ? 'disabled' : ''}>${v.ownNext ? 'Waiting for your friend…' : v.outcome === 'tie' ? 'Play the tiebreaker' : 'Play again'} ${arrow}</button><p class="hint">${v.otherNext && !v.ownNext ? 'Your friend is ready for the next round.' : 'Both players choose new secrets for the next round.'}</p>` : '<p class="waiting-visual">Checking both secrets and every clue…</p>'}`;
  } else content = `<div class="phase-label">ROUND ${String(v.round).padStart(2, '0')} · GUESS ${String(v.attempt).padStart(2, '0')}</div><h1>Follow<br><span>the clues.</span></h1><p>${v.locked ? 'Your guess is locked. Feedback appears when both players are ready.' : 'Find your friend’s four-digit code. Think it through — this isn’t a race.'}</p>${v.locked ? `<div class="locked-guess">${tiles(game.private.guesses[v.attempt - 1].value)}<div class="waiting-visual">${lock}<span>${v.otherLocked ? 'Both guesses locked. Exchanging clues…' : `Waiting for ${friend} to lock a guess.`}</span></div></div>` : entryForm(false, v)}`;
  return `<div class="room-heading"><div><span class="eyebrow">ROOM</span><button class="room-pill" data-action="copy" aria-label="Copy invite link for room ${e(session.code)}">${e(session.code.slice(0, 4))} ${e(session.code.slice(4))} <span>↗</span></button></div><button class="text-button muted" data-action="leave">Leave room</button></div><div class="connection-banner ${state === 'connected' ? 'connected' : ''}" role="status"><span class="connection-dot"></span><span>${e(status)}</span>${['offline', 'connecting'].includes(state) ? '<button data-action="retry">Retry</button>' : ''}</div>${storageWarning ? `<div class="message">${e(storageWarning)}</div>` : ''}<div class="game-grid"><div><section class="game-panel">${content}<div class="message ${message ? '' : 'empty'}" id="game-message" role="status">${e(message)}</div></section>${v.ready ? history(v) : ''}</div><aside class="game-aside"><div class="opponent-panel"><div class="board-top"><span class="eyebrow">ACROSS THE TABLE</span><span class="player-tag">02</span></div><h2>${friend}</h2>${tiles(v.verified ? v.otherSecret : '••••', 'small-tiles')}<div class="opponent-status"><span>${!hasFriend ? 'Waiting to join' : !v.otherSecretLocked ? 'Choosing a secret' : v.ended ? 'Round complete' : !v.ready ? 'Secret locked' : v.otherLocked ? 'Guess locked' : 'Thinking it through'}</span><span>${v.otherSecretLocked ? '✓' : '…'}</span></div>${v.ready ? `<div class="opponent-progress"><b>${v.history.length}</b><span>equal ${v.history.length === 1 ? 'attempt' : 'attempts'}<br>no time pressure</span></div>` : ''}</div><div class="your-card"><div><span class="eyebrow">YOUR SIDE</span><strong>${e(session.name)}</strong></div><div class="your-secret"><span>${v.secretLocked ? showSecret ? e(game.private.secret.value) : '••••' : '— — — —'}</span>${v.secretLocked ? `<button data-action="show-secret" aria-label="${showSecret ? 'Hide' : 'Show'} your secret">${showSecret ? 'Hide' : 'Show'}</button>` : ''}</div></div><div class="compact-rules"><div><span class="count bull">B</span><p><strong>Bull</strong>Right digit, right place</p></div><div><span class="count cow">C</span><p><strong>Cow</strong>Right digit, wrong place</p></div><button class="text-button" data-action="rules">Read the rules <span>↗</span></button></div></aside></div>`;
}
function render() {
  const focused = document.activeElement?.id, selection = document.activeElement?.selectionStart;
  root.innerHTML = `<div class="app-shell"><header class="site-header"><a class="brand" href="${e(location.pathname)}" data-action="home">${mark}<span>Bulls <em>&</em> Cows<span class="brand-caption">THE FRIENDLY CODE DUEL</span></span></a><button class="rules-button" data-action="rules"><span aria-hidden="true">?</span> How to play</button></header><main>${session && game ? room() : home()}</main><footer><span>Made for a little friendly competition.</span><span>4 digits <i>·</i> 2 players <i>·</i> 1 winner</span></footer></div><dialog id="rules-dialog" aria-labelledby="rules-title"><div class="dialog-top"><span class="eyebrow">THE PLAYBOOK</span><button class="icon-button" data-action="close-rules" aria-label="Close rules">×</button></div><h2 id="rules-title">A game of deduction.</h2>${rules()}<button class="button primary" data-action="close-rules">Got it. Let’s play ${arrow}</button></dialog><dialog id="leave-dialog" aria-labelledby="leave-title"><h2 id="leave-title">Leave this duel?</h2><p>Your place in this room will be cleared. Your friend will need a new invite to play again.</p><div class="dialog-actions"><button class="button secondary" data-action="cancel-leave">Keep playing</button><button class="button primary" data-action="confirm-leave">Leave room</button></div></dialog>`;
  if (focused) { const el = document.getElementById(focused); el?.focus({ preventScroll: true }); if (selection != null) try { el.setSelectionRange(selection, selection); } catch {} }
  if (rulesOpen) document.querySelector('#rules-dialog').showModal();
  if (leaveOpen) document.querySelector('#leave-dialog').showModal();
  document.querySelectorAll('dialog').forEach(d => d.addEventListener('cancel', () => { rulesOpen = false; leaveOpen = false; }));
}
root.addEventListener('input', event => {
  const { id, value } = event.target;
  if (id === 'player-name') draftName = value;
  if (id === 'room-code') draftCode = value;
  if (id === 'digits') { draftDigits = value.replace(/\D/g, '').slice(0, 4); event.target.value = draftDigits; }
});
root.addEventListener('keydown', event => {
  if (event.target.matches('[role=tab]') && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
    event.preventDefault(); joining = event.key === 'End' ? true : event.key === 'Home' ? false : !joining; render(); document.getElementById(joining ? 'join-tab' : 'create-tab').focus();
  }
});
root.addEventListener('submit', async event => {
  event.preventDefault();
  if (event.target.id === 'play-form') return start(joining ? 'guest' : 'host');
  if (event.target.id !== 'digits-form' || busy || state !== 'connected') return;
  busy = true; message = '';
  try { const secret = !game.view().secretLocked; await (secret ? game.lockSecret(draftDigits) : game.lockGuess(draftDigits)); draftDigits = ''; showSecret = false; }
  catch (err) { message = err.message; }
  busy = false; render();
  if (message) document.querySelector('#digits')?.focus();
});
root.addEventListener('click', async event => {
  const button = event.target.closest('[data-action]'); if (!button) return;
  const action = button.dataset.action;
  if (action === 'home') { event.preventDefault(); if (session) { leaveOpen = true; render(); } return; }
  if (action === 'rules') { rulesOpen = true; document.querySelector('#rules-dialog').showModal(); }
  if (action === 'close-rules') { rulesOpen = false; document.querySelector('#rules-dialog').close(); }
  if (action.endsWith('-tab')) { joining = action === 'join-tab'; message = ''; render(); document.getElementById(action)?.focus(); }
  if (action === 'resume') { draftDigits = ''; await start(resume.role, resume); }
  if (action === 'copy' || action === 'share') await copyInvite(action === 'share');
  if (action === 'retry') network?.retry();
  if (action === 'show-secret') { showSecret = !showSecret; render(); }
  if (action === 'next') { message = ''; draftDigits = ''; showSecret = false; try { await game.nextRound(); } catch (err) { message = err.message; render(); } }
  if (action === 'leave') { leaveOpen = true; document.querySelector('#leave-dialog').showModal(); }
  if (action === 'cancel-leave') { leaveOpen = false; document.querySelector('#leave-dialog').close(); }
  if (action === 'confirm-leave') {
    network?.close(); network = null; session = null; game = null; resume = null; state = 'home'; message = ''; fatal = ''; lastSent = ''; draftDigits = ''; showSecret = false; leaveOpen = false; joining = false;
    try { sessionStorage.removeItem(storageKey); } catch {}
    window.history.replaceState(null, '', location.pathname + location.search); render();
  }
});
render();
