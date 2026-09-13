import './style.css';
import QRCode from 'qrcode';
import QrScanner from 'qr-scanner';
import { registerSW } from 'virtual:pwa-register';
import { Game } from './game.js';
import { createSession, normalizeCode, validCode, RoomConnection, TournamentConnection, connectionOptions } from './network.js';
import { NearbyConnection } from './nearby.js';
import { memberName, roundComplete, standings } from './tournament.js';

registerSW({ immediate: true });

const root = document.querySelector('#app');
const storageKey = 'bulls-cows-session-v2';
const linkParams = new URLSearchParams(location.hash.slice(1));
let session = null, game = null, network = null, state = 'home', status = '', message = '', fatal = '', busy = false;
let joining = !!linkParams.get('room');
let selectedFormat = linkParams.get('mode') === 'tournament' ? 'tournament' : 'duel';
let connectionKind = 'online', tieRule = linkParams.get('tie') === 'time' ? 'time' : 'rematch';
let draftName = '', draftCode = linkParams.get('room') || '', draftDigits = '';
let showSecret = false, rulesOpen = false, leaveOpen = false, scanOpen = false, lastSent = '', storageWarning = '';
let pairingPayload = '', qrScanner = null, tournament = null, activeMatchId = null;
let clock = { key: '', base: 0, startedAt: null };
let resume = null;
try { const raw = JSON.parse(sessionStorage.getItem(storageKey)); if (raw?.version === 2 && validCode(raw.code) && ['host', 'guest'].includes(raw.role) && raw.token) resume = raw; } catch {}

