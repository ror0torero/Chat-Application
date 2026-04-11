# Direct Messages (React + Express + Socket.IO)

A direct + group chat app with a dark UI theme, real-time messaging, and username/password sign-in.

Features:
- Username + password authentication (first sign-in auto-registers a new username)
- 1:1 direct messages
- Private group chat rooms with membership (join/create by group name)
- Media messages (image/video/audio)
- Message history retrieval for DMs and groups
- Persistence with MongoDB when configured; memory fallback otherwise
- Group member list with role controls (owner/admin/member)
- Super-admin account for user management (`admin` / `admin123`)
- Admin audit log (user updates/removals, group role/member changes, admin login)

## Quick start

1. Install dependencies:
   - `cd chatapp/server`
   - `npm install`

2. Run the server (serves frontend too):
   - `npm run dev` (reloads on changes) or `npm start`
   - App at http://localhost:4000

3. Test chat:
   - Open two browser windows, sign in with different usernames/passwords, and DM or join group chat.
   - Log in as admin (`admin` / `admin123`) to view/add/remove registered users.

## Configuration (optional)

- Copy `.env.example` to `.env` and adjust:
  - `PORT=4000`
  - `CLIENT_ORIGIN=http://localhost:4000`
   - `MONGO_URL=mongodb://localhost:27017/chatapp`

When `MONGO_URL` is set:
- User accounts are persisted (username + password hash)
- DM history is persisted
- Group rooms, memberships/roles, and group chat history are persisted

When `MONGO_URL` is not set:
- Data is kept in memory only (cleared on server restart)

## Tech stack
- React (CDN, no build step)
- Socket.IO
- Express.js
- Node.js
- MongoDB (optional; falls back to memory)

## Notes
- Messages are capped in memory when MongoDB is not configured.
- Static assets are served from `server/public`.
- Admin user table shows stored password hashes, not plaintext passwords.
