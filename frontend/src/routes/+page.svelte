<script lang="ts">
    import { onDestroy, onMount, tick } from "svelte";

    type ChatTab = "public" | "private";
    type ChatMessageKind = "chat" | "system";

    interface ChatMessage {
        id: string;
        kind: ChatMessageKind;
        from: string;
        text: string;
        group: string;
        at: string;
        mine: boolean;
    }

    type GroupServerEvent = {
        type: string;
        mode?: string;
        clientId?: string;
        from?: string;
        group?: string;
        message?: string;
        members?: string[];
        at?: string;
        note?: string;
    };

    const DEFAULT_WS_BASE_URL = "wss://selise.notice.fit";

    let activeTab: ChatTab = "public";
    let wsBaseUrl = DEFAULT_WS_BASE_URL;
    let nickname = `user-${Math.random().toString(36).slice(2, 6)}`;
    let roomInput = "default";
    let activeRoom = "public";
    let currentClientId = "";
    let members: string[] = [];
    let messageInput = "";
    let status: "disconnected" | "connecting" | "connected" = "disconnected";
    let statusLabel = "Disconnected";
    let socket: WebSocket | null = null;
    let messages: ChatMessage[] = [];
    let messageContainer: HTMLDivElement | null = null;
    let discordJoinTone: HTMLAudioElement | null = null;
    let fahTone: HTMLAudioElement | null = null;
    let messengerReceivedTone: HTMLAudioElement | null = null;

    const playTone = (tone: HTMLAudioElement | null): void => {
        if (!tone) {
            return;
        }

        tone.currentTime = 0;
        void tone.play().catch(() => {
            // Ignore autoplay and playback rejections silently.
        });
    };

    const activeChannelLabel = (): string => {
        if (activeTab === "public") {
            return "public";
        }

        return activeRoom || roomInput || "default";
    };

    const buildSocketUrl = (): string => {
        const base = wsBaseUrl.trim() || DEFAULT_WS_BASE_URL;
        const normalizedBase = base.endsWith("/") ? base : `${base}/`;
        const targetNickname =
            nickname.trim() || `user-${Math.random().toString(36).slice(2, 6)}`;
        const path = activeTab === "public" ? "ws/broadcast" : "ws/group";
        const url = new URL(path, normalizedBase);

        url.searchParams.set("clientId", targetNickname);

        if (activeTab === "private") {
            const targetRoom = roomInput.trim() || "default";
            url.searchParams.set("group", targetRoom);
        }

        return url.toString();
    };

    const formatTime = (value: string): string => {
        if (!value) {
            return "";
        }

        return new Date(value).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
        });
    };

    const scrollMessagesToBottom = async (): Promise<void> => {
        await tick();

        if (messageContainer) {
            messageContainer.scrollTop = messageContainer.scrollHeight;
        }
    };

    const addSystemMessage = async (
        text: string,
        group?: string,
    ): Promise<void> => {
        messages = [
            ...messages,
            {
                id: crypto.randomUUID(),
                kind: "system",
                from: "system",
                text,
                group: group ?? activeChannelLabel(),
                at: new Date().toISOString(),
                mine: false,
            },
        ];

        await scrollMessagesToBottom();
    };

    const addChatMessage = async (
        payload: Required<
            Pick<ChatMessage, "from" | "text" | "group" | "at" | "mine">
        >,
    ): Promise<void> => {
        messages = [
            ...messages,
            {
                id: crypto.randomUUID(),
                kind: "chat",
                from: payload.from,
                text: payload.text,
                group: payload.group,
                at: payload.at,
                mine: payload.mine,
            },
        ];

        await scrollMessagesToBottom();
    };

    const resetViewForTab = (): void => {
        messages = [];
        members = [];
        messageInput = "";
        currentClientId = "";
        activeRoom = activeTab === "public" ? "public" : "";
    };

    const disconnect = (): void => {
        if (
            socket &&
            (socket.readyState === WebSocket.OPEN ||
                socket.readyState === WebSocket.CONNECTING)
        ) {
            socket.close(1000, "Leaving chat");
        }

        socket = null;
        status = "disconnected";
        statusLabel = "Disconnected";
        members = [];
    };

    const connect = (): void => {
        disconnect();

        status = "connecting";
        statusLabel = "Connecting...";
        const ws = new WebSocket(buildSocketUrl());
        socket = ws;

        ws.addEventListener("open", () => {
            status = "connected";
            statusLabel = "Connected";

            if (activeTab === "public") {
                activeRoom = "public";
            }
        });

        ws.addEventListener("message", async (event) => {
            const raw =
                typeof event.data === "string"
                    ? event.data
                    : String(event.data);
            let payload: GroupServerEvent;

            try {
                payload = JSON.parse(raw) as GroupServerEvent;
            } catch {
                await addSystemMessage(raw, activeRoom);
                return;
            }

            if (payload.type === "connected") {
                if (typeof payload.clientId === "string") {
                    currentClientId = payload.clientId;
                    nickname = payload.clientId;
                }

                if (
                    activeTab === "private" &&
                    typeof payload.group === "string"
                ) {
                    activeRoom = payload.group;
                    roomInput = payload.group;
                } else if (activeTab === "public") {
                    activeRoom = "public";
                }

                if (activeTab === "private" && Array.isArray(payload.members)) {
                    members = payload.members;
                }

                await addSystemMessage(
                    activeTab === "private"
                        ? `You joined #${activeRoom || roomInput || "default"}`
                        : "You joined #public",
                    activeRoom,
                );
                playTone(discordJoinTone);

                if (payload.note) {
                    await addSystemMessage(payload.note, activeRoom);
                }

                return;
            }

            if (activeTab === "private" && payload.type === "joined") {
                if (typeof payload.group === "string") {
                    activeRoom = payload.group;
                    roomInput = payload.group;
                }

                if (Array.isArray(payload.members)) {
                    members = payload.members;
                }

                await addSystemMessage(
                    `You switched to #${activeRoom || roomInput || "default"}`,
                    activeRoom,
                );
                playTone(discordJoinTone);
                return;
            }

            if (activeTab === "private" && payload.type === "members-update") {
                if (Array.isArray(payload.members)) {
                    members = payload.members;
                }
                return;
            }

            if (
                activeTab === "private" &&
                payload.type === "system" &&
                typeof payload.message === "string"
            ) {
                await addSystemMessage(
                    payload.message,
                    payload.group ?? activeRoom,
                );

                if (payload.message.includes(" joined #")) {
                    playTone(discordJoinTone);
                }

                return;
            }

            if (
                activeTab === "private" &&
                payload.type === "group-broadcast" &&
                typeof payload.message === "string"
            ) {
                const from =
                    typeof payload.from === "string" ? payload.from : "unknown";
                const mine = from === currentClientId;
                await addChatMessage({
                    from,
                    text: payload.message,
                    group: payload.group ?? activeRoom,
                    at: payload.at ?? new Date().toISOString(),
                    mine,
                });

                if (!mine) {
                    playTone(messengerReceivedTone);
                }

                return;
            }

            if (
                activeTab === "public" &&
                payload.type === "broadcast" &&
                typeof payload.message === "string"
            ) {
                const from =
                    typeof payload.from === "string" ? payload.from : "unknown";
                const mine = from === currentClientId;
                await addChatMessage({
                    from,
                    text: payload.message,
                    group: "public",
                    at: payload.at ?? new Date().toISOString(),
                    mine,
                });

                if (!mine) {
                    playTone(messengerReceivedTone);
                }

                return;
            }

            await addSystemMessage(raw, payload.group ?? activeRoom);
        });

        ws.addEventListener("close", () => {
            status = "disconnected";
            statusLabel = "Disconnected";
            members = [];

            if (socket === ws) {
                socket = null;
            }
        });

        ws.addEventListener("error", async () => {
            statusLabel = "Connection error";
            await addSystemMessage(
                "Could not connect to WebSocket server",
                activeChannelLabel(),
            );
        });
    };

    const sendChatMessage = (): void => {
        if (!socket || socket.readyState !== WebSocket.OPEN) {
            return;
        }

        const text = messageInput.trim();

        if (!text) {
            return;
        }

        if (text.toLowerCase() === "fah") {
            playTone(fahTone);
        }

        socket.send(JSON.stringify({ message: text }));
        messageInput = "";
    };

    const joinOrSwitchRoom = (): void => {
        if (activeTab === "public") {
            connect();
            return;
        }

        const targetRoom = roomInput.trim() || "default";

        if (!socket || socket.readyState !== WebSocket.OPEN) {
            connect();
            return;
        }

        socket.send(JSON.stringify({ type: "join", group: targetRoom }));
    };

    const switchTab = (tab: ChatTab): void => {
        if (tab === activeTab) {
            return;
        }

        disconnect();
        activeTab = tab;
        resetViewForTab();
    };

    onMount(() => {
        discordJoinTone = new Audio("/discord-join.mp3");
        discordJoinTone.preload = "auto";

        fahTone = new Audio("/fah.mp3");
        fahTone.preload = "auto";

        messengerReceivedTone = new Audio("/messenger-chat.mp3");
        messengerReceivedTone.preload = "auto";
    });

    onDestroy(() => {
        disconnect();
        discordJoinTone = null;
        fahTone = null;
        messengerReceivedTone = null;
    });