const e = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const arrow = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 12h14m-6-6 6 6-6 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const lock = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="3" stroke="currentColor" stroke-width="1.8"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 4v3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
const mark = '<span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i><i></i></span>';
const tiles = (value, cls = '') => `<div class="tiles ${cls}" aria-label="${e(value === '••••' ? 'Four hidden digits' : value)}">${[...value].map((d, i) => `<span class="digit digit-${i}" aria-hidden="true">${e(d)}</span>`).join('')}</div>`;
const formatTime = ms => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${Math.floor(ms / 100) % 10}`;

function clockNow() { return clock.base + (clock.startedAt ? Date.now() - clock.startedAt : 0); }
function reconcileClock() {
  if (!game) { clock = { key: '', base: 0, startedAt: null }; return; }
  const v = game.view(), key = `${game.room}:${v.round}:${v.attempt}`;
  if (clock.key !== key) clock = { key, base: 0, startedAt: null };
  const shouldRun = state === 'connected' && v.ready && !v.ended && !v.locked;
  if (shouldRun && !clock.startedAt) clock.startedAt = Date.now();
  if (!shouldRun && clock.startedAt) { clock.base += Date.now() - clock.startedAt; clock.startedAt = null; }
}
setInterval(() => {
  if (!clock.startedAt || !game) return;
  const own = document.querySelector('#own-clock');
  if (own) own.textContent = formatTime(game.view().ownTime + clockNow());
}, 100);

function persist() {
  if (!session) return;
  if (game) {
    if (session.format === 'tournament') { (session.games ||= {})[activeMatchId] = game.saved(); }
    else session.game = game.saved();
  }
  if (tournament) session.tournament = tournament;
  try { sessionStorage.setItem(storageKey, JSON.stringify(session)); }
  catch { storageWarning = 'This browser can’t save your game. Keep this tab open; refreshing will lose your place.'; }
}
function sync(force = false) {
  if (!game) return;
  const snapshot = game.snapshot(), text = JSON.stringify(snapshot);
  if (force || text !== lastSent) { network?.send(snapshot, activeMatchId); lastSent = text; }
}
function reportTournamentResult() {
  if (session?.format !== 'tournament' || !game || !activeMatchId) return;
  const v = game.view();
  if (!v.verified || session.reportedMatches?.[activeMatchId]) return;
  (session.reportedMatches ||= {})[activeMatchId] = true;
  network?.reportResult(activeMatchId, { outcome: v.outcome, attempts: v.history.length, timeMs: v.ownTime });
}
function onGameChange() { reconcileClock(); persist(); sync(); reportTournamentResult(); render(); }
function ensureGame(roomId, saved) {
  if (game && game.room === roomId) { game.tieRule = session.tieRule; return; }
  lastSent = ''; clock = { key: '', base: 0, startedAt: null };
  game = new Game(roomId, saved, onGameChange, { tieRule: session.tieRule });
  game.task(async () => {}).catch(error => { fatal = error.message; render(); });
}
function configureSession(config = {}) {
  Object.assign(session, config);
  if (session.format === 'duel') ensureGame(session.code, session.game);
  if (game) game.tieRule = session.tieRule;
  persist();
}
function updateTournament(next) {
  tournament = next; session.tournament = next; session.tieRule = 'time';
  const corrected = next?.rounds?.[next.roundIndex]?.find(item => [item.a, item.b].includes(session.token));
  if (corrected) {
    const opponent = corrected.a === session.token ? corrected.b : corrected.a;
    session.remoteToken = opponent; session.remoteName = memberName(next, opponent);
    activeMatchId = corrected.id;
    ensureGame(`${session.code}:${corrected.id}`, session.games?.[corrected.id]);
  } else { game = null; activeMatchId = null; reconcileClock(); }
  persist(); render();
}

async function start(role, existing = null) {
  if (busy) return;
  if (!crypto.subtle || !window.RTCPeerConnection) { message = 'Use a current browser on HTTPS (or localhost) to play.'; render(); return; }
  const code = normalizeCode(draftCode);
  const format = existing?.format || selectedFormat;
  const kind = existing?.connectionKind || connectionKind;
  if (!existing && role === 'guest' && kind === 'online' && !validCode(code)) { message = 'Enter the 8-character room code from your friend.'; render(); document.querySelector('#room-code')?.focus(); return; }
  busy = true; message = ''; render();
  try {
    const options = kind === 'online' ? await connectionOptions() : null;
    session = existing || createSession(role, draftName, role === 'guest' && kind === 'online' ? code : undefined, { format, connectionKind: kind, tieRule: format === 'tournament' ? 'time' : tieRule });
    selectedFormat = session.format; connectionKind = session.connectionKind; tieRule = session.tieRule;
    tournament = session.tournament || null;
    state = kind === 'nearby' ? 'pairing' : 'connecting'; status = kind === 'nearby' ? 'Preparing nearby pairing…' : 'Opening a connection…';
    if (format === 'duel' && !(kind === 'nearby' && role === 'guest')) ensureGame(session.code, session.game);
    const callbacks = {
      status(kindState, text) { state = kindState; status = text; reconcileClock(); render(); },
      configured(config) { configureSession(config); },
      pairing(payload) { pairingPayload = payload; render(); },
      ready(remote) { configureSession({ remoteName: String(remote?.name || session.remoteName || 'Player').slice(0, 20), remoteToken: remote?.token || session.remoteToken }); state = 'connected'; reconcileClock(); persist(); sync(true); render(); },
      data(rounds, matchId) { if (session.format !== 'tournament' || matchId === activeMatchId) game?.receive(rounds).catch(err => { fatal = err.message; render(); }); },
      tournament: next => updateTournament(next),
      error(text) { fatal = text; render(); },
    };
    if (format === 'tournament') network = new TournamentConnection(session, callbacks, options);
    else if (kind === 'nearby') network = new NearbyConnection(session, callbacks);
    else network = new RoomConnection(session, callbacks, options);
    persist();
  } catch (err) { message = err.message || 'Couldn’t open the room. Please try again.'; if (!network) { session = null; game = null; state = 'home'; } }
  busy = false; render();
}

function inviteURL() {
  const url = new URL(location.href), params = new URLSearchParams({ room: session.code });
  if (session.format === 'tournament') params.set('mode', 'tournament');
  if (session.tieRule === 'time') params.set('tie', 'time');
  url.hash = params.toString(); return url.href;
}
async function copyInvite(share = false) {
  try {
    if (share && navigator.share) await navigator.share({ title: 'Bulls & Cows', text: session.format === 'tournament' ? 'Join my Bulls & Cows tournament!' : 'Your move. Join my game of Bulls & Cows!', url: inviteURL() });
    else { await navigator.clipboard.writeText(inviteURL()); message = 'Invite link copied. Send it to your friend.'; render(); }
  } catch (err) { if (err.name !== 'AbortError') { message = 'Copy the invite link below and send it to your friend.'; render(); document.querySelector('#invite-link')?.select(); } }
}

const rules = () => `<div class="rules-content"><div class="rule-line"><span class="count bull">B</span><div><strong>Bull</strong><p>Right digit. Right place.</p></div></div><div class="rule-line"><span class="count cow">C</span><div><strong>Cow</strong><p>Right digit. Different place.</p></div></div><div class="example"><span class="eyebrow">FOR EXAMPLE</span><div><span>Secret <b>1234</b></span><span>Guess <b>1356</b></span></div><p><strong>1 bull · 1 cow</strong><br>1 is in place. 3 belongs elsewhere.</p></div><ol><li>Choose four different digits, 0–9.</li><li>Both players lock a guess. Each clock stops as soon as that player locks.</li><li>Crack the code in fewer guesses. With the speed rule, equal-attempt solves go to the lower thinking time.</li><li>Nearby mode pairs by QR on the same Wi‑Fi or hotspot and works after the app has been cached.</li></ol></div>`;

function home() {
  const nearby = connectionKind === 'nearby', tournamentMode = selectedFormat === 'tournament';
  return `<div class="lobby-grid"><section class="start-panel"><div class="eyebrow"><span class="tiny-line"></span>A GAME FOR FRIENDS</div><h1>Crack their code.<br><span>Keep yours close.</span></h1><p class="intro">Play online, pair nearby without internet, or gather a small tournament.</p><div class="play-box">
    ${resume ? `<div class="resume"><div><strong>Your room is still here</strong><p>${e(resume.code)} · ${e(resume.name)}</p></div><button class="button small" data-action="resume">Resume ${arrow}</button></div>` : ''}
    <div class="mode-picker" aria-label="Game mode"><button data-action="mode-online" class="${!nearby && !tournamentMode ? 'selected' : ''}"><strong>Online duel</strong><span>Simple room code</span></button><button data-action="mode-nearby" class="${nearby ? 'selected' : ''}"><strong>Nearby offline</strong><span>Same Wi‑Fi + QR</span></button><button data-action="mode-tournament" class="${tournamentMode ? 'selected' : ''}"><strong>Tournament</strong><span>3–4 players</span></button></div>
    <div class="tabs" role="tablist" aria-label="Choose how to play"><button id="create-tab" role="tab" aria-selected="${!joining}" tabindex="${joining ? -1 : 0}" data-action="create-tab">Create a room</button><button id="join-tab" role="tab" aria-selected="${joining}" tabindex="${joining ? 0 : -1}" data-action="join-tab">Join friends</button></div>
    <form id="play-form"><label for="player-name">Your name <span>optional</span></label><input id="player-name" name="name" autocomplete="nickname" maxlength="20" placeholder="What should we call you?" value="${e(draftName)}" />${joining && !nearby ? `<label for="room-code">Room code</label><input id="room-code" class="code-input" name="room" autocapitalize="characters" autocomplete="off" spellcheck="false" maxlength="12" placeholder="ABCD EFGH" value="${e(draftCode)}" required />` : ''}${!joining && !tournamentMode ? `<label for="tie-rule">If both solve together</label><select id="tie-rule" name="tieRule"><option value="rematch" ${tieRule === 'rematch' ? 'selected' : ''}>Play a tiebreaker round</option><option value="time" ${tieRule === 'time' ? 'selected' : ''}>Lower thinking time wins</option></select>` : ''}<button class="button primary" type="submit" ${busy ? 'disabled' : ''}>${busy ? 'Connecting…' : joining ? nearby ? 'Pair with the host' : tournamentMode ? 'Join tournament' : 'Join the game' : tournamentMode ? 'Create tournament' : nearby ? 'Create nearby room' : 'Create a room'} ${arrow}</button><p class="form-note">${nearby ? 'Open the cached app on both devices and connect them to the same Wi‑Fi or hotspot.' : tournamentMode ? 'Invite 2–3 friends. The host stays online to coordinate all matches.' : 'Invite one friend with a link or room code.'}</p></form>
  </div><div class="lobby-meta"><span>Encrypted P2P</span><span>Equal turns</span><span>${tournamentMode ? 'Round robin' : 'No account'}</span></div></section>
  <aside class="intro-aside"><div class="sample-board"><div class="board-top"><span class="eyebrow">THE CODE IS THE CHALLENGE</span>${lock}</div>${tiles('1234')}<div class="sample-divider"></div><div class="sample-row"><span>A guess</span><span class="sample-number">1356</span></div><div class="sample-feedback"><div><b>1<span class="square-symbol">■</span></b><span>Bull · right place</span></div><div><b>1<span class="circle-symbol">●</span></b><span>Cow · wrong place</span></div></div></div><div class="quick-rules"><span class="eyebrow">NEW WAYS TO PLAY</span><h2>Across the world.<br>Or across the table.</h2><p>Online duels use public signaling. Nearby rooms exchange WebRTC details by QR and then stay on your local network.</p><button class="text-button" data-action="rules">The full rules <span>↗</span></button></div></aside></div>`;
}

function pairingBox() {
  const guestNeedsOffer = session.role === 'guest' && !pairingPayload;
  return `<section class="game-panel pairing-panel"><div class="phase-label">NEARBY OFFLINE · SAME WI-FI OR HOTSPOT</div><h1>${guestNeedsOffer ? 'Scan the host’s code.' : session.role === 'host' ? 'Pair the two screens.' : 'Return this answer.'}</h1><p>${guestNeedsOffer ? 'Ask the host to show their QR code, then scan it here.' : session.role === 'host' ? 'Your friend scans this offer. Then scan the answer shown on their device.' : 'The host must scan this answer to finish the direct connection.'}</p>${pairingPayload ? `<div class="qr-wrap"><canvas id="pairing-qr" aria-label="Nearby pairing QR code"></canvas></div><textarea id="pairing-code" readonly>${e(pairingPayload)}</textarea>` : ''}<div class="pairing-actions">${pairingPayload ? '<button class="button secondary" data-action="copy-pairing">Copy pairing code</button>' : ''}<button class="button primary" data-action="scan-pairing">${guestNeedsOffer ? 'Scan host QR' : session.role === 'host' ? 'Scan friend’s answer' : 'Scan again'} ${arrow}</button></div><p class="hint">No camera? Copy the long pairing code between devices and paste it in the scanner dialog.</p></section>`;
}

function inviteBox(label = 'ROOM CODE') {
  return `<div class="invite-box"><span class="eyebrow">${label}</span><div class="room-code">${e(session.code.slice(0, 4))}<span> </span>${e(session.code.slice(4))}</div><div class="invite-actions"><button class="button primary" data-action="share">Send invite ${arrow}</button><button class="button secondary" data-action="copy">Copy link</button></div><label class="sr-only" for="invite-link">Invite link</label><input id="invite-link" readonly value="${e(inviteURL())}" /></div>`;
}
function digitsForm(secret) {
  return `<form id="digits-form"><label for="digits">${secret ? 'Your secret number' : 'Your next guess'}</label><div class="number-entry"><input id="digits" class="digits-input" type="${secret && !showSecret ? 'password' : 'text'}" name="digits" inputmode="numeric" pattern="[0-9]{4}" minlength="4" maxlength="4" autocomplete="off" value="${e(draftDigits)}" placeholder="${secret ? '••••' : '0000'}" required ${busy ? 'disabled' : ''}/>${secret ? `<button type="button" class="reveal-button" data-action="show-secret">${showSecret ? 'Hide' : 'Show'}</button>` : ''}</div><p class="hint">4 different digits. Zero can come first.</p><button class="button primary" type="submit" ${busy || state !== 'connected' ? 'disabled' : ''}>${secret ? `${lock} Lock my secret` : `Lock guess ${String(game.view().attempt).padStart(2, '0')} ${arrow}`}</button></form>`;
}
function clocks(v) {
  const ownCurrent = v.ownTime + (v.locked ? 0 : clockNow());
  return `<div class="clocks"><div><span>YOUR THINKING TIME</span><strong id="own-clock">${formatTime(ownCurrent)}</strong></div><div><span>${e(session.remoteName || 'OPPONENT').toUpperCase()}</span><strong>${formatTime(v.otherTime)}</strong></div></div>`;
}
function turnNotice(v) {
  if (!v.ready || v.ended) return '';
  if (v.locked && !v.otherLocked) return '<div class="turn-notice waiting">✓ You played · waiting for your opponent</div>';
  if (!v.locked && v.otherLocked) return '<div class="turn-notice action">Your opponent played · they are waiting for you</div>';
  if (v.locked && v.otherLocked) return '<div class="turn-notice waiting">Both played · checking the turn</div>';
  return '<div class="turn-notice">Your opponent is still thinking</div>';
}
function history(v) {
  if (!v.history.length) return '<div class="empty-history"><div class="empty-digits">— — — —</div><p>Your guesses will appear here after both players lock.</p></div>';
  return `<section class="history"><div class="section-heading"><h2>Your guesses</h2><span>Equal attempts</span></div><table><thead><tr><th>#</th><th>Guess</th><th>Bulls</th><th>Cows</th></tr></thead><tbody>${v.history.map((row, i) => `<tr class="${row.bulls === 4 ? 'solved-row' : ''}"><td>${String(i + 1).padStart(2, '0')}</td><td class="guess-number">${e(row.guess)}</td><td><span class="count bull">${row.bulls}</span></td><td><span class="count cow">${row.cows}</span></td></tr>`).join('')}</tbody></table></section>`;
}

