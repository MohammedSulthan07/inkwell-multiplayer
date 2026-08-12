# Inkwell Multiplayer

A browser-based multiplayer version of **Inkwell — The Word Duel**.

## Stack

- Frontend: HTML/CSS/JavaScript
- Hosting: Vercel
- Multiplayer backend: Node.js + Express + Socket.IO on Render
- Word validation: dictionaryapi.dev
- QR invitations: QRCode.js

## Features

- Cross-device rooms
- Room codes and QR invites
- Lobby with host controls
- Individuals and teams
- Shared turn state
- Server-authoritative scoring
- 20-second (configurable) turn timer
- Configurable match duration
- Dictionary checking on the server
- Timeout scoring
- Live scoreboard
- Reconnection-aware player presence
- Mobile responsive UI
- Multiple themes

## Run locally

```bash
npm install
npm start
```

Serve the `public` folder with any static server, for example:

```bash
npx serve public -l 5173
```

Set `public/config.js` to:

```js
window.INKWELL_SERVER_URL = 'http://localhost:10000';
```

Then open `http://localhost:5173`.

## Deployment

See `DEPLOYMENT.md`.
