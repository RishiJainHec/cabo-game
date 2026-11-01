# CABO — multiplayer browser card game

```
npm install
npm start
```

Open http://localhost:3000, host a game, and share the room code or invite link.
Friends on the same Wi-Fi join via the "Same Wi-Fi" address printed in the terminal.
For friends elsewhere, expose port 3000 with a tunnel (e.g. `cloudflared tunnel --url http://localhost:3000`)
or deploy the folder to any Node host.

- `engine.js` — server-authoritative rules engine (deck, turns, powers, matching modes, penalties, CABO, scoring)
- `server.js` — HTTP + WebSocket server, rooms/lobby, reconnection, per-player filtered views
- `rooms.js` — rooms, lobby and message handling (shared by the server and the offline build)
- `bot.js` — bots the host can add from the lobby, with Easy / Medium / Hard levels
- `public/` — the client (renders the server's view; never receives hidden card values)
- `npm test` — engine acceptance tests
- `node build-offline.js` — writes `cabo-offline.html`: the whole game in one file that plays
  you-vs-3-bots in any browser with no server (handy to send to people; multiplayer still needs the server)
