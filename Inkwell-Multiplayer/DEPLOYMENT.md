# Inkwell Multiplayer — Render + Vercel deployment

## Architecture

- Vercel: static frontend (`public/`)
- Render: Node.js + Express + Socket.IO multiplayer server
- Dictionary: dictionaryapi.dev called by the Render server
- Active room state: in Render server memory

This is intentionally database-free for a free/hobby deployment. Active rooms disappear if the Render service restarts or spins down. Render's free web services also spin down after 15 minutes without inbound traffic and take about a minute to wake up. They support WebSockets, which is why Render is used for the real-time server.

## 1. GitHub

Create a GitHub repository and put the contents of `inkwell-multiplayer/` in it.

Recommended repository root:

```text
inkwell-multiplayer/
  public/
  server.js
  package.json
  render.yaml
  vercel.json
```

## 2. Render

Create `New -> Web Service` and connect the GitHub repository.

Settings:

- Runtime: Node
- Build Command: `npm install`
- Start Command: `npm start`
- Instance Type: `Free`
- Health Check Path: `/health`

After deployment, test:

```text
https://YOUR-RENDER-SERVICE.onrender.com/health
```

You should receive JSON with `ok: true`.

## 3. Configure the frontend

Edit `public/config.js`:

```js
window.INKWELL_SERVER_URL = 'https://YOUR-RENDER-SERVICE.onrender.com';
```

Commit and push.

## 4. Vercel

Import the same GitHub repository.

If `inkwell-multiplayer` is the repository root:

- Framework Preset: Other
- Root Directory: `public`
- Build Command: empty
- Output Directory: `.`

If `inkwell-multiplayer` is a subfolder in a larger repository, set the root directory to `inkwell-multiplayer/public`.

Deploy.

## 5. Test multiplayer

Open the Vercel URL on a laptop and two phones.

1. Create a room on device A.
2. Scan the QR code or copy the invite link.
3. Join on devices B and C.
4. Start the match on the host.
5. Submit words from the correct device.

## Free-tier behavior

This design is suitable for demos, college projects, testing, and small friend groups. It is not intended to be production-critical on free hosting.

Important: the game state is stored in server memory. A Render restart/spin-down clears active rooms. Players can create a new room after reconnecting.
