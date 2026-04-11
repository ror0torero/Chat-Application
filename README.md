# Direct Messages Platform

Production-style real-time chat platform built with Node.js, Express, Socket.IO, and a React single-page client.

It supports private DMs, private groups with role-based membership, admin governance, media messaging, audit trails, and a hardened security layer.

## What Is Included

### Core Messaging
- Username/password login over Socket.IO
- 1:1 direct messaging
- Private group chats (membership required)
- Group creation, join, and leave
- Message history for DMs and groups
- Real-time typing indicators for DMs and groups
- Media attachments: image, video, audio, plus voice notes

### Collaboration and Control
- Group roles: owner, admin, member
- Group member management: promote/demote/remove
- Owner leave guard (owner cannot leave own group)
- Discoverable group list (groups not yet joined)

### Admin Features
- Super admin account bootstrap (`admin` with password from env or default)
- User management (add/update/remove)
- Live audit feed + historical audit snapshot
- Audit actions include admin login, user updates/removals, group operations

### Security Layer
- Password hashing with PBKDF2 + salt + timing-safe verification
- Strict username/group normalization and sanitization
- Text sanitization for chat payloads
- Media format validation and max payload enforcement
- HTTP security headers with `helmet`
- API-level request throttling with `express-rate-limit`
- Socket-level login and message rate limiting (sliding window)
- Request tracing via `X-Request-Id`
- Configurable trust proxy mode for reverse-proxy deployments
- Admin user listing no longer exposes password hashes

### UX and UI Improvements
- Responsive 3-panel dark interface with mobile breakpoints
- Sticky composer and safe scroll behavior
- Sidebar search for users/groups
- Quick-join chips for discoverable groups
- Connection health signal (connected/reconnecting)
- Typing status shown in conversation header
- Message timestamps in conversation stream
- Error banners auto-clear for cleaner UX

## Architecture

### Backend
- `server/index.js`
- Express serves API + static frontend
- Socket.IO handles all real-time app events
- `ChatStore` abstracts persistence and supports:
  - MongoDB persistence mode (if `MONGO_URL` set)
  - In-memory fallback mode

### Frontend
- `server/public/index.html`
- React 18 (UMD + Babel, no build pipeline)
- Socket-driven state for auth, presence, messages, groups, admin views

## Tech Stack and Libraries

### Runtime
- Node.js
- Express
- Socket.IO
- MongoDB + Mongoose (optional persistence)

### Security and Performance
- `helmet` for HTTP hardening
- `express-rate-limit` for API request throttling
- `compression` for payload compression
- Native `crypto` for PBKDF2 password hashing

### Frontend
- React 18 UMD
- ReactDOM 18 UMD
- Babel Standalone

## Project Structure

- `server/index.js`: backend server, socket handlers, store, security middleware
- `server/public/index.html`: full client UI and React logic
- `server/package.json`: server dependencies and scripts
- `GUIDE.md`: line-by-line project guide

## Setup

1. Install dependencies
   - `cd server`
   - `npm install`

2. Start server
   - Development: `npm run dev`
   - Production-like: `npm start`

3. Open app
   - `http://localhost:4000`

## Configuration

Use environment variables in `server/.env`.

### Required/Typical
- `PORT` (default `4000`)
- `CLIENT_ORIGIN` (default `http://localhost:${PORT}`)
- `MONGO_URL` (optional; if absent, app runs in memory)

### Security/Operational
- `ADMIN_PASSWORD` (recommended to override default)
- `TRUST_PROXY` (`true` when behind reverse proxy)
- `MESSAGE_MAX_CHARS` (default `2000`)
- `LOGIN_WINDOW_MS` (default `600000`)
- `LOGIN_ATTEMPTS` (default `8`)
- `SEND_WINDOW_MS` (default `10000`)
- `SEND_ATTEMPTS` (default `24`)

## API / Health

- `GET /api/health`
- Returns:
  - platform status
  - storage mode (`mongodb` or `memory`)
  - auth mode
  - default group
  - admin user
  - active security capabilities

## Persistence Model

### MongoDB Mode
- Persists users, group metadata, DM messages, group messages, and audit logs

### Memory Mode
- Keeps all data in process memory
- Data resets on server restart
- Buffers are capped to avoid unbounded growth

## Optimization Notes

- Compressed HTTP responses reduce payload size
- In-memory buffer caps prevent runaway memory use
- Rate limiting protects CPU and database from abuse bursts
- Event payload normalization reduces malformed message handling overhead
- Presence and group list updates are incremental and socket-driven

## Security Notes

- Default admin password should be replaced immediately via `ADMIN_PASSWORD`
- Admin account is bootstrap-created only when absent; it is not reset every startup
- Password hashes are never returned in admin UI responses
- Media validation enforces data URL format + payload size limits

## Known Constraints

- Frontend runs without bundling (intentional for simplicity)
- No JWT/session token layer yet (socket identity is per connection auth event)
- Group owner transfer workflow is not implemented

## Next Recommended Upgrades

1. Add explicit socket session tokens with refresh/rotation
2. Add per-room moderation policies (mute/ban/slow mode)
3. Add end-to-end encrypted payload mode for high-security rooms
4. Add CI pipeline with lint/test/security scans