</script>

<main class="min-h-screen bg-base-200 p-3 md:p-6">
    <div class="mx-auto flex max-w-6xl flex-col gap-4">
        <div
            class="navbar rounded-box border border-base-300 bg-base-100 px-4 shadow-sm"
        >
            <div class="flex-1">
                <h1 class="text-lg font-semibold md:text-xl">Chat Hub</h1>
                <p class="text-xs text-base-content/60">
                    Secure domain: selise.notice.fit (SSL)
                </p>
            </div>
            <div class="hidden md:block">
                <div role="tablist" class="tabs tabs-box bg-base-200 p-1">
                    <button
                        role="tab"
                        class={`tab ${activeTab === "public" ? "tab-active" : ""}`}
                        on:click={() => switchTab("public")}
                    >
                        Public
                    </button>
                    <button
                        role="tab"
                        class={`tab ${activeTab === "private" ? "tab-active" : ""}`}
                        on:click={() => switchTab("private")}
                    >
                        Private
                    </button>
                </div>
            </div>
            <div class="flex items-center gap-2">
                <span class="badge badge-outline"
                    >Channel: {activeChannelLabel()}</span
                >
                <span
                    class={`badge ${status === "connected" ? "badge-success" : status === "connecting" ? "badge-warning" : "badge-ghost"}`}
                >
                    {statusLabel}
                </span>
            </div>
        </div>

        <div class="md:hidden">
            <div role="tablist" class="tabs tabs-box bg-base-100 p-1">
                <button
                    role="tab"
                    class={`tab ${activeTab === "public" ? "tab-active" : ""}`}
                    on:click={() => switchTab("public")}
                >
                    Public
                </button>
                <button
                    role="tab"
                    class={`tab ${activeTab === "private" ? "tab-active" : ""}`}
                    on:click={() => switchTab("private")}
                >
                    Private
                </button>
            </div>
        </div>

        <div class="grid min-h-[80vh] gap-4 lg:grid-cols-[320px_1fr]">
            <aside class="card border border-base-300 bg-base-100 shadow-sm">
                <div class="card-body gap-4">
                    <h2 class="card-title text-base">
                        {activeTab === "public"
                            ? "Public Channel"
                            : "Private Room"}
                    </h2>

                    <label class="form-control w-full gap-1">
                        <span class="label-text text-sm"
                            >Secure WebSocket Server</span
                        >
                        <input
                            class="input input-bordered w-full"
                            bind:value={wsBaseUrl}
                            placeholder="wss://selise.notice.fit"
                        />
                    </label>

                    <label class="form-control w-full gap-1">
                        <span class="label-text text-sm">Your Name</span>
                        <input
                            class="input input-bordered w-full"
                            bind:value={nickname}
                            placeholder="safiu"
                        />
                    </label>

                    {#if activeTab === "private"}
                        <label class="form-control w-full gap-1">
                            <span class="label-text text-sm">Group Name</span>
                            <input
                                class="input input-bordered w-full"
                                bind:value={roomInput}
                                placeholder="general"
                            />
                        </label>
                    {:else}
                        <p
                            class="rounded-box bg-base-200 p-3 text-sm text-base-content/80"
                        >
                            Public tab broadcasts messages to everyone connected
                            to the public channel.
                        </p>
                    {/if}

                    <div class="grid grid-cols-2 gap-2">
                        <button
                            class="btn btn-primary"
                            on:click={joinOrSwitchRoom}
                        >
                            {#if activeTab === "public"}
                                {status === "connected"
                                    ? "Reconnect Public"
                                    : "Join Public"}
                            {:else}
                                {status === "connected"
                                    ? "Switch Room"
                                    : "Join Room"}
                            {/if}
                        </button>
                        <button
                            class="btn btn-outline"
                            on:click={disconnect}
                            disabled={status !== "connected"}>Leave</button
                        >
                    </div>

                    {#if activeTab === "private"}
                        <div class="divider my-0"></div>

                        <div>
                            <div class="mb-2 flex items-center justify-between">
                                <h3 class="font-medium">Members</h3>
                                <span class="badge badge-neutral badge-sm"
                                    >{members.length}</span
                                >
                            </div>

                            {#if members.length === 0}
                                <p class="text-sm text-base-content/70">
                                    No members online.
                                </p>
                            {:else}
                                <ul
                                    class="menu rounded-box max-h-72 gap-1 overflow-y-auto bg-base-200 p-2"
                                >
                                    {#each members as member}
                                        <li>
                                            <span class="justify-between">
                                                {member}
                                                {#if member === currentClientId}
                                                    <span
                                                        class="badge badge-primary badge-xs"
                                                        >you</span
                                                    >
                                                {/if}
                                            </span>
                                        </li>
                                    {/each}
                                </ul>
                            {/if}
                        </div>
                    {/if}
                </div>
            </aside>

            <section class="card border border-base-300 bg-base-100 shadow-sm">
                <div class="card-body h-full p-0">
                    <div class="border-b border-base-300 px-4 py-3">
                        <h2 class="font-semibold">#{activeChannelLabel()}</h2>
                        <p class="text-sm text-base-content/70">
                            {activeTab === "public"
                                ? "Public chat: everyone in this channel receives messages."
                                : "Private chat: only this room members receive messages."}
                        </p>
                    </div>

                    <div
                        bind:this={messageContainer}
                        class="flex-1 space-y-2 overflow-y-auto px-3 py-3 md:px-4"
                    >
                        {#if messages.length === 0}
                            <div
                                class="hero min-h-[320px] rounded-box bg-base-200"
                            >
                                <div
                                    class="hero-content text-center text-base-content/70"
                                >
                                    <p>
                                        {activeTab === "public"
                                            ? "Join the public channel and start chatting."
                                            : "Join a private room and start chatting."}
                                    </p>
                                </div>
                            </div>
                        {:else}
                            {#each messages as item}
                                {#if item.kind === "system"}
                                    <div class="flex justify-center">
                                        <span
                                            class="badge badge-ghost badge-sm max-w-full truncate"
                                            >{item.text}</span
                                        >
                                    </div>
                                {:else}
                                    <div
                                        class={`chat ${item.mine ? "chat-end" : "chat-start"}`}
                                    >
                                        <div class="chat-header">
                                            {item.from}
                                            <time class="text-xs opacity-60"
                                                >{formatTime(item.at)}</time
                                            >
                                        </div>
                                        <div
                                            class={`chat-bubble max-w-full whitespace-pre-wrap break-all ${item.mine ? "chat-bubble-primary" : "chat-bubble-neutral"}`}
                                        >
                                            {item.text}
                                        </div>
                                    </div>
                                {/if}
                            {/each}
                        {/if}
                    </div>

                    <div class="border-t border-base-300 p-3 md:p-4">
                        <div class="join w-full">
                            <input
                                class="input input-bordered join-item w-full"
                                bind:value={messageInput}
                                disabled={status !== "connected"}
                                placeholder={status === "connected"
                                    ? `Message #${activeChannelLabel()}`
                                    : "Connect to start chatting"}
                                on:keydown={(event) =>
                                    event.key === "Enter" && sendChatMessage()}
                            />
                            <button
                                class="btn btn-primary join-item"
                                on:click={sendChatMessage}
                                disabled={status !== "connected"}
                            >
                                Send
                            </button>
                        </div>
                    </div>
                </div>
            </section>
        </div>
    </div>
</main>