function standingsTable() {
  const rows = standings(tournament);
  return `<section class="standings"><div class="section-heading"><h2>Standings</h2><span>3 win · 1 draw</span></div><table><thead><tr><th>#</th><th>Player</th><th>W–D–L</th><th>Pts</th><th>Time</th></tr></thead><tbody>${rows.map((row, index) => `<tr><td>${index + 1}</td><td><strong>${e(row.name)}</strong></td><td>${row.wins}–${row.draws}–${row.losses}</td><td>${row.points}</td><td>${formatTime(row.timeMs)}</td></tr>`).join('')}</tbody></table></section>`;
}

function tournamentLobby() {
  const members = tournament?.members || [{ token: session.token, name: session.name }];
  if (tournament?.complete) {
    const rows = standings(tournament), winners = rows.filter(row => row.points === rows[0]?.points && row.wins === rows[0]?.wins && row.attempts === rows[0]?.attempts && row.timeMs === rows[0]?.timeMs);
    return `<section class="game-panel tournament-panel"><div class="phase-label">TOURNAMENT COMPLETE</div><h1>${winners.length === 1 ? `${e(winners[0].name)} wins the table.` : 'The table ends level.'}</h1><p>Every pairing has played. Rankings use points, then wins, fewer attempts, and lower thinking time.</p>${standingsTable()}</section>`;
  }
  if (!tournament?.started) return `<section class="game-panel tournament-panel"><div class="phase-label">TOURNAMENT LOBBY · ${members.length}/4 PLAYERS</div><h1>Gather the table.</h1><p>Three or four total players. With four, two matches run at once. The host keeps this tab open to coordinate the room.</p><div class="roster">${members.map((member, i) => `<div><span>${String(i + 1).padStart(2, '0')}</span><strong>${e(member.name)}</strong><small>${member.token === session.token ? 'You' : 'Connected'}</small></div>`).join('')}${Array.from({ length: 4 - members.length }, () => '<div class="empty"><span>—</span><strong>Open seat</strong><small>Waiting</small></div>').join('')}</div>${session.role === 'host' ? `<button class="button primary" data-action="start-tournament" ${members.length < 3 ? 'disabled' : ''}>Start ${members.length}-player tournament ${arrow}</button>` : '<div class="turn-notice waiting">Waiting for the host to start the tournament</div>'}${inviteBox('TOURNAMENT CODE')}</section>`;
  const currentRound = tournament.roundIndex + 1;
  return `<section class="game-panel tournament-panel"><div class="phase-label">ROUND ${String(currentRound).padStart(2, '0')} OF ${String(tournament.rounds.length).padStart(2, '0')} · BYE</div><h1>Your next duel is coming.</h1><p>The other players are finishing this round. Your clock is paused.</p>${session.role === 'host' && roundComplete(tournament) ? `<button class="button primary" data-action="advance-tournament">${currentRound === tournament.rounds.length ? 'Finish tournament' : 'Start next round'} ${arrow}</button>` : '<div class="turn-notice waiting">Waiting for the active match</div>'}${standingsTable()}</section>`;
}

