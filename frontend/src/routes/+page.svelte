<script lang="ts">
    import { browser } from "$app/environment";
    import { API_BASE_URL } from "$lib/config/api";
    import AuthScreen from "$lib/screens/AuthScreen.svelte";
    import ChatScreen from "$lib/screens/ChatScreen.svelte";
    import type {
        AuthMode,
        ChatMessage,
        ChatUser,
        Conversation,
        GroupConversation,
        MessageStatus,
        SidebarTab,
        SocketStatus,
        WsEventPayload,
    } from "$lib/types/chat";
    import { onDestroy, onMount, tick } from "svelte";

    const TOKEN_STORAGE_KEY = "chat_token";

    let authMode: AuthMode = "signin";
    let sidebarTab: SidebarTab = "chats";

    let signEmail = "";
    let signPassword = "";
    let signName = "";

    let authLoading = false;
    let authError = "";
    let token = "";
    let me: ChatUser | null = null;

    let ws: WebSocket | null = null;
    let wsStatus: SocketStatus = "disconnected";
    let onlineUserIds: string[] = [];
    let typingByConversation: Record<string, string[]> = {};

    let conversations: Conversation[] = [];
    let users: ChatUser[] = [];
    let groups: GroupConversation[] = [];

    let usersQuery = "";
    let groupsQuery = "";
    let activeConversationId = "";
    let activeConversation: Conversation | null = null;

    let messages: ChatMessage[] = [];
    let loadingMessages = false;
    let messageContainer: HTMLDivElement | null = null;

    let composerText = "";
    let composerImageFile: File | null = null;
    let composerImagePreview = "";
    let replyTo: ChatMessage | null = null;
    let activeTypingUsers: string[] = [];

    let newGroupName = "";
    let newGroupIsPublic = true;
    let creatingGroup = false;

    let typingTimer: ReturnType<typeof setTimeout> | null = null;

    let discordJoinTone: HTMLAudioElement | null = null;
    let messengerReceivedTone: HTMLAudioElement | null = null;
    let fahTone: HTMLAudioElement | null = null;

    class RequestError extends Error {
        statusCode: number;

        constructor(statusCode: number, message: string) {
            super(message);
            this.statusCode = statusCode;
        }
    }

    const asString = (value: unknown): string => {
        return typeof value === "string" ? value : "";
    };

    const asStringArray = (value: unknown): string[] => {
        if (Array.isArray(value)) {
            return value.filter(
                (item): item is string => typeof item === "string",
            );
        }

        return [];
    };

    const uniqueStringArray = (values: string[]): string[] => {
        return Array.from(new Set(values.filter(Boolean)));
    };

    const buildApiUrl = (path: string): string => {
        return `${API_BASE_URL}${path}`;
    };

    const buildWsUrl = (): string => {
        const url = new URL(API_BASE_URL);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        url.pathname = "/ws/chat";
        url.searchParams.set("token", token);
        return url.toString();
    };

    const saveToken = (nextToken: string): void => {
        if (!browser) {
            return;
        }

        if (nextToken) {
            localStorage.setItem(TOKEN_STORAGE_KEY, nextToken);
            return;
        }

        localStorage.removeItem(TOKEN_STORAGE_KEY);
    };

    const playTone = (tone: HTMLAudioElement | null): void => {
        if (!tone) {
            return;
        }

        tone.currentTime = 0;
        void tone.play().catch(() => {
            // Ignore autoplay failures.
        });
    };

    const getErrorMessage = (error: unknown): string => {
        if (error instanceof RequestError) {
            return error.message;
        }

        if (error instanceof Error && error.message) {
            return error.message;
        }

        return "Something went wrong";
    };

    const requestJson = async <T,>(
        path: string,
        requestInit: RequestInit = {},
    ): Promise<T> => {
        const normalizedRequestInit = requestInit ?? {};
        const headers = new Headers(normalizedRequestInit.headers ?? {});

        if (
            !(normalizedRequestInit.body instanceof FormData) &&
            !headers.has("Content-Type")
        ) {
            headers.set("Content-Type", "application/json");
        }

        if (token) {
            headers.set("Authorization", `Bearer ${token}`);
        }

        const response = await fetch(buildApiUrl(path), {
            ...normalizedRequestInit,
            headers,
        });

        const payload = (await response.json().catch(() => ({}))) as Record<
            string,
            unknown
        >;

        if (!response.ok) {
            throw new RequestError(
                response.status,
                asString(payload.error) || "Request failed",
            );
        }

        return payload as T;
    };

    const sortConversationsByActivity = (
        items: Conversation[],
    ): Conversation[] => {
        return [...items].sort((left, right) => {
            const leftTime = left.lastMessage?.created || left.updated;
            const rightTime = right.lastMessage?.created || right.updated;

            return new Date(rightTime).getTime() - new Date(leftTime).getTime();
        });
    };

    const upsertConversation = (conversation: Conversation): void => {
        const currentIndex = conversations.findIndex(
            (item) => item.id === conversation.id,
        );

        if (currentIndex >= 0) {
            conversations = sortConversationsByActivity(
                conversations.map((item) =>
                    item.id === conversation.id
                        ? { ...item, ...conversation }
                        : item,
                ),
            );
            return;
        }

        conversations = sortConversationsByActivity([
            ...conversations,
            conversation,
        ]);
    };

    const removeConversation = (conversationId: string): void => {
        conversations = conversations.filter(
            (item) => item.id !== conversationId,
        );

        if (activeConversationId === conversationId) {
            activeConversationId = "";
            messages = [];
            replyTo = null;
        }
    };

    const resolveKnownUser = (userId: string): ChatUser | null => {
        if (me?.id === userId) {
            return me;
        }

        const fromUserList = users.find((user) => user.id === userId);
        if (fromUserList) {
            return fromUserList;
        }

        for (const conversation of conversations) {
            const member = conversation.members.find(
                (item) => item.id === userId,
            );
            if (member) {
                return member;
            }
        }

        return null;
    };

    const resolveUserName = (userId: string): string => {
        const known = resolveKnownUser(userId);
        return known?.name ?? `user-${userId.slice(0, 5)}`;
    };

    const isUserOnline = (userId: string): boolean => {
        return onlineUserIds.includes(userId);
    };

    const getDisplayConversationTitle = (
        conversation: Conversation,
    ): string => {
        if (conversation.type === "group") {
            return conversation.title;
        }

        const otherMember = conversation.members.find(
            (member) => member.id !== me?.id,
        );
        return otherMember?.name ?? conversation.title;
    };

    const getConversationSubtitle = (conversation: Conversation): string => {
        if (conversation.lastMessage) {
            const prefix =
                conversation.lastMessage.sender.id === me?.id ? "You: " : "";

            if (conversation.lastMessage.text) {
                return `${prefix}${conversation.lastMessage.text}`;
            }

            if (conversation.lastMessage.imageUrl) {
                return `${prefix}📷 Image`;
            }
        }

        return conversation.type === "group"
            ? "Group conversation"
            : "Direct message";
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

    const formatDate = (value: string): string => {
        if (!value) {
            return "";
        }

        return new Date(value).toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
        });
    };

    const renderStatusLabel = (status: MessageStatus): string => {
        if (status === "seen") {
            return "Seen";
        }

        if (status === "delivered") {
            return "Delivered";
        }

        if (status === "failed") {
            return "Failed";
        }

        if (status === "sending") {
            return "Sending";
        }

        return "Sent";
    };

    const scrollMessagesToBottom = async (): Promise<void> => {
        await tick();

        if (!messageContainer) {
            return;
        }

        messageContainer.scrollTop = messageContainer.scrollHeight;
    };

    const connectSocket = (): void => {
        if (!token || !me) {
            return;
        }

        if (ws) {
            ws.close(1000, "Reconnect");
        }

        wsStatus = "connecting";
        const socket = new WebSocket(buildWsUrl());
        ws = socket;

        socket.addEventListener("open", () => {
            wsStatus = "connected";
            playTone(discordJoinTone);
        });

        socket.addEventListener("message", async (event) => {
            let payload: WsEventPayload;

            try {
                payload = JSON.parse(String(event.data)) as WsEventPayload;
            } catch {
                return;
            }

            if (payload.type === "hello") {
                onlineUserIds = uniqueStringArray(
                    asStringArray(payload.onlineUserIds),
                );
                return;
            }

            if (payload.type === "presence:update" && payload.userId) {
                if (payload.online) {
                    onlineUserIds = uniqueStringArray([
                        ...onlineUserIds,
                        payload.userId,
                    ]);
                } else {
                    onlineUserIds = onlineUserIds.filter(
                        (id) => id !== payload.userId,
                    );
                }
                return;
            }

            if (
                payload.type === "typing:update" &&
                payload.conversationId &&
                payload.userId
            ) {
                const existing = new Set(
                    typingByConversation[payload.conversationId] ?? [],
                );

                if (payload.isTyping) {
                    existing.add(payload.userId);
                } else {
                    existing.delete(payload.userId);
                }

                typingByConversation = {
                    ...typingByConversation,
                    [payload.conversationId]: Array.from(existing),
                };
                return;
            }

            if (
                payload.type === "conversation:upsert" &&
                payload.conversation
            ) {
                upsertConversation(payload.conversation);
                return;
            }

            if (
                payload.type === "conversation:removed" &&
                payload.conversationId
            ) {
                removeConversation(payload.conversationId);
                return;
            }

            if (payload.type === "message:new" && payload.message) {
                const incomingMessage = payload.message;
                const conversationId =
                    payload.conversationId ?? incomingMessage.conversationId;

                const existingTempIndex = messages.findIndex(
                    (message) =>
                        message.clientTempId &&
                        incomingMessage.clientTempId &&
                        message.clientTempId === incomingMessage.clientTempId,
                );

                if (conversationId === activeConversationId) {
                    if (existingTempIndex >= 0) {
                        messages = messages.map((message, index) =>
                            index === existingTempIndex
                                ? incomingMessage
                                : message,
                        );
                    } else {
                        const existingById = messages.find(
                            (message) => message.id === incomingMessage.id,
                        );

                        if (!existingById) {
                            messages = [...messages, incomingMessage];
                        }
                    }

                    await scrollMessagesToBottom();
                }

                const existingConversation = conversations.find(
                    (conversation) => conversation.id === conversationId,
                );
                if (existingConversation) {
                    upsertConversation({
                        ...existingConversation,
                        lastMessage: incomingMessage,
                        updated: incomingMessage.created,
                    });
                }

                if (incomingMessage.sender.id !== me?.id) {
                    playTone(messengerReceivedTone);

                    if (conversationId === activeConversationId) {
                        void markConversationSeen(conversationId);
                        sendSocketEvent({
                            type: "seen",
                            conversationId,
                        });
                    }
                }

                return;
            }

            if (
                payload.type === "message:status" &&
                payload.messageId &&
                payload.status
            ) {
                const nextStatus = payload.status;
                const nextDeliveredTo = payload.deliveredTo
                    ? asStringArray(payload.deliveredTo)
                    : null;
                const nextSeenBy = payload.seenBy
                    ? asStringArray(payload.seenBy)
                    : null;

                messages = messages.map((message) => {
                    if (message.id !== payload.messageId) {
                        return message;
                    }

                    return {
                        ...message,
                        status: nextStatus,
                        deliveredTo: nextDeliveredTo ?? message.deliveredTo,
                        seenBy: nextSeenBy ?? message.seenBy,
                    };
                });
                return;
            }

            if (
                payload.type === "message:status-bulk" &&
                Array.isArray(payload.updates)
            ) {
                const updates = payload.updates;
                messages = messages.map((message) => {
                    const found = updates.find(
                        (item) => item.messageId === message.id,
                    );
                    if (!found) {
                        return message;
                    }

                    return {
                        ...message,
                        status: found.status,
                        deliveredTo: asStringArray(found.deliveredTo),
                        seenBy: asStringArray(found.seenBy),
                    };
                });
                return;
            }
        });

        socket.addEventListener("close", () => {
            if (ws === socket) {
                ws = null;
            }
            wsStatus = "disconnected";
        });

        socket.addEventListener("error", () => {
            wsStatus = "disconnected";
        });
    };

    const disconnectSocket = (): void => {
        if (!ws) {
            return;
        }

        ws.close(1000, "disconnect");
        ws = null;
        wsStatus = "disconnected";
    };

    const sendSocketEvent = (payload: Record<string, unknown>): void => {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            return;
        }

        ws.send(JSON.stringify(payload));
    };

    const fetchMe = async (): Promise<void> => {
        const result = await requestJson<{ user: ChatUser }>("/api/auth/me");
        me = result.user;
    };

    const fetchConversations = async (): Promise<void> => {
        const result = await requestJson<{ items: Conversation[] }>(
            "/api/conversations",
        );
        conversations = sortConversationsByActivity(result.items);

        if (!activeConversationId && conversations.length > 0) {
            activeConversationId = conversations[0].id;
        }
    };

    const fetchUsers = async (): Promise<void> => {
        const path = usersQuery.trim()
            ? `/api/users?search=${encodeURIComponent(usersQuery.trim())}`
            : "/api/users";
        const result = await requestJson<{ items: ChatUser[] }>(path);
        users = result.items;
    };

    const fetchGroups = async (): Promise<void> => {
        const path = groupsQuery.trim()
            ? `/api/groups?search=${encodeURIComponent(groupsQuery.trim())}`
            : "/api/groups";
        const result = await requestJson<{ items: GroupConversation[] }>(path);
        groups = result.items;
    };

    const loadMessages = async (conversationId: string): Promise<void> => {
        loadingMessages = true;

        try {
            const result = await requestJson<{ items: ChatMessage[] }>(
                `/api/conversations/${conversationId}/messages`,
            );
            messages = result.items;
            await scrollMessagesToBottom();
        } finally {
            loadingMessages = false;
        }
    };

    const markConversationSeen = async (
        conversationId: string,
    ): Promise<void> => {
        await requestJson<{ updated: number }>(
            `/api/conversations/${conversationId}/seen`,
            {
                method: "POST",
                body: JSON.stringify({}),
            },
        );
    };

    const openConversation = async (conversationId: string): Promise<void> => {
        activeConversationId = conversationId;
        await loadMessages(conversationId);
        await markConversationSeen(conversationId);

        sendSocketEvent({
            type: "seen",
            conversationId,
        });
    };

    const bootstrapAfterAuth = async (): Promise<void> => {
        authError = "";
        await fetchConversations();
        await fetchUsers();
        await fetchGroups();

        if (activeConversationId) {
            await openConversation(activeConversationId);
        }

        connectSocket();
    };

    const signIn = async (): Promise<void> => {
        authLoading = true;
        authError = "";

        try {
            const result = await requestJson<{ token: string; user: ChatUser }>(
                "/api/auth/signin",
                {
                    method: "POST",
                    body: JSON.stringify({
                        email: signEmail.trim(),
                        password: signPassword,
                    }),
                },
            );

            token = result.token;
            saveToken(token);
            me = result.user;
            await bootstrapAfterAuth();
        } catch (error) {
            authError = getErrorMessage(error);
        } finally {
            authLoading = false;
        }
    };

    const signUp = async (): Promise<void> => {
        authLoading = true;
        authError = "";

        try {
            const result = await requestJson<{ token: string; user: ChatUser }>(
                "/api/auth/signup",
                {
                    method: "POST",
                    body: JSON.stringify({
                        email: signEmail.trim(),
                        password: signPassword,
                        passwordConfirm: signPassword,
                        name: signName.trim(),
                    }),
                },
            );

            token = result.token;
            saveToken(token);
            me = result.user;
            await bootstrapAfterAuth();
        } catch (error) {
            authError = getErrorMessage(error);
        } finally {
            authLoading = false;
        }
    };

    const signOut = (): void => {
        disconnectSocket();
        token = "";
        saveToken("");
        me = null;
        conversations = [];
        users = [];
        groups = [];
        messages = [];
        activeConversationId = "";
        replyTo = null;
        composerText = "";
        typingByConversation = {};
        onlineUserIds = [];
    };

    const startDirectChat = async (userId: string): Promise<void> => {
        const result = await requestJson<{ item: Conversation }>(
            `/api/conversations/direct/${userId}`,
            {
                method: "POST",
                body: JSON.stringify({}),
            },
        );

        upsertConversation(result.item);
        sidebarTab = "chats";
        await openConversation(result.item.id);
    };

    const createGroup = async (): Promise<void> => {
        const title = newGroupName.trim();

        if (!title) {
            return;
        }

        creatingGroup = true;

        try {
            const result = await requestJson<{ item: Conversation }>(
                "/api/groups",
                {
                    method: "POST",
                    body: JSON.stringify({
                        title,
                        isPublic: newGroupIsPublic,
                    }),
                },
            );

            newGroupName = "";
            upsertConversation(result.item);
            await fetchGroups();
            sidebarTab = "chats";
            await openConversation(result.item.id);
        } catch (error) {
            authError = getErrorMessage(error);
        } finally {
            creatingGroup = false;
        }
    };

    const joinGroup = async (groupId: string): Promise<void> => {
        const result = await requestJson<{ item: Conversation }>(
            `/api/groups/${groupId}/join`,
            {
                method: "POST",
                body: JSON.stringify({}),
            },
        );

        upsertConversation(result.item);
        await fetchGroups();
        sidebarTab = "chats";
        await openConversation(result.item.id);
    };

    const leaveCurrentGroup = async (): Promise<void> => {
        if (!activeConversation || activeConversation.type !== "group") {
            return;
        }

        await requestJson<{ ok: boolean }>(
            `/api/groups/${activeConversation.id}/leave`,
            {
                method: "POST",
                body: JSON.stringify({}),
            },
        );

        removeConversation(activeConversation.id);
        await fetchGroups();

        if (conversations.length > 0) {
            await openConversation(conversations[0].id);
        }
    };

    const clearReply = (): void => {
        replyTo = null;
    };

    const clearComposerImage = (): void => {
        if (composerImagePreview) {
            URL.revokeObjectURL(composerImagePreview);
        }

        composerImagePreview = "";
        composerImageFile = null;
    };

    const handleImageSelection = (event: Event): void => {
        const target = event.target as HTMLInputElement;
        const file = target.files?.[0] ?? null;

        if (!file) {
            return;
        }

        clearComposerImage();
        composerImageFile = file;
        composerImagePreview = URL.createObjectURL(file);
        target.value = "";
    };

    const sendTypingState = (isTyping: boolean): void => {
        if (!activeConversationId) {
            return;
        }

        sendSocketEvent({
            type: "typing",
            conversationId: activeConversationId,
            isTyping,
        });
    };

    const handleComposerInput = (): void => {
        sendTypingState(true);

        if (typingTimer) {
            clearTimeout(typingTimer);
        }

        typingTimer = setTimeout(() => {
            sendTypingState(false);
            typingTimer = null;
        }, 1200);
    };

    const sendMessage = async (): Promise<void> => {
        if (!activeConversation || !me) {
            return;
        }

        const currentConversationId = activeConversation.id;

        const text = composerText.trim();

        if (!text && !composerImageFile) {
            return;
        }

        if (text.toLowerCase() === "fah") {
            playTone(fahTone);
        }

        const tempId = `temp-${crypto.randomUUID()}`;
        const optimisticMessage: ChatMessage = {
            id: tempId,
            conversationId: currentConversationId,
            sender: me,
            text,
            imageUrl: composerImagePreview || null,
            replyTo: replyTo
                ? {
                      id: replyTo.id,
                      text: replyTo.text,
                      senderName: replyTo.sender.name,
                      imageUrl: replyTo.imageUrl,
                  }
                : null,
            status: "sending",
            deliveredTo: [me.id],
            seenBy: [me.id],
            created: new Date().toISOString(),
            updated: new Date().toISOString(),
            clientTempId: tempId,
        };

        messages = [...messages, optimisticMessage];
        await scrollMessagesToBottom();

        const imageFile = composerImageFile;
        const currentReplyTo = replyTo;

        composerText = "";
        clearComposerImage();
        clearReply();
        sendTypingState(false);

        const body = new FormData();
        body.append("clientTempId", tempId);
        body.append("text", text);

        if (currentReplyTo) {
            body.append("replyTo", currentReplyTo.id);
        }

        if (imageFile) {
            body.append("image", imageFile);
        }

        try {
            const result = await requestJson<{ item: ChatMessage }>(
                `/api/conversations/${currentConversationId}/messages`,
                {
                    method: "POST",
                    body,
                },
            );

            messages = messages.map((message) =>
                message.clientTempId === tempId || message.id === tempId
                    ? result.item
                    : message,
            );

            const existingConversation = conversations.find(
                (conversation) => conversation.id === currentConversationId,
            );

            if (existingConversation) {
                upsertConversation({
                    ...existingConversation,
                    lastMessage: result.item,
                    updated: result.item.created,
                });
            }
        } catch {
            messages = messages.map((message) =>
                message.id === tempId
                    ? { ...message, status: "failed" }
                    : message,
            );
        }
    };

    $: activeConversation =
        conversations.find(
            (conversation) => conversation.id === activeConversationId,
        ) ?? null;

    $: activeTypingUsers = activeConversation
        ? uniqueStringArray(typingByConversation[activeConversation.id] ?? [])
              .filter((userId) => userId !== me?.id)
              .map((userId) => resolveUserName(userId))
        : [];

    onMount(async () => {
        discordJoinTone = new Audio("/discord-join.mp3");
        discordJoinTone.preload = "auto";

        messengerReceivedTone = new Audio("/messenger-chat.mp3");
        messengerReceivedTone.preload = "auto";

        fahTone = new Audio("/fah.mp3");
        fahTone.preload = "auto";

        if (browser) {
            const storedToken = localStorage.getItem(TOKEN_STORAGE_KEY);
            if (storedToken) {
                token = storedToken;
                try {
                    await fetchMe();
                    await bootstrapAfterAuth();
                } catch {
                    signOut();
                }
            }
        }
    });

    onDestroy(() => {
        disconnectSocket();

        if (typingTimer) {
            clearTimeout(typingTimer);
        }

        clearComposerImage();

        discordJoinTone = null;
        messengerReceivedTone = null;
        fahTone = null;
    });
