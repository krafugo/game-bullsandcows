# Bulls & Cows

A responsive browser game with online duels, nearby offline pairing, and 3–4 player tournaments. Static frontend, real browser-to-browser multiplayer, no player account or application database required. Built with vanilla JavaScript, Vite, PeerJS, WebRTC, and a cacheable PWA shell.

## Run the game

Use Node 22.12 or newer:

```sh
npm ci
npm run dev
```

Open http://127.0.0.1:5187. Choose Online duel, Nearby offline, or Tournament. Online rooms use a link/code; nearby rooms use a QR offer/answer on the same Wi‑Fi or hotspot. For remote play, both devices must load a publicly reachable **HTTPS** deployment. `localhost` only reaches the device it runs on.

```sh
npm test
npm run build
npm run preview
```

The production preview is http://127.0.0.1:5188/. The development server uses port 5187; both fail rather than silently switching ports. `npm run test:browser` targets the production preview by default. Install Playwright's test browser with `npx playwright install chromium` when needed, or pass `-- --executable /absolute/path/to/chromium` to the browser-test command.

`dist/` is the complete static site. Relative asset URLs and hash-based invitations work at both `https://name.github.io/` and `https://name.github.io/repository/`. The app deliberately uses no server-rendered framework and requires no application backend for ordinary direct connections.

## Modes and rules used in this version

These are implementation defaults chosen for a fair first version:

- Online and nearby modes are two-player duels. Each chooses four distinct digits, from 0–9. A leading zero is allowed, so **0123** is valid and **0012** is not.
- A bull is a correct digit in its correct position. A cow is a correct digit elsewhere. No digit counts twice.
- Each attempt is simultaneous: both players commit a guess before either guess is exchanged or receives feedback. Each player has a thinking clock that pauses when they lock.
- When someone solves, that paired attempt completes for both players. One solver wins; two solvers tie. No extra unequal turns are allowed.
- A duel can use a rematch tiebreaker or let the lower cumulative thinking time win equal-attempt solves. Rematches require new secrets.
- Tournament mode accepts 3–4 total players and runs a round-robin schedule. Four-player rounds have two simultaneous matches; a host browser coordinates the roster, match routing, and standings. Tournament ties are scored as draws and the table ranks by points, wins, attempts, and time.
- A repeated guess is rejected. There are 5,040 distinct valid codes. Rooms support up to 100 rounds; after that, create another room.

## How online play works (and what “free” means)

GitHub Pages only serves the website's HTML, CSS, and JavaScript. It does not run a game server. PeerJS's public PeerServer performs connection discovery and WebRTC signaling without requiring an account. The two browsers then exchange game state over a reliable, encrypted WebRTC data channel.

The default uses Google's public STUN server and the public PeerJS signaling service. **There is no TURN relay included by default.** Some carrier-grade NATs, corporate networks, firewalls, and combinations of mobile networks cannot establish a direct connection. Trying another Wi-Fi/mobile network may help; dependable operation across those networks requires a TURN relay.

### Nearby offline pairing

Install the app from the HTTPS Pages URL (or open it once while online) so the PWA cache contains the game files. Put both devices on the same Wi‑Fi network or one device's hotspot, choose **Nearby offline**, and exchange the compressed WebRTC offer and answer by QR code. A copy/paste fallback is included for devices without a camera. The pairing bundle contains connection metadata only; game messages then use a direct local encrypted data channel. Guest Wi‑Fi isolation, VPNs, and device firewalls can still prevent a local route.

PeerJS discontinued its free TURN service in December 2023. Do not interpret old documentation claiming free TURN as current. Public signaling/STUN are external shared services and can be blocked, slow, unavailable, or change policy. This project has no uptime or capacity guarantee from them and makes no claim of unlimited free production service.

### Optional TURN relay

Edit `public/connection-config.js`. Keep the existing STUN server and configure a URL you operate that returns short-lived browser-usable ICE credentials:

```js
window.BC_CONNECTION = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  turnCredentialEndpoint: 'https://your-service.example/ice',
};
```

The endpoint must allow CORS from the game's origin and return JSON shaped like:

```json
{
  "iceServers": [{
    "urls": ["turns:your-relay.example:443?transport=tcp"],
    "username": "short-lived-username",
    "credential": "short-lived-credential"
  }]
}
```

The relay credential endpoint and TURN service are optional external infrastructure, not included or deployed by this repository. They need their own access controls/rate limits, and provider free quotas may be limited. Do not embed a private provider API key or a permanent privileged credential in static JavaScript or a Vite environment variable: all client code is public. The app fetches fresh credentials whenever a room session starts or resumes. A long-lived room may need a refresh/resume when its relay credentials expire.

For relay-only verification, temporarily set `iceTransportPolicy: 'relay'` alongside these settings, then restore it after testing. A custom PeerServer can be configured using `peerServer: { host, port: 443, path: '/', secure: true }`.

## Publish free on GitHub Pages

