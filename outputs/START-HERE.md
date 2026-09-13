# Your Bulls & Cows game

The first version includes one-versus-one rooms, invite links and room codes, private secret setup, simultaneous guesses, bull/cow feedback, guess history, tied-round replays with new secrets, rematches, and refresh recovery.

## Preview

Open [the local production preview](http://127.0.0.1:5188/) on this Mac while its preview server is running. This is not a public internet address and cannot be shared with a remote friend.

## Files

- **bulls-and-cows-source.zip** — complete editable project, tests, lockfile, and GitHub Pages deployment workflow.
- **bulls-and-cows-static.zip** — built static website, ready for HTTPS static hosting.
- **Setup-and-deployment.md** — setup, rules, GitHub Pages steps, optional TURN setup, and validation details.
- **bulls-and-cows-desktop.png / bulls-and-cows-mobile.png** — finished lobby screenshots.
- **bulls-and-cows-game-desktop.png / bulls-and-cows-game-mobile.png** — actual in-game screenshots from browser integration testing.

## What passed

Seven game-state tests, including all 5,040 valid codes, and the production build passed. Responsive lobby checks passed at 360, 390, 768, and 1440 pixels, plus 200% text enlargement at 390 pixels.

A full duel passed in independent browsers using public PeerJS signaling and a real WebRTC data channel: joining, guessing, rejecting a third player, refresh/resume, a tie, its tiebreaker, a winner/loser, and leaving.

**Important test limitation:** this Mac's default direct network route could not establish the data channel. The passing integration test explicitly enabled a local loopback route inside test browsers. It did not mock the game or data channel. The app never asks players for microphone access; a fake media device was used only by the test harness to expose the local route. Two physical phones, different mobile networks, Safari, and TURN have not been verified.

## What remains

Choose a public GitHub repository and use its Pages / GitHub Actions settings, following the supplied guide. No repository or site has been published yet.

PeerJS offers free signaling without player accounts. Restrictive networks may need a separately configured TURN relay; free TURN is not included. After publishing, test the invite on two phones on different networks before relying on it.
