# Group Chat Frontend (SvelteKit + Tailwind + daisyUI)

This app is a chat UI for the backend in `../ws-server.ts` with separate tabs for public and private chat.

## Stack

- SvelteKit
- Tailwind CSS v4
- daisyUI

## Run locally

From the project root (`node-server`), start backend and frontend in separate terminals:

```sh
# terminal 1 (websocket backend)
npm run dev:ws

# terminal 2 (svelte frontend)
cd frontend
npm run dev
```

Open the frontend URL shown by Vite (usually `http://localhost:5173`).

## Usage

1. Keep **Secure WebSocket Server** as `wss://selise.notice.fit` (SSL)
2. Enter your **name**
3. Choose a header tab:
	- **Public**: everyone in public channel receives messages
	- **Private**: room-based messages only for that group
4. In **Private** tab, enter a **group name** and click **Join Room**
5. Send messages in the chat composer

Private room messages are isolated to that room only.

## Features

- Public channel chat tab
- Private room chat tab
- Join/switch private rooms at runtime
- Online member list for private rooms
- System events for join/leave
- Chat bubbles with sender/time display

## Quality checks

```sh
npm run check
npm run build
```
