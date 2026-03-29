# Direct Messages (React + Express + Socket.IO)

A minimal direct-messaging app (Instagram-style DMs). Users pick a handle, see who is online, and chat 1:1 in real time. In-memory storage by default with optional MongoDB persistence.

## Quick start

1. Install dependencies:
   - Open a terminal and run:
     - `cd chatapp/server`
     - `npm install`

2. Run the server (serves frontend too):
   - `npm run dev` (reloads on changes) or `npm start`
   - The app is available at http://localhost:4000

3. Test chat:
   - Open the app in two browser windows, choose different usernames, and DM between them in real time.

## Configuration (optional)

- Copy `.env.example` to `.env` and adjust:
  - `PORT=4000`
  - `CLIENT_ORIGIN=http://localhost:4000`
  - `MONGO_URL=mongodb://localhost:27017/chatapp` (if set, messages persist in MongoDB)

## Tech stack
- React (CDN, no build step)
- Socket.IO
- Express.js
- Node.js
- MongoDB (optional; falls back to memory)

## Notes
- Messages are capped per conversation in-memory (latest 100) when MongoDB is not configured.
- Static assets are served from `server/public`.
