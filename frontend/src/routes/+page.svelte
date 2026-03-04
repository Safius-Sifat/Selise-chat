<script lang="ts">
    import { browser } from "$app/environment";
    import { onDestroy, onMount, tick } from "svelte";

    type AuthMode = "signin" | "signup";
    type SidebarTab = "chats" | "users" | "groups";
    type MessageStatus = "sending" | "sent" | "delivered" | "seen" | "failed";

    interface ChatUser {
        id: string;
        email: string;
        name: string;
        avatarUrl: string | null;
        online: boolean;
    }

    interface ChatMessage {
        id: string;
        conversationId: string;
        sender: ChatUser;
        text: string;
        imageUrl: string | null;
        replyTo: {
            id: string;
            text: string;
            senderName: string;
            imageUrl: string | null;
        } | null;
        status: MessageStatus;
        deliveredTo: string[];
        seenBy: string[];
        created: string;
        updated: string;
        clientTempId: string | null;
    }

    interface Conversation {
        id: string;
        type: "direct" | "group";
        title: string;
        isPublic: boolean;
        createdBy: string;
        members: ChatUser[];
        memberIds: string[];
        lastMessage: ChatMessage | null;
        created: string;
        updated: string;
    }

    interface GroupConversation extends Conversation {
        isMember: boolean;
        memberCount: number;
    }

    interface WsEventPayload {
        type: string;
        conversationId?: string;
        message?: ChatMessage;
        conversation?: Conversation;
        updates?: Array<{
            messageId: string;
            status: MessageStatus;
            deliveredTo: string[];
            seenBy: string[];
        }>;
        messageId?: string;
        status?: MessageStatus;
        deliveredTo?: string[];
        seenBy?: string[];
        userId?: string;
        online?: boolean;
        onlineUserIds?: string[];
        isTyping?: boolean;
        messageText?: string;
        messagePreview?: string;
        messageType?: string;
        messageStatus?: MessageStatus;
        messageCreated?: string;
        messageSenderId?: string;
        messageSenderName?: string;
        messageImage?: string | null;
        messageReplyToId?: string | null;
        system?: string;
        messageBody?: string;
        messageIdList?: string[];
        messageStatusMap?: Record<string, MessageStatus>;
        messageDeliveredMap?: Record<string, string[]>;
        messageSeenMap?: Record<string, string[]>;
        messageClientTempId?: string;
        note?: string;
        messagePayload?: ChatMessage;
        messageCollection?: ChatMessage[];
        user?: ChatUser;
    }

    const DEFAULT_API_BASE_URL = "https://selise.notice.fit";
    const TOKEN_STORAGE_KEY = "chat_token";
    const API_BASE_STORAGE_KEY = "chat_api_base";

    let apiBaseUrl = DEFAULT_API_BASE_URL;
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
    let wsStatus: "disconnected" | "connecting" | "connected" = "disconnected";
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

    const asBoolean = (value: unknown): boolean => {
        return typeof value === "boolean" ? value : false;
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

    const normalizeBaseUrl = (): string => {
        const fallback = DEFAULT_API_BASE_URL;
        const raw = apiBaseUrl.trim() || fallback;

        if (raw.startsWith("http://") || raw.startsWith("https://")) {
            return raw.replace(/\/+$/, "");
        }

        return `https://${raw}`.replace(/\/+$/, "");
    };

    const buildApiUrl = (path: string): string => {
        return `${normalizeBaseUrl()}${path}`;
    };

    const buildWsUrl = (): string => {
        const normalized = normalizeBaseUrl();
        const url = new URL(normalized);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        url.pathname = "/ws/chat";
        url.searchParams.set("token", token);
        return url.toString();
    };

    const saveApiBase = (): void => {
        if (!browser) {
            return;
        }

        localStorage.setItem(API_BASE_STORAGE_KEY, normalizeBaseUrl());
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
        init: RequestInit = {},
    ): Promise<T> => {
        const headers = new Headers(init.headers ?? {});

        if (!(init.body instanceof FormData) && !headers.has("Content-Type")) {
            headers.set("Content-Type", "application/json");
        }

        if (token) {
            headers.set("Authorization", `Bearer ${token}`);
        }

        const response = await fetch(buildApiUrl(path), {
            ...init,
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
            const storedBase = localStorage.getItem(API_BASE_STORAGE_KEY);
            if (storedBase) {
                apiBaseUrl = storedBase;
            }

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
        <div
            class="mx-auto flex h-full w-full max-w-md items-center justify-center"
        >
            <div
                class="card w-full border border-base-300 bg-base-100 shadow-xl"
            >
                <div class="card-body gap-4">
                    <div class="flex items-center justify-between">
                        <h1 class="text-2xl font-bold">PocketChat</h1>
                        <div
                            role="tablist"
                            class="tabs tabs-box bg-base-200 p-1"
                        >
                            <button
                                class={`tab ${authMode === "signin" ? "tab-active" : ""}`}
                                on:click={() => (authMode = "signin")}
                            >
                                Sign in
                            </button>
                            <button
                                class={`tab ${authMode === "signup" ? "tab-active" : ""}`}
                                on:click={() => (authMode = "signup")}
                            >
                                Sign up
                            </button>
                        </div>
                    </div>

                    <p class="text-sm text-base-content/70">
                        WhatsApp-like messaging powered by PocketBase
                        authentication and storage.
                    </p>

                    <label class="form-control gap-1">
                        <span class="label-text text-sm">Backend URL</span>
                        <input
                            class="input input-bordered"
                            bind:value={apiBaseUrl}
                            on:blur={saveApiBase}
                            placeholder="https://selise.notice.fit"
                        />
                    </label>

                    {#if authMode === "signup"}
                        <label class="form-control gap-1">
                            <span class="label-text text-sm">Name</span>
                            <input
                                class="input input-bordered"
                                bind:value={signName}
                                placeholder="Your name"
                            />
                        </label>
                    {/if}

                    <label class="form-control gap-1">
                        <span class="label-text text-sm">Email</span>
                        <input
                            class="input input-bordered"
                            bind:value={signEmail}
                            type="email"
                            placeholder="hello@example.com"
                        />
                    </label>

                    <label class="form-control gap-1">
                        <span class="label-text text-sm">Password</span>
                        <input
                            class="input input-bordered"
                            bind:value={signPassword}
                            type="password"
                            placeholder="••••••••"
                        />
                    </label>

                    {#if authError}
                        <div class="alert alert-error py-2 text-sm">
                            {authError}
                        </div>
                    {/if}

                    <button
                        class="btn btn-primary"
                        disabled={authLoading}
                        on:click={() =>
                            authMode === "signin" ? signIn() : signUp()}
                    >
                        {authLoading
                            ? "Please wait..."
                            : authMode === "signin"
                              ? "Sign in"
                              : "Create account"}
                    </button>
                </div>
            </div>
        </div>
    {:else}
        <div
            class="mx-auto grid h-full min-h-0 max-w-7xl gap-3 lg:grid-cols-[360px_minmax(0,1fr)]"
        >
            <aside
                class="card min-h-0 overflow-hidden border border-base-300 bg-base-100 shadow-sm"
            >
                <div class="card-body flex min-h-0 flex-col gap-3 p-3">
                    <div class="flex items-center justify-between gap-3">
                        <div class="min-w-0">
                            <p class="truncate font-semibold">{me.name}</p>
                            <p class="truncate text-xs text-base-content/60">
                                {me.email}
                            </p>
                        </div>
                        <div class="flex items-center gap-2">
                            <span
                                class={`badge ${wsStatus === "connected" ? "badge-success" : wsStatus === "connecting" ? "badge-warning" : "badge-ghost"}`}
                            >
                                {wsStatus}
                            </span>
                            <button
                                class="btn btn-ghost btn-xs"
                                on:click={signOut}>Sign out</button
                            >
                        </div>
                    </div>

                    <label class="form-control gap-1">
                        <span class="label-text text-xs">Backend URL</span>
                        <input
                            class="input input-bordered input-sm"
                            bind:value={apiBaseUrl}
                            on:blur={saveApiBase}
                        />
                    </label>

                    <div role="tablist" class="tabs tabs-box bg-base-200 p-1">
                        <button
                            class={`tab ${sidebarTab === "chats" ? "tab-active" : ""}`}
                            on:click={() => (sidebarTab = "chats")}
                        >
                            Chats
                        </button>
                        <button
                            class={`tab ${sidebarTab === "users" ? "tab-active" : ""}`}
                            on:click={() => (sidebarTab = "users")}
                        >
                            Users
                        </button>
                        <button
                            class={`tab ${sidebarTab === "groups" ? "tab-active" : ""}`}
                            on:click={() => (sidebarTab = "groups")}
                        >
                            Groups
                        </button>
                    </div>

                    <div class="min-h-0 flex-1 overflow-y-auto">
                        {#if sidebarTab === "chats"}
                            <div class="space-y-2">
                                {#if conversations.length === 0}
                                    <div
                                        class="rounded-box bg-base-200 p-3 text-sm text-base-content/70"
                                    >
                                        No conversations yet. Start from Users
                                        or Groups.
                                    </div>
                                {:else}
                                    {#each conversations as conversation}
                                        <button
                                            class={`w-full rounded-box border p-3 text-left transition ${activeConversationId === conversation.id ? "border-primary bg-primary/10" : "border-base-300 bg-base-100 hover:bg-base-200"}`}
                                            on:click={() =>
                                                openConversation(
                                                    conversation.id,
                                                )}
                                        >
                                            <div
                                                class="mb-1 flex items-center justify-between gap-2"
                                            >
                                                <p class="truncate font-medium">
                                                    {getDisplayConversationTitle(
                                                        conversation,
                                                    )}
                                                </p>
                                                {#if conversation.lastMessage}
                                                    <span
                                                        class="text-[11px] text-base-content/60"
                                                        >{formatDate(
                                                            conversation
                                                                .lastMessage
                                                                .created,
                                                        )}</span
                                                    >
                                                {/if}
                                            </div>
                                            <p
                                                class="truncate text-xs text-base-content/70"
                                            >
                                                {getConversationSubtitle(
                                                    conversation,
                                                )}
                                            </p>
                                            {#if conversation.type === "direct"}
                                                {#if isUserOnline(conversation.members.find((member) => member.id !== me?.id)?.id ?? "")}
                                                    <div
                                                        class="mt-2 inline-flex items-center gap-1 text-[11px] text-success"
                                                    >
                                                        <span
                                                            class="inline-block h-2 w-2 rounded-full bg-success"
                                                        ></span>
                                                        online
                                                    </div>
                                                {/if}
                                            {/if}
                                        </button>
                                    {/each}
                                {/if}
                            </div>
                        {:else if sidebarTab === "users"}
                            <div class="space-y-2">
                                <div class="join w-full">
                                    <input
                                        class="input input-bordered input-sm join-item w-full"
                                        bind:value={usersQuery}
                                        placeholder="Search users"
                                    />
                                    <button
                                        class="btn btn-sm join-item"
                                        on:click={fetchUsers}>Search</button
                                    >
                                </div>

                                {#if users.length === 0}
                                    <div
                                        class="rounded-box bg-base-200 p-3 text-sm text-base-content/70"
                                    >
                                        No users found.
                                    </div>
                                {:else}
                                    {#each users as user}
                                        <div
                                            class="flex items-center justify-between gap-2 rounded-box border border-base-300 p-3"
                                        >
                                            <div class="min-w-0">
                                                <p class="truncate font-medium">
                                                    {user.name}
                                                </p>
                                                <p
                                                    class="truncate text-xs text-base-content/70"
                                                >
                                                    {user.email}
                                                </p>
                                                {#if isUserOnline(user.id)}
                                                    <span
                                                        class="text-[11px] text-success"
                                                        >online</span
                                                    >
                                                {/if}
                                            </div>
                                            <button
                                                class="btn btn-primary btn-sm"
                                                on:click={() =>
                                                    startDirectChat(user.id)}
                                            >
                                                Chat
                                            </button>
                                        </div>
                                    {/each}
                                {/if}
                            </div>
                        {:else}
                            <div class="space-y-3">
                                <div
                                    class="rounded-box border border-base-300 p-3"
                                >
                                    <p class="mb-2 text-sm font-medium">
                                        Create group
                                    </p>
                                    <input
                                        class="input input-bordered input-sm mb-2 w-full"
                                        bind:value={newGroupName}
                                        placeholder="Group name"
                                    />
                                    <label
                                        class="label cursor-pointer justify-start gap-2 px-0"
                                    >
                                        <input
                                            class="toggle toggle-sm"
                                            type="checkbox"
                                            bind:checked={newGroupIsPublic}
                                        />
                                        <span class="label-text text-sm"
                                            >Public group</span
                                        >
                                    </label>
                                    <button
                                        class="btn btn-primary btn-sm mt-2 w-full"
                                        disabled={creatingGroup}
                                        on:click={createGroup}
                                    >
                                        {creatingGroup
                                            ? "Creating..."
                                            : "Create group"}
                                    </button>
                                </div>

                                <div class="join w-full">
                                    <input
                                        class="input input-bordered input-sm join-item w-full"
                                        bind:value={groupsQuery}
                                        placeholder="Find groups"
                                    />
                                    <button
                                        class="btn btn-sm join-item"
                                        on:click={fetchGroups}>Search</button
                                    >
                                </div>

                                {#if groups.length === 0}
                                    <div
                                        class="rounded-box bg-base-200 p-3 text-sm text-base-content/70"
                                    >
                                        No groups found.
                                    </div>
                                {:else}
                                    {#each groups as group}
                                        <div
                                            class="rounded-box border border-base-300 p-3"
                                        >
                                            <div
                                                class="mb-1 flex items-center justify-between gap-2"
                                            >
                                                <p class="truncate font-medium">
                                                    {group.title}
                                                </p>
                                                <span
                                                    class="badge badge-outline badge-sm"
                                                    >{group.memberCount} members</span
                                                >
                                            </div>
                                            <p
                                                class="mb-2 text-xs text-base-content/70"
                                            >
                                                {group.isPublic
                                                    ? "Public"
                                                    : "Private"}
                                            </p>
                                            <div class="flex gap-2">
                                                {#if group.isMember}
                                                    <button
                                                        class="btn btn-sm btn-primary"
                                                        on:click={() =>
                                                            openConversation(
                                                                group.id,
                                                            )}>Open</button
                                                    >
                                                {:else}
                                                    <button
                                                        class="btn btn-sm btn-accent"
                                                        on:click={() =>
                                                            joinGroup(group.id)}
                                                        >Join</button
                                                    >
                                                {/if}
                                            </div>
                                        </div>
                                    {/each}
                                {/if}
                            </div>
                        {/if}
                    </div>
                </div>
            </aside>

            <section
                class="card min-h-0 overflow-hidden border border-base-300 bg-base-100 shadow-sm"
            >
                {#if !activeConversation}
                    <div class="hero h-full">
                        <div
                            class="hero-content text-center text-base-content/70"
                        >
                            <div>
                                <h2 class="text-xl font-semibold">
                                    Select a conversation
                                </h2>
                                <p>
                                    Pick a chat from the left sidebar to start
                                    messaging.
                                </p>
                            </div>
                        </div>
                    </div>
                {:else}
                    <div class="flex h-full min-h-0 flex-col">
                        <div class="border-b border-base-300 px-4 py-3">
                            <div
                                class="flex items-center justify-between gap-3"
                            >
                                <div class="min-w-0">
                                    <h2 class="truncate text-lg font-semibold">
                                        {getDisplayConversationTitle(
                                            activeConversation,
                                        )}
                                    </h2>
                                    <p class="text-xs text-base-content/70">
                                        {activeConversation.type === "group"
                                            ? `${activeConversation.memberIds.length} members`
                                            : isUserOnline(
                                                    activeConversation.members.find(
                                                        (member) =>
                                                            member.id !==
                                                            me?.id,
                                                    )?.id ?? "",
                                                )
                                              ? "online"
                                              : "offline"}
                                    </p>
                                </div>
                                <div class="flex items-center gap-2">
                                    {#if activeConversation.type === "group"}
                                        <button
                                            class="btn btn-outline btn-sm"
                                            on:click={leaveCurrentGroup}
                                            >Leave group</button
                                        >
                                    {/if}
                                </div>
                            </div>

                            {#if activeConversation.type === "group"}
                                <div class="mt-2 flex gap-1 overflow-x-auto">
                                    {#each activeConversation.members as member}
                                        <span
                                            class={`badge badge-sm ${isUserOnline(member.id) ? "badge-success" : "badge-ghost"}`}
                                        >
                                            {member.name}
                                        </span>
                                    {/each}
                                </div>
                            {/if}
                        </div>

                        <div
                            bind:this={messageContainer}
                            class="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-3 md:px-4"
                        >
                            {#if loadingMessages}
                                <div
                                    class="flex h-full items-center justify-center text-sm text-base-content/70"
                                >
                                    Loading messages...
                                </div>
                            {:else if messages.length === 0}
                                <div
                                    class="hero min-h-[240px] rounded-box bg-base-200"
                                >
                                    <div
                                        class="hero-content text-center text-base-content/70"
                                    >
                                        <p>
                                            No messages yet. Start the
                                            conversation 👋
                                        </p>
                                    </div>
                                </div>
                            {:else}
                                {#each messages as message}
                                    <div
                                        class={`chat ${message.sender.id === me?.id ? "chat-end" : "chat-start"}`}
                                    >
                                        <div class="chat-header">
                                            {message.sender.id === me?.id
                                                ? "You"
                                                : message.sender.name}
                                            <time class="text-[11px] opacity-60"
                                                >{formatTime(
                                                    message.created,
                                                )}</time
                                            >
                                        </div>
                                        <div
                                            class={`chat-bubble max-w-full whitespace-pre-wrap break-all ${message.sender.id === me?.id ? "chat-bubble-primary" : "chat-bubble-neutral"}`}
                                        >
                                            {#if message.replyTo}
                                                <div
                                                    class="mb-2 rounded-md border border-base-content/20 bg-base-100/80 p-2 text-xs text-base-content/80"
                                                >
                                                    <p class="font-semibold">
                                                        Replying to {message
                                                            .replyTo.senderName}
                                                    </p>
                                                    {#if message.replyTo.text}
                                                        <p class="truncate">
                                                            {message.replyTo
                                                                .text}
                                                        </p>
                                                    {:else if message.replyTo.imageUrl}
                                                        <p>📷 Image</p>
                                                    {/if}
                                                </div>
                                            {/if}

                                            {#if message.imageUrl}
                                                <img
                                                    src={message.imageUrl}
                                                    alt="message"
                                                    class="mb-2 max-h-72 rounded-lg object-cover"
                                                />
                                            {/if}

                                            {#if message.text}
                                                <p>{message.text}</p>
                                            {/if}

                                            <div
                                                class="mt-2 flex items-center justify-between gap-2 text-[11px] opacity-80"
                                            >
                                                <button
                                                    class="btn btn-ghost btn-xs h-auto min-h-0 px-1 py-0"
                                                    on:click={() =>
                                                        (replyTo = message)}
                                                >
                                                    Reply
                                                </button>
                                                {#if message.sender.id === me?.id}
                                                    <span
                                                        >{renderStatusLabel(
                                                            message.status,
                                                        )}</span
                                                    >
                                                {/if}
                                            </div>
                                        </div>
                                    </div>
                                {/each}
                            {/if}
                        </div>

                        <div class="border-t border-base-300 p-3">
                            {#if activeTypingUsers.length > 0}
                                <p class="mb-2 text-xs text-success">
                                    {activeTypingUsers.join(", ")} typing...
                                </p>
                            {/if}

                            {#if replyTo}
                                <div
                                    class="mb-2 flex items-start justify-between rounded-box border border-base-300 bg-base-200 p-2 text-xs"
                                >
                                    <div class="min-w-0">
                                        <p class="font-semibold">
                                            Replying to {replyTo.sender.id ===
                                            me?.id
                                                ? "yourself"
                                                : replyTo.sender.name}
                                        </p>
                                        <p class="truncate">
                                            {replyTo.text || "📷 Image"}
                                        </p>
                                    </div>
                                    <button
                                        class="btn btn-ghost btn-xs"
                                        on:click={clearReply}>✕</button
                                    >
                                </div>
                            {/if}

                            {#if composerImagePreview}
                                <div
                                    class="mb-2 flex items-start justify-between rounded-box border border-base-300 bg-base-200 p-2"
                                >
                                    <img
                                        src={composerImagePreview}
                                        alt="preview"
                                        class="max-h-32 rounded-md object-cover"
                                    />
                                    <button
                                        class="btn btn-ghost btn-xs"
                                        on:click={clearComposerImage}
                                        >Remove</button
                                    >
                                </div>
                            {/if}

                            <div class="flex w-full gap-2 overflow-hidden">
                                <label
                                    for="image-picker"
                                    class="btn btn-outline shrink-0">📎</label
                                >
                                <input
                                    id="image-picker"
                                    class="hidden"
                                    type="file"
                                    accept="image/*"
                                    on:change={handleImageSelection}
                                />

                                <input
                                    class="input input-bordered min-w-0 flex-1"
                                    bind:value={composerText}
                                    placeholder={`Message #${getDisplayConversationTitle(activeConversation)}`}
                                    on:input={handleComposerInput}
                                    on:keydown={(event) =>
                                        event.key === "Enter" && sendMessage()}
                                />
                                <button
                                    class="btn btn-primary shrink-0"
                                    on:click={sendMessage}>Send</button
                                >
                            </div>
                        </div>
                    </div>
                {/if}
            </section>
        </div>
    {/if}
</main>
