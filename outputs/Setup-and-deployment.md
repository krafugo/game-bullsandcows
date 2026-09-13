# Bulls & Cows

A responsive browser game with online duels, nearby offline pairing, and 3–4 player tournaments. Static frontend, browser-to-browser multiplayer, no player account or application database required.

## Run the game

Use Node 22.12 or newer:

```sh
npm ci
npm run dev
```

Open http://127.0.0.1:5187. Choose a mode in the lobby. Online duels use a link/code; nearby rooms use QR offer/answer exchange on the same Wi‑Fi or hotspot; tournaments accept 3–4 players.

```sh
npm test
npm run build
npm run preview
```

The production preview is http://127.0.0.1:5188/. The development server uses port 5187; both fail rather than silently switching ports. `npm run test:browser` targets the production preview by default. Install Playwright's test browser with `npx playwright install chromium` when needed, or pass `-- --executable /absolute/path/to/chromium` to the browser-test command.

`dist/` is the complete static site. Relative asset URLs and hash-based invitations work at both `https://name.github.io/` and `https://name.github.io/repository/`. The generated PWA service worker caches the app shell for nearby/offline launches.

## Rules used in this version

These are implementation defaults chosen for a fair first version:

- Online and nearby modes are two-player duels. Tournament mode accepts 3–4 players and runs round-robin pairings.
- A bull is a correct digit in its correct position. A cow is a correct digit elsewhere. No digit counts twice.
- Each attempt is simultaneous: both players commit a guess before either guess is exchanged or receives feedback. Each player has a thinking clock that pauses when they lock.
- When someone solves, that paired attempt completes for both players. One solver wins; two solvers tie. No extra unequal turns are allowed.
- Duels can rematch on a tie or award equal-attempt solves to the lower cumulative thinking time. Tournament ties count as draws for standings.
- A repeated guess is rejected. There are 5,040 distinct valid codes. Rooms support up to 100 rounds; after that, create another room.

## How online play works (and what “free” means)

GitHub Pages only serves the website's HTML, CSS, and JavaScript. It does not run a game server. PeerJS's public PeerServer performs connection discovery and WebRTC signaling without requiring an account. The two browsers then exchange game state over a reliable, encrypted WebRTC data channel.

The default uses Google's public STUN server and the public PeerJS signaling service. **There is no TURN relay included by default.** Some carrier-grade NATs, corporate networks, firewalls, and combinations of mobile networks cannot establish a direct connection. Trying another Wi-Fi/mobile network may help; dependable operation across those networks requires a TURN relay.

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

1. Create or choose a **public GitHub repository** for this new project. GitHub Free supports Pages for public repositories. This build has not chosen a repository, created one, or published anything on your behalf.
2. Push this project, including `package-lock.json` and `.github/workflows/pages.yml`, to its `main` branch. Do not upload `node_modules`, `work`, or `outputs`.
3. In the repository, open **Settings → Pages → Build and deployment → Source → GitHub Actions**.
4. Run the “Publish game to GitHub Pages” workflow (or push a change). It runs the game-state tests, builds the site, uploads only `dist`, and deploys Pages.
5. Wait for the deployment job to succeed. Open the URL shown in its `github-pages` environment. Create a room on that URL and invite the other phone.
6. Test from two physical phones on **different networks**. If they cannot connect, configure TURN as above and test again.

The included workflow uses standard GitHub Pages actions and a restricted deploy job. Actual publishing requires a repository/account choice and authorization. No live hosted URL exists just because `npm run build` succeeds.

## Recovery, privacy, and fair play

- Both participants should keep the game tab open. Brief interruptions trigger retries; returning to the tab also retries. Paired attempts pause instead of awarding a disconnect win.
- Session state, including **your own secret**, is saved only in that tab's `sessionStorage`. After a refresh, choose **Resume**. Clearing storage, closing the tab, using another device, or leaving the room can lose the session. Browser storage restrictions are reported in the UI.
- A room has one host and one guest. Once connected, an unguessable resume token pins the original guest seat; other players are refused. The 8-character room code is an invitation, not a user login. Share it only with your intended friend.
- WebRTC reveals network addresses to the other peer and uses external signaling/STUN services. There is no analytics or application database. Fonts load from Google Fonts with system fallbacks.
- A secret is committed as SHA-256 with a random 128-bit salt; the salt prevents trivially enumerating all four-digit codes. Guesses use fresh salted commitments too. After both guesses lock, only their guesses and feedback are exchanged. The opponent's UI shows progress without displaying their in-progress guesses or secret.
- At the end of a round, both secrets are revealed and checked against the original commitments; every received clue is checked against the revealed secret. An inconsistent transcript pauses the game and cannot count as a verified win.
- This is a friendly peer-to-peer game, not a trusted competitive server. It cannot prevent a modified client from abandoning a losing game, inspecting guesses after they have legitimately been exchanged, or using an external solver. No rankings, money, or anti-cheat guarantee is provided.

## Project layout

- `src/game.js`: deterministic game state, salted commitments, simultaneous turns, replay, verification.
- `src/network.js`: PeerJS signaling, two-person room admission, heartbeat, reconnection, snapshot sync.
- `src/main.js`, `src/style.css`: responsive interface, forms, dialogs, invitations, and session recovery.
- `tests/game.test.js`: scoring, all valid codes, fairness, ties, recovery, invalid/tampered state.
- `tests/browser.mjs`: browser-driven integration checks against a running preview. See its output for whether real public signaling was available; local browser contexts alone are not cross-device proof.

## Validation completed

- All seven game-state tests passed, including scoring across all 5,040 possible valid codes, equal attempts, withholding guesses, tied rounds, new-secret enforcement, restore/replay, and tampered-feedback rejection.
- The production Vite build passed. Lobby layouts were checked at 360, 390, 768, and 1440 pixels, and at 200% text size on a 390-pixel viewport without horizontal overflow. Rules dialog keyboard dismissal passed.
- The complete two-browser flow passed through **public PeerJS signaling and a real WebRTC data channel**: secret setup, guess feedback/history, third-player refusal, guest refresh/resume, a verified tie, a new-secret tiebreaker, win/loss, and leaving.
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