1. Use a **public GitHub repository**. GitHub Free supports Pages for public repositories.
2. Push this project, including `package-lock.json` and `.github/workflows/pages.yml`, to its `main` branch. Do not upload `node_modules`, `work`, or `outputs`.
3. In the repository, open **Settings → Pages → Build and deployment → Source → GitHub Actions**.
4. Run the “Publish game to GitHub Pages” workflow (or push a change). It runs the game-state tests, builds the site, uploads only `dist`, and deploys Pages.
5. Wait for the deployment job to succeed. Open the URL shown in its `github-pages` environment. Create a room on that URL and invite the other phone.
6. Test from two physical phones on **different networks**. If they cannot connect, configure TURN as above and test again.

The included workflow uses standard GitHub Pages actions and a restricted deploy job. A successful build creates `dist`; the PWA service worker caches that static shell for later nearby/offline sessions.

## Recovery, privacy, and fair play

- Both participants should keep the game tab open. Brief interruptions trigger retries; returning to the tab also retries. Paired attempts pause instead of awarding a disconnect win.
- Session state, including **your own secret**, is saved only in that tab's `sessionStorage`. After a refresh, choose **Resume**. Clearing storage, closing the tab, using another device, or leaving the room can lose the session. Browser storage restrictions are reported in the UI.
- A duel room has one host and one guest. A tournament has 3–4 seats and the host remains the coordinator. Once connected, unguessable resume tokens pin seats; other players are refused. The 8-character room code is an invitation, not a user login.
- WebRTC reveals network addresses to the other peer and uses external signaling/STUN services. There is no analytics or application database. Fonts load from Google Fonts with system fallbacks.
- A secret is committed as SHA-256 with a random 128-bit salt; the salt prevents trivially enumerating all four-digit codes. Guesses use fresh salted commitments too. After both guesses lock, only their guesses and feedback are exchanged. The opponent's UI shows progress without displaying their in-progress guesses or secret.
- At the end of a round, both secrets are revealed and checked against the original commitments; every received clue is checked against the revealed secret. An inconsistent transcript pauses the game and cannot count as a verified win.
- This is a friendly peer-to-peer game, not a trusted competitive server. It cannot prevent a modified client from abandoning a losing game, inspecting guesses after they have legitimately been exchanged, or using an external solver. No rankings, money, or anti-cheat guarantee is provided.

## Project layout

- `src/game.js`: deterministic game state, salted commitments, simultaneous turns, replay, verification.
- `src/network.js`: PeerJS signaling, duel/tournament admission, host routing, heartbeat, and snapshot sync.
- `src/nearby.js`: QR-safe compressed WebRTC offer/answer pairing for local offline mode.
- `src/tournament.js`: round-robin schedule, result recording, and standings.
- `src/main.js`, `src/style.css`: responsive interface, forms, QR scanner, clocks, invitations, tournament lobby, and session recovery.
- `tests/game.test.js`, `tests/nearby.test.js`, `tests/tournament.test.js`: scoring, timing commitments, pairing encoding, and tournament invariants.
- `tests/browser.mjs`: browser-driven integration checks against a running preview. See its output for whether real public signaling was available; local browser contexts alone are not cross-device proof.

## Validation completed

- All thirteen game-state and protocol tests passed, including scoring across all 5,040 possible valid codes, timing tie-breakers, nearby bundle encoding, tournament scheduling, restore/replay, and tampered-feedback rejection.
- The production Vite build passed. Lobby layouts were checked at 360, 390, 768, and 1440 pixels, and at 200% text size on a 390-pixel viewport without horizontal overflow. Rules dialog keyboard dismissal passed.
- The complete two-browser flow passed through **public PeerJS signaling and a real WebRTC data channel**: secret setup, guess feedback/history, third-player refusal, guest refresh/resume, a verified tie, a new-secret tiebreaker, win/loss, and leaving.
- A three-browser tournament smoke test passed: roster admission, host start, three-player bye assignment, and simultaneous match assignment.
- **Qualification:** the passing browser suite ran with `--loopback`. This opt-in test harness uses Chromium loopback ICE candidates and a fake media device inside isolated test browsers. It does not mock the game or its data channel. The app itself never requests microphone access. Normal direct ICE on this machine's VPN route stalled after successful public signaling; this default-path failure is preserved in the validation report.
- Two physical devices, different mobile networks, iOS/Safari, a real TURN relay, and a public Pages deployment have **not** been verified. A TURN relay may be necessary for the user's networks.

To repeat the qualified local integration check with the production preview running:

```sh
npm run test:browser -- --loopback
```

Do not use the loopback test result to claim cross-network mobile validation. Run the ordinary browser suite (without `--loopback`) on a working network and, after publishing, test two phones on different networks.

## Primary documentation

- [What GitHub Pages serves](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)
- [GitHub Pages custom workflows and free-plan eligibility](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)
- [PeerJS FAQ: free signaling and NAT restrictions](https://peerjs.com/client/faq)
- [PeerJS connection and ICE configuration API](https://peerjs.com/client/api/peer)
- [PeerJS announcement: free TURN discontinued](https://github.com/orgs/peers/discussions/1172)

Checked during implementation on September 13, 2026. Service terms and quotas can change.