function gameRoom() {
  const v = game.view(), friend = e(session.remoteName || 'Your friend'), hasFriend = !!session.remoteToken;
  let content;
  if (fatal || game.error) content = `<div class="phase-label">ROUND PAUSED</div><h1>Let’s start fresh.</h1><p>${e(fatal || game.error)}</p><button class="button primary" data-action="leave">Back to the lobby ${arrow}</button>`;
  else if (!hasFriend && session.format === 'duel') content = `<div class="phase-label">YOUR ROOM IS ${state === 'waiting' ? 'READY' : 'OPENING'}</div><h1>Better with<br><span>a worthy rival.</span></h1><p>Invite one friend. Keep this screen open while they join.</p>${inviteBox()}`;
  else if (!v.secretLocked) content = `<div class="phase-label">${session.format === 'tournament' ? `TOURNAMENT ROUND ${String(tournament.roundIndex + 1).padStart(2, '0')}` : `ROUND ${String(v.round).padStart(2, '0')}`} · SET YOUR CODE</div><h1>Choose your<br><span>secret number.</span></h1><p>Your secret stays on this device until the round ends.</p>${digitsForm(true)}`;
  else if (!v.ready) content = `<div class="phase-label">SECRET LOCKED</div><h1>Waiting for ${friend}.</h1><p>Your clock starts only when both secrets are locked.</p><div class="waiting-visual">${lock} Your secret is committed and hidden.</div>`;
  else if (!v.ended && !v.locked) content = `<div class="phase-label">ROUND ${String(v.round).padStart(2, '0')} · ATTEMPT ${String(v.attempt).padStart(2, '0')}</div><h1>Make your move.</h1>${turnNotice(v)}${clocks(v)}${digitsForm(false)}`;
  else if (!v.ended) content = `<div class="phase-label">ATTEMPT ${String(v.attempt).padStart(2, '0')} · LOCKED</div><h1>Your move is in.</h1>${turnNotice(v)}${clocks(v)}<div class="locked-guess">${tiles(game.private.guesses?.[v.attempt - 1]?.value || '••••')}<p class="waiting-visual">Your clock is paused while ${friend} finishes.</p></div>`;
  else {
    const timed = v.timedDecision ? ' on time' : '';
    const title = v.outcome === 'tie' ? 'Same solve. Same time.' : v.outcome === 'win' ? `You win${timed}.` : `${friend} wins${timed}.`;
    const phase = v.outcome === 'tie' ? 'IT’S A TIE' : v.outcome === 'win' ? 'YOU WIN THIS DUEL' : `${friend} WINS`;
    const action = session.format === 'tournament'
      ? session.role === 'host' && roundComplete(tournament) ? `<button class="button primary" data-action="advance-tournament">${tournament.roundIndex + 1 === tournament.rounds.length ? 'Finish tournament' : 'Start next round'} ${arrow}</button>` : '<div class="turn-notice waiting">Result recorded · waiting for the round to finish</div>'
      : `<button class="button primary" data-action="next" ${v.ownNext || state !== 'connected' ? 'disabled' : ''}>${v.ownNext ? 'Waiting for your friend…' : v.outcome === 'tie' ? 'Play the tiebreaker' : 'Play again'} ${arrow}</button>`;
    content = `<div class="phase-label">${phase}</div><h1>${title}</h1><p>${v.timedDecision ? `Both solved on attempt ${v.history.length}; the lower thinking time decides the winner.` : v.outcome === 'tie' ? 'Both players finished together. Play another round to decide it.' : `Solved in ${v.history.length} ${v.history.length === 1 ? 'attempt' : 'attempts'}.`}</p>${clocks(v)}${v.verified ? `<div class="result-secret"><span>${friend}’s secret</span><strong>${e(v.otherSecret)}</strong><span class="verified">✓ Verified</span></div>${action}` : '<p class="waiting-visual">Checking both secrets and every clue…</p>'}`;
  }
  const opponentState = !hasFriend ? 'Waiting to join' : !v.otherSecretLocked ? 'Choosing a secret' : v.ended ? 'Round complete' : v.otherLocked && !v.locked ? 'Played · waiting for you' : v.otherLocked ? 'Guess locked' : v.locked ? 'Thinking · you are waiting' : 'Thinking about their move';
  return `<div class="game-grid"><div><section class="game-panel">${content}<div class="message ${message ? '' : 'empty'}" id="game-message" role="status">${e(message)}</div></section>${v.ready ? history(v) : ''}${session.format === 'tournament' ? standingsTable() : ''}</div><aside class="game-aside"><div class="opponent-panel"><div class="board-top"><span class="eyebrow">ACROSS THE TABLE</span><span class="player-tag">02</span></div><h2>${friend}</h2>${tiles(v.verified ? v.otherSecret : '••••', 'small-tiles')}<div class="opponent-status"><span>${opponentState}</span><span>${v.otherLocked ? '✓' : '…'}</span></div>${v.ready ? `<div class="opponent-progress"><b>${v.history.length}</b><span>equal attempts<br>${formatTime(v.otherTime)} recorded</span></div>` : ''}</div><div class="your-card"><div><span class="eyebrow">YOUR SIDE</span><strong>${e(session.name)}</strong></div><div class="your-secret"><span>${v.secretLocked ? showSecret ? e(game.private.secret.value) : '••••' : '— — — —'}</span>${v.secretLocked ? `<button data-action="show-secret">${showSecret ? 'Hide' : 'Show'}</button>` : ''}</div></div></aside></div>`;
}

