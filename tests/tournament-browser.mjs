import { chromium, expect } from '@playwright/test';

const url = process.env.TEST_URL || 'http://127.0.0.1:5188/';
const executable = process.env.BROWSER_EXECUTABLE || undefined;
const browser = await chromium.launch({ headless: true, ...(executable ? { executablePath: executable } : {}), args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--allow-loopback-in-peer-connection', '--disable-features=WebRtcHideLocalIpsWithMdns'] });
const errors = [];
const contexts = [];
try {
  const pages = [];
  for (let i = 0; i < 3; i++) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', permissions: ['microphone'] });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message)); pages.push(page); contexts.push(context);
  }
  const [host, guestA, guestB] = pages;
  await host.goto(url); await host.getByRole('button', { name: 'Tournament 3–4 players' }).click(); await host.getByRole('button', { name: 'Create tournament' }).click();
  await expect(host.locator('.connection-banner')).toContainText('Tournament lobby', { timeout: 30000 });
  const invite = await host.locator('#invite-link').inputValue();
  await guestA.goto(invite); await guestA.locator('#player-name').fill('Sam'); await guestA.getByRole('button', { name: 'Join tournament' }).click();
  await guestB.goto(invite); await guestB.locator('#player-name').fill('Lee'); await guestB.getByRole('button', { name: 'Join tournament' }).click();
  await expect(host.locator('.phase-label')).toContainText('3/4 PLAYERS', { timeout: 60000 });
  await host.getByRole('button', { name: /Start 3-player tournament/ }).click();
  await expect(host.locator('.phase-label')).toContainText('BYE', { timeout: 30000 });
  await expect(guestA.locator('.phase-label')).toContainText(/TOURNAMENT ROUND 01|ROUND 01/, { timeout: 30000 });
  await expect(guestB.locator('.phase-label')).toContainText(/TOURNAMENT ROUND 01|ROUND 01/, { timeout: 30000 });
  expect(errors).toEqual([]);
  console.log(JSON.stringify({ status: 'passed', checks: ['three-player roster', 'host-coordinated start', 'bye and simultaneous match assignment'] }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ status: 'failed', error: error.message, browserErrors: errors }, null, 2)); process.exitCode = 1;
} finally { await Promise.all(contexts.map(context => context.close())); await browser.close(); }
