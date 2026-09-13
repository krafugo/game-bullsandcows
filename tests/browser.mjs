import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';

const url = process.env.TEST_URL || 'http://127.0.0.1:5188/';
const output = new URL('../outputs/', import.meta.url).pathname;
await mkdir(output, { recursive: true });
const loopback = process.argv.includes('--loopback');
const executable = process.env.BROWSER_EXECUTABLE || process.argv[process.argv.indexOf('--executable') + 1];
// Some VPN routes cannot hairpin a peer connection on the same computer. This
// opt-in harness exposes loopback ICE candidates using a fake media device. It
// changes only the isolated test browser; the app never asks for a microphone.
const browser = await chromium.launch({ headless: true, ...(loopback ? {args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--allow-loopback-in-peer-connection','--disable-features=WebRtcHideLocalIpsWithMdns']} : {}), ...((process.env.BROWSER_EXECUTABLE || process.argv.includes('--executable')) ? { executablePath: executable } : {}) });
const errors = [], signaling = [];
const report = { started: new Date().toISOString(), url, mode: loopback ? 'Test-only loopback ICE with fake media permission; actual PeerJS signaling and WebRTC data channel' : 'Default browser networking', checks: [], limitation: 'Separate browser contexts on one computer. This is not proof of two physical phones or different mobile networks.' };
async function page(width = 390, height = 844) {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce', ...(loopback ? {permissions:['microphone']} : {}) });
  const p = await context.newPage();
  p.on('pageerror', error => errors.push(error.message));
  p.on('websocket', socket => { if (socket.url().includes('peerjs.com')) signaling.push('Public PeerJS WebSocket opened'); });
  return p;
}
async function enableLoopback(p) { if(loopback) await p.evaluate(async () => { window.__testStream = await navigator.mediaDevices.getUserMedia({audio:true}); }); }
async function submit(p, digits) { await p.locator('#digits').fill(digits); await p.locator('#digits-form button[type=submit]').click(); }
try {
  const a = await page(), b = await page();
  await a.goto(url, {waitUntil:'domcontentloaded'}); await expect(a.getByRole('button', {name:'Create a room',exact:true})).toBeVisible();
  await a.screenshot({path:output+'bulls-and-cows-mobile.png',fullPage:true});
  for (const width of [360,390,768,1440]) {
    await a.setViewportSize({width,height:900});
    const overflow = await a.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    expect(overflow, `Lobby overflow at ${width}`).toBe(false);
  }
  await a.screenshot({path:output+'bulls-and-cows-desktop.png',fullPage:true});
  await a.getByRole('button',{name:'How to play'}).click();
  await expect(a.getByRole('dialog')).toBeVisible();
  await a.keyboard.press('Escape'); await expect(a.getByRole('dialog')).toHaveCount(0);
  report.checks.push('Lobby at 360, 390, 768, 1440 pixels; rules dialog and Escape');
  await a.setViewportSize({width:390,height:844});
  await enableLoopback(a);
  await a.locator('#player-name').fill('Alex');
  await a.getByRole('button',{name:'Create a room',exact:true}).click();
  await expect(a.locator('.connection-banner')).toContainText('Room open',{timeout:60000});
  const invite = await a.locator('#invite-link').inputValue();
  await b.goto(invite, {waitUntil:'domcontentloaded'}); await b.locator('#player-name').fill('Sam');
  await enableLoopback(b);
  await b.getByRole('button',{name:'Join the game',exact:true}).click();
  await expect(a.locator('.connection-banner')).toContainText('Both players connected',{timeout:60000});
  await expect(b.locator('.connection-banner')).toContainText('Both players connected',{timeout:60000});
  report.checks.push('Two independent contexts connected through public PeerJS signaling and real WebRTC');
  await submit(a,'1123'); await expect(a.locator('#game-message')).toContainText('different digits');
  await submit(a,'0123'); await submit(b,'5678');
  await expect(a.locator('#digits-form label')).toHaveText('Your next guess');
  await expect(b.locator('#digits-form label')).toHaveText('Your next guess');
  await submit(a,'9876');
  await expect(a.locator('.locked-guess')).toBeVisible();
  await expect(b.locator('.opponent-status')).toContainText('Played · waiting for you');
  expect(await b.locator('.small-tiles').innerText()).not.toContain('0123');
  await submit(b,'9012');
  await expect(a.locator('tbody tr')).toHaveCount(1);
  await expect(b.locator('tbody tr')).toHaveCount(1);
  await expect(a.locator('tbody tr').first()).toContainText('9876');
  await a.screenshot({path:output+'bulls-and-cows-game-mobile.png',fullPage:true});
  await a.setViewportSize({width:1440,height:1000});
  await a.screenshot({path:output+'bulls-and-cows-game-desktop.png',fullPage:true});
  report.checks.push('Invalid secret rejected, leading-zero secret accepted, no early feedback, paired attempt history');

  // A third independent browser with the invite must not replace the original guest.
  const c = await page(); await c.goto(invite, {waitUntil:'domcontentloaded'}); await enableLoopback(c); await c.getByRole('button',{name:'Join the game',exact:true}).click();
  await expect(c.locator('.connection-banner')).toContainText(/already has two|reserved/,{timeout:30000});
  await expect(a.locator('.opponent-panel h2')).toHaveText('Sam');
  report.checks.push('Third player refused');
  await c.context().close();

  // Restore the guest after a real peer disconnect, then continue this same round.
  await b.reload({waitUntil:'domcontentloaded'}); await enableLoopback(b); await b.getByRole('button',{name:'Resume'}).click();
  await expect(b.locator('.connection-banner')).toContainText('Both players connected',{timeout:60000});
  await expect(b.locator('tbody tr')).toHaveCount(1);
  await submit(a,'5678'); await submit(b,'0123');
  await expect(a.locator('.phase-label')).toContainText('IT’S A TIE',{timeout:20000});
  await expect(b.locator('.phase-label')).toContainText('IT’S A TIE');
  await expect(a.locator('.verified')).toHaveText('✓ Verified');
  report.checks.push('Guest refresh/resume preserved history; tied result verified');
  await a.getByRole('button',{name:'Play the tiebreaker'}).click();
  await b.getByRole('button',{name:'Play the tiebreaker'}).click();
  await expect(a.locator('.phase-label')).toContainText('ROUND 02');
  await submit(a,'0123'); await expect(a.locator('#game-message')).toContainText('new secret');
  await submit(a,'1234'); await submit(b,'6789');
  await expect(a.locator('#digits-form label')).toHaveText('Your next guess');
  await submit(a,'6789'); await submit(b,'0123');
  await expect(a.locator('.phase-label')).toContainText('YOU WIN THIS DUEL');
  await expect(b.locator('.phase-label')).toContainText('Alex WINS');
  report.checks.push('Tiebreaker requires new secrets; verified winner and loser after equal attempts');
  await a.getByRole('button',{name:'Leave room',exact:true}).click();
  await a.locator('#leave-dialog').getByRole('button',{name:'Keep playing'}).click();
  await expect(a.locator('.phase-label')).toContainText('YOU WIN');
  await a.getByRole('button',{name:'Leave room',exact:true}).click();
  await a.locator('#leave-dialog').getByRole('button',{name:'Leave room',exact:true}).click();
  await expect(a.getByRole('button',{name:'Create a room',exact:true})).toBeVisible();
  await expect(b.locator('.connection-banner')).toContainText('left the room');
  report.checks.push('Leave confirmation cancel and leave notification');
  expect(errors).toEqual([]);
  report.signalingConnections = signaling.length;
  report.status = 'passed';
  console.log(JSON.stringify(report,null,2));
} catch(error) {
  report.status = 'failed'; report.error = error.message; report.browserErrors = errors;
  console.error(JSON.stringify(report,null,2)); process.exitCode = 1;
} finally {
  await writeFile(output+`browser-validation${loopback ? '-loopback' : ''}.json`,JSON.stringify(report,null,2)+'\n');
  await browser.close();
}