</script>

<main class="box-border h-dvh overflow-hidden bg-base-200 p-3 md:p-4">
    {#if !me}
        <AuthScreen
            bind:authMode
            bind:signEmail
            bind:signPassword
            bind:signName
            {authLoading}
            {authError}
            onSwitchMode={(mode) => (authMode = mode)}
            onSubmit={() => (authMode === "signin" ? signIn() : signUp())}
        />
    {:else}
        <ChatScreen
            {me}
            {wsStatus}
            bind:sidebarTab
            {conversations}
            {users}
            {groups}
            bind:usersQuery
            bind:groupsQuery
            {activeConversationId}
            {activeConversation}
            {messages}
            {loadingMessages}
            bind:messageContainer
            bind:composerText
            {composerImagePreview}
            bind:replyTo
            {activeTypingUsers}
            bind:newGroupName
            bind:newGroupIsPublic
            {creatingGroup}
            onSignOut={signOut}
            onOpenConversation={openConversation}
            onFetchUsers={fetchUsers}
            onStartDirectChat={startDirectChat}
            onFetchGroups={fetchGroups}
            onCreateGroup={createGroup}
            onJoinGroup={joinGroup}
            onLeaveCurrentGroup={leaveCurrentGroup}
            onClearReply={clearReply}
            onClearComposerImage={clearComposerImage}
            onHandleImageSelection={handleImageSelection}
            onHandleComposerInput={handleComposerInput}
            onSendMessage={sendMessage}
            {isUserOnline}
            {getDisplayConversationTitle}
            {getConversationSubtitle}
            {formatDate}
            {formatTime}
            {renderStatusLabel}
        />
    {/if}
</main>