function room() {
  const top = `<div class="room-heading"><div><span class="eyebrow">${session.format === 'tournament' ? 'TOURNAMENT' : session.connectionKind === 'nearby' ? 'NEARBY' : 'ROOM'}</span><button class="room-pill" data-action="${session.connectionKind === 'nearby' ? 'noop' : 'copy'}">${e(session.code.slice(0, 4))} ${e(session.code.slice(4))}<span>↗</span></button></div><button class="text-button muted" data-action="leave">Leave room</button></div><div class="connection-banner ${state === 'connected' ? 'connected' : ''}" role="status"><span class="connection-dot"></span><span>${e(status)}</span></div>${storageWarning ? `<div class="message">${e(storageWarning)}</div>` : ''}`;
  if (session.connectionKind === 'nearby' && state !== 'connected') return top + pairingBox();
  if (session.format === 'tournament' && (!tournament?.started || tournament.complete || !game)) return top + tournamentLobby();
  return top + gameRoom();
}

function dialogs() {
  return `<dialog id="rules-dialog" aria-labelledby="rules-title"><div class="dialog-top"><span class="eyebrow">THE PLAYBOOK</span><button class="icon-button" data-action="close-rules" aria-label="Close rules">×</button></div><h2 id="rules-title">A game of deduction.</h2>${rules()}<button class="button primary" data-action="close-rules">Got it. Let’s play ${arrow}</button></dialog><dialog id="leave-dialog" aria-labelledby="leave-title"><h2 id="leave-title">Leave this room?</h2><p>Your local place and saved match will be cleared.</p><div class="dialog-actions"><button class="button secondary" data-action="cancel-leave">Keep playing</button><button class="button primary" data-action="confirm-leave">Leave room</button></div></dialog><dialog id="scan-dialog" aria-labelledby="scan-title"><div class="dialog-top"><span class="eyebrow">NEARBY PAIRING</span><button class="icon-button" data-action="close-scan" aria-label="Close scanner">×</button></div><h2 id="scan-title">Scan the other screen.</h2><video id="qr-video" playsinline></video><p class="hint">Or paste the long pairing code:</p><textarea id="pairing-paste" placeholder="BC-NEARBY-2:…"></textarea><button class="button primary" data-action="apply-pairing">Use pairing code ${arrow}</button><div class="message ${message ? '' : 'empty'}">${e(message)}</div></dialog>`;
}

