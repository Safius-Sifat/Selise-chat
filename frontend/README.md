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

```sh
cd frontend
npm install
npm run dev
```

The frontend expects the backend URL to be set in the login form (defaults to `https://selise.notice.fit`).

For complete backend + PocketBase setup instructions, see [../README.md](../README.md).

## Checks

```sh
npm run check
npm run build
```
