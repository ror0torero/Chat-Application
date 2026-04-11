# Project Guide (Line-by-Line Walkthrough)

This guide explains every authored file in this repo. Generated files (e.g., `server/package-lock.json`) are machine-produced dependency locks and not meant for manual editing; they aren’t described line-by-line.

## Root

### README.md
- Introduces the Direct Messages app, stack, quick start, optional config, and notes.

### .gitignore
- Excludes dependency folders, build outputs, logs, temp files, OS/editor junk, cache/coverage.

### nfsnfj.html
- Standalone static showcase mock (not used by the running app). Defines a dark gradient UI preview with sidebar, chat mock, cards, and CTA styles. It contains only HTML/CSS—no JS logic.

### GUIDE.md
- This document.

## server/

### .env.example
- `PORT` server port.
- `CLIENT_ORIGIN` allowed origin for CORS/Socket.IO.
- `MONGO_URL` optional Mongo connection string.

### package.json
- `name`/`version`/`description`: metadata.
- `main`: entry file (`index.js`).
- `type`: `module` to enable ES modules.
- `scripts`: `start` (node), `dev` (nodemon reload).
- `dependencies`: runtime libs (cors, dotenv, express, mongoose, socket.io).
- `devDependencies`: nodemon for hot-reload.

### index.js
- Imports Node/3rd-party modules (`path`, `fileURLToPath`, `http`, `express`, `cors`, `dotenv`, `mongoose`, `crypto`, `socket.io`).
- Loads environment variables with `dotenv.config()`.
- Derives `__filename`/`__dirname` for ES modules.
- Reads env (`PORT`, `CLIENT_ORIGIN`, `MONGO_URL`) with defaults.
- `normalizeName`: trims, strips invalid chars, limits length, returns null if empty.
- Defines `DMStore` class:
  - ctor: flags for DB use, Mongoose model holder, in-memory buffers map, media size limit.
  - `keyFor`: creates sorted conversation key.
  - `init`: connects to Mongo if URL present; defines schema/model; falls back to memory on failure.
  - `validateMedia`: ensures media exists and size below limit (text bypasses).
  - `add`: saves message to Mongo (with convoKey) if available; otherwise in-memory with UUID; caps in-memory history to last 100.
  - `list`: fetches messages by convoKey from Mongo (sorted asc) or from memory copy.
- Instantiates store and awaits optional Mongo init.
- Creates Express app; sets CORS (origin from env), JSON parser, and static serving of `public` folder.
- Health endpoint `/api/health` returns status and storage mode.
- Creates HTTP server and Socket.IO with matching CORS origin.
- `online` map tracks username -> Set of socket IDs.
- `broadcastPresence` emits `presence:update` with online usernames.
- Socket.IO handlers:
  - On `connection`, track `username` variable.
  - `auth:login`: normalize name; join per-user room; mark online; emit `auth:ok`; broadcast presence and send presence list back.
  - `presence:list`: emit current presence to requester.
  - `dm:history`: validate logged-in and partner; fetch history via store; emit `dm:history` with messages.
  - `dm:send`: validate logged-in; normalize target; sanitize kind/text/media; validate media size; persist via store; emit `dm:message` to sender and recipient rooms.
  - `disconnect`: remove socket from online set; drop user if last socket; broadcast presence.
- Catch-all GET `*` serves `public/index.html` for client routing.
- Starts server listening on `PORT` and logs URL.

## server/public/

### index.html
- HTML shell with root div and imports for Socket.IO client, React/ReactDOM (CDN), Babel (for JSX in-browser).
- CSS: defines theme variables, layout grid (aside list, chat, info panel), login overlay, buttons, chips, banners, and media styling for the ninja-themed UI.
- JS (Babel JSX):
  - `isValidName`: sanitize usernames.
  - `useSocket` hook: manages `username`, `users`, `messages`; sets up Socket.IO listeners for auth, presence, message, history; exposes `login`, `requestPresence`, `requestHistory`, `send`.
  - `Login` component: overlay prompt for username with validation and submit/Enter handling.
  - `UserList`: shows other online users with avatars, presence dot, last-message preview, selection handler.
  - `ChatWindow`: handles text input, file uploads (image/video/audio via FileReader -> data URL), voice notes via MediaRecorder, auto-scroll, and renders message bubbles with inline media.
  - `AsideRight`: info panel with user metadata and quick help tips.
  - `App`: wires everything—auto-refresh presence on interval, auto-selects first other user, shows login overlay until signed in, composes layout.
  - Renders `App` into `#root`.

## Root static mock

### nfsnfj.html (detailed structure)
- `<head>`: loads Manrope font, defines gradients/colors/shadows.
- `<body>`: container `.shell` with heading, subhead, CTA buttons, mock UI frame.
- `.mock` includes a faux window chrome and a `.frame` grid with sidebar, chat panel, and settings/info cards, all styled with CSS-only components (chips, stats, toggles). No JS logic.

## Generated files
- `server/package-lock.json`: npm lockfile pinning exact dependency versions and integrity hashes; auto-managed by npm.

## Key behaviors (functional summary)
- Real-time DM via Socket.IO per-user rooms; presence tracking; history fetch; text and media (image/video/audio/voice notes) with size guard; optional Mongo persistence; static frontend served by Express.