function render() {
  reconcileClock();
  root.innerHTML = `<div class="app-shell"><header class="site-header"><a class="brand" href="${e(location.pathname)}" data-action="home">${mark}<span>Bulls <em>&</em> Cows<span class="brand-caption">THE FRIENDLY CODE DUEL</span></span></a><button class="rules-button" data-action="rules"><span aria-hidden="true">?</span> How to play</button></header><main>${session ? room() : home()}</main><footer><span>Made for a little friendly competition.</span><span>Online <i>·</i> Nearby <i>·</i> Tournament</span></footer></div>${dialogs()}`;
  if (rulesOpen) document.querySelector('#rules-dialog')?.showModal();
  if (leaveOpen) document.querySelector('#leave-dialog')?.showModal();
  if (scanOpen) document.querySelector('#scan-dialog')?.showModal();
  if (pairingPayload && document.querySelector('#pairing-qr')) QRCode.toCanvas(document.querySelector('#pairing-qr'), pairingPayload, { width: 300, margin: 2, errorCorrectionLevel: 'L', color: { dark: '#17231d', light: '#ffffff' } }).catch(error => { message = error.message; });
}

async function closeScanner() {
  scanOpen = false;
  if (qrScanner) { await qrScanner.stop(); qrScanner.destroy(); qrScanner = null; }
  document.querySelector('#scan-dialog')?.close();
}
async function usePairing(value) {
  try {
    busy = true; message = '';
    await network.acceptPairing(value);
    await closeScanner();
  } catch (error) { message = error.message; }
  busy = false; render();
}
async function openScanner() {
  scanOpen = true; message = ''; render();
  const video = document.querySelector('#qr-video');
  try {
    qrScanner = new QrScanner(video, result => usePairing(result.data), { returnDetailedScanResult: true, highlightScanRegion: true, preferredCamera: 'environment' });
    await qrScanner.start();
  } catch {
    message = 'Camera scanning is unavailable. Paste the pairing code below instead.';
    const note = document.querySelector('#scan-dialog .message'); if (note) { note.textContent = message; note.classList.remove('empty'); }
  }
}
function leaveRoom() {
  closeScanner(); network?.close();
  session = null; game = null; network = null; tournament = null; activeMatchId = null; pairingPayload = '';
  state = 'home'; status = ''; message = ''; fatal = ''; leaveOpen = false; showSecret = false; lastSent = '';
  clock = { key: '', base: 0, startedAt: null };
  try { sessionStorage.removeItem(storageKey); } catch {}
  window.history.replaceState(null, '', location.pathname + location.search); render();
}

