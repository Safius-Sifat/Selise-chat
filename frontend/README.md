# PocketBase Chat Frontend

SvelteKit frontend for the PocketBase-backed chat server in `../ws-server.ts`.

## Stack

- SvelteKit
- Tailwind CSS v4
- daisyUI

## Features

- Email/password auth flow (sign up + sign in)
- Conversation sidebar like WhatsApp (direct + group)
- One-to-one chat with registered users
- Group discovery and join/leave
- Group creation UI
- Typing indicator + online presence
- Sent/delivered/seen message status
- Reply to message
- Image upload with optimistic message UI
- Chat tones (join, receive, and `fah` easter egg)

## Run

Create local env from template:

```sh
cp .env.example .env
```

Set the backend URL in `.env`:

```sh
PUBLIC_API_BASE_URL=https://selise.notice.fit
```

```sh
cd frontend
npm install
npm run dev
```

The frontend uses `PUBLIC_API_BASE_URL` from env (no backend URL input in the auth UI).

For complete backend + PocketBase setup instructions, see [../README.md](../README.md).

## Checks

```sh
npm run check
npm run build
```
