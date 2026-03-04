# PocketBase Chat (Backend + Frontend)

This workspace now contains a WhatsApp-like messaging stack:

- Backend API + WebSocket server: `ws-server.ts`
- Frontend app (SvelteKit + Tailwind + daisyUI): `frontend`

## Features

- Email/password sign up + sign in (PocketBase users)
- One-to-one chat between registered users
- Group chat (create, join, leave, member list)
- Group discovery UI
- Typing indicator
- Online presence indicator
- Image upload + optimistic UI
- Sent / delivered / seen status
- Reply to message

## 1) PocketBase setup

Run PocketBase locally (default):

```bash
./pocketbase serve
```

Default URL expected by backend: `http://127.0.0.1:8090`

### Required collections

By default, the backend now auto-bootstraps the required collections/fields at startup.

- Auto-bootstrap env: `POCKETBASE_AUTO_BOOTSTRAP_SCHEMA` (default: `true`)
- Disable with: `POCKETBASE_AUTO_BOOTSTRAP_SCHEMA=false`

If you disable auto-bootstrap, create the following collections manually in PocketBase Admin UI.

#### `conversations` (base)

- `type` (select, required): `direct`, `group`
- `title` (text)
- `isPublic` (bool)
- `createdBy` (relation -> users, max 1)
- `members` (relation -> users, multiple)
- `lastMessageAt` (date)

#### `messages` (base)

- `conversation` (relation -> conversations, max 1, required)
- `sender` (relation -> users, max 1, required)
- `text` (text)
- `image` (file, max 1)
- `replyTo` (relation -> messages, max 1)
- `status` (select): `sent`, `delivered`, `seen`
- `deliveredTo` (json)
- `seenBy` (json)
- `clientTempId` (text)

> `users` is PocketBase built-in auth collection.

## 2) Environment variables (backend)

Set these before running backend:

- `POCKETBASE_URL` (default: `http://127.0.0.1:8090`)
- `POCKETBASE_ADMIN_EMAIL` (required for server-side DB/storage operations)
- `POCKETBASE_ADMIN_PASSWORD` (required)
- `POCKETBASE_AUTO_BOOTSTRAP_SCHEMA` (default: `true`)
- `PORT` or `WS_PORT` (default: `4000`)

## 3) Run

Install deps from root:

```bash
npm install
```

### Backend

```bash
npm run dev:chat
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Open frontend URL from Vite (usually `http://localhost:5173`).

## 4) Build checks

Backend:

```bash
npm run build
```

Frontend:

```bash
cd frontend
npm run check
npm run build
```