root.addEventListener('input', event => {
  if (event.target.id === 'player-name') draftName = event.target.value;
  if (event.target.id === 'room-code') draftCode = event.target.value;
  if (event.target.id === 'digits') draftDigits = event.target.value.replace(/\D/g, '').slice(0, 4);
});
root.addEventListener('change', event => { if (event.target.id === 'tie-rule') tieRule = event.target.value; });
root.addEventListener('submit', async event => {
  event.preventDefault();
  if (event.target.id === 'play-form') {
    tieRule = event.target.elements.tieRule?.value || tieRule;
    await start(joining ? 'guest' : 'host'); return;
  }
  if (event.target.id !== 'digits-form' || busy || state !== 'connected' || !game) return;
  busy = true; message = '';
  try {
    const v = game.view();
    if (!v.secretLocked) await game.lockSecret(draftDigits);
    else {
      reconcileClock(); const elapsed = Math.min(86400000, Math.round(clockNow()));
      clock.startedAt = null; clock.base = elapsed;
      await game.lockGuess(draftDigits, elapsed);
    }
    draftDigits = '';
  } catch (error) { message = error.message; }
  busy = false; render();
});
root.addEventListener('click', async event => {
  const button = event.target.closest('[data-action]'); if (!button) return;
  const action = button.dataset.action;
  if (action === 'mode-online') { selectedFormat = 'duel'; connectionKind = 'online'; joining = false; message = ''; render(); }
  else if (action === 'mode-nearby') { selectedFormat = 'duel'; connectionKind = 'nearby'; joining = false; message = ''; render(); }
  else if (action === 'mode-tournament') { selectedFormat = 'tournament'; connectionKind = 'online'; tieRule = 'time'; joining = false; message = ''; render(); }
  else if (action === 'create-tab') { joining = false; render(); }
  else if (action === 'join-tab') { joining = true; render(); }
  else if (action === 'resume') await start(resume.role, resume);
  else if (action === 'rules') { rulesOpen = true; render(); }
  else if (action === 'close-rules') { rulesOpen = false; document.querySelector('#rules-dialog')?.close(); }
  else if (action === 'show-secret') { showSecret = !showSecret; render(); }
  else if (action === 'copy') await copyInvite(false);
  else if (action === 'share') await copyInvite(true);
  else if (action === 'copy-pairing') { await navigator.clipboard.writeText(pairingPayload); message = 'Pairing code copied.'; render(); }
  else if (action === 'scan-pairing') await openScanner();
  else if (action === 'close-scan') await closeScanner();
  else if (action === 'apply-pairing') await usePairing(document.querySelector('#pairing-paste')?.value || '');
  else if (action === 'start-tournament') network?.startTournament();
  else if (action === 'advance-tournament') network?.advanceTournament();
  else if (action === 'next') { try { await game.nextRound(); } catch (error) { message = error.message; render(); } }
  else if (action === 'leave' || action === 'home') { leaveOpen = true; render(); }
  else if (action === 'cancel-leave') { leaveOpen = false; document.querySelector('#leave-dialog')?.close(); }
  else if (action === 'confirm-leave') leaveRoom();
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  if (scanOpen) closeScanner();
  if (rulesOpen) { rulesOpen = false; document.querySelector('#rules-dialog')?.close(); }
  if (leaveOpen) { leaveOpen = false; document.querySelector('#leave-dialog')?.close(); }
});
window.addEventListener('beforeunload', () => { reconcileClock(); persist(); });

render();
