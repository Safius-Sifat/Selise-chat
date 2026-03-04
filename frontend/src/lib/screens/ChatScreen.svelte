<script lang="ts">
    import type {
        ChatMessage,
        ChatUser,
        Conversation,
        GroupConversation,
        MessageStatus,
        SidebarTab,
        SocketStatus,
    } from "$lib/types/chat";

    export let me: ChatUser;
    export let wsStatus: SocketStatus = "disconnected";

    export let sidebarTab: SidebarTab = "chats";
    export let conversations: Conversation[] = [];
    export let users: ChatUser[] = [];
    export let groups: GroupConversation[] = [];

    export let usersQuery = "";
    export let groupsQuery = "";
    export let activeConversationId = "";
    export let activeConversation: Conversation | null = null;

    export let messages: ChatMessage[] = [];
    export let loadingMessages = false;
    export let messageContainer: HTMLDivElement | null = null;

    export let composerText = "";
    export let composerImagePreview = "";
    export let replyTo: ChatMessage | null = null;
    export let activeTypingUsers: string[] = [];

    export let newGroupName = "";
    export let newGroupIsPublic = true;
    export let creatingGroup = false;

    export let onSignOut: () => void = () => undefined;
    export let onOpenConversation: (
        conversationId: string,
    ) => Promise<void> | void = () => undefined;
    export let onFetchUsers: () => Promise<void> | void = () => undefined;
    export let onStartDirectChat: (
        userId: string,
    ) => Promise<void> | void = () => undefined;
    export let onFetchGroups: () => Promise<void> | void = () => undefined;
    export let onCreateGroup: () => Promise<void> | void = () => undefined;
    export let onJoinGroup: (groupId: string) => Promise<void> | void = () =>
        undefined;
    export let onLeaveCurrentGroup: () => Promise<void> | void = () =>
        undefined;
    export let onClearReply: () => void = () => undefined;
    export let onClearComposerImage: () => void = () => undefined;
    export let onHandleImageSelection: (event: Event) => void = () => undefined;
    export let onHandleComposerInput: () => void = () => undefined;
    export let onSendMessage: () => Promise<void> | void = () => undefined;

    export let isUserOnline: (userId: string) => boolean = () => false;
    export let getDisplayConversationTitle: (
        conversation: Conversation,
    ) => string = (conversation) => conversation.title;
    export let getConversationSubtitle: (
        conversation: Conversation,
    ) => string = () => "";
    export let formatDate: (value: string) => string = (value) => value;
    export let formatTime: (value: string) => string = (value) => value;
    export let renderStatusLabel: (status: MessageStatus) => string = (
        status,
    ) => status;
</script>

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
                    <button class="btn btn-ghost btn-xs" on:click={onSignOut}
                        >Sign out</button
                    >
                </div>
            </div>

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
                                No conversations yet. Start from Users or
                                Groups.
                            </div>
                        {:else}
                            {#each conversations as conversation}
                                <button
                                    class={`w-full rounded-box border p-3 text-left transition ${activeConversationId === conversation.id ? "border-primary bg-primary/10" : "border-base-300 bg-base-100 hover:bg-base-200"}`}
                                    on:click={() =>
                                        onOpenConversation(conversation.id)}
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
                                                    conversation.lastMessage
                                                        .created,
                                                )}</span
                                            >
                                        {/if}
                                    </div>
                                    <p
                                        class="truncate text-xs text-base-content/70"
                                    >
                                        {getConversationSubtitle(conversation)}
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
                                on:click={onFetchUsers}>Search</button
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
                                            onStartDirectChat(user.id)}
                                    >
                                        Chat
                                    </button>
                                </div>
                            {/each}
                        {/if}
                    </div>
                {:else}
                    <div class="space-y-3">
                        <div class="rounded-box border border-base-300 p-3">
                            <p class="mb-2 text-sm font-medium">Create group</p>
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
                                on:click={onCreateGroup}
                            >
                                {creatingGroup ? "Creating..." : "Create group"}
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
                                on:click={onFetchGroups}>Search</button
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
                                        {group.isPublic ? "Public" : "Private"}
                                    </p>
                                    <div class="flex gap-2">
                                        {#if group.isMember}
                                            <button
                                                class="btn btn-sm btn-primary"
                                                on:click={() =>
                                                    onOpenConversation(
                                                        group.id,
                                                    )}>Open</button
                                            >
                                        {:else}
                                            <button
                                                class="btn btn-sm btn-accent"
                                                on:click={() =>
                                                    onJoinGroup(group.id)}
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
                <div class="hero-content text-center text-base-content/70">
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
                    <div class="flex items-center justify-between gap-3">
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
                                                    member.id !== me?.id,
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
                                    on:click={onLeaveCurrentGroup}
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
                        <div class="hero min-h-[240px] rounded-box bg-base-200">
                            <div
                                class="hero-content text-center text-base-content/70"
                            >
                                <p>
                                    No messages yet. Start the conversation 👋
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
                                        >{formatTime(message.created)}</time
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
                                                Replying to {message.replyTo
                                                    .senderName}
                                            </p>
                                            {#if message.replyTo.text}
                                                <p class="truncate">
                                                    {message.replyTo.text}
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
                                            on:click={() => (replyTo = message)}
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
                                    Replying to {replyTo.sender.id === me?.id
                                        ? "yourself"
                                        : replyTo.sender.name}
                                </p>
                                <p class="truncate">
                                    {replyTo.text || "📷 Image"}
                                </p>
                            </div>
                            <button
                                class="btn btn-ghost btn-xs"
                                on:click={onClearReply}>✕</button
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
                                on:click={onClearComposerImage}>Remove</button
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
                            on:change={onHandleImageSelection}
                        />

                        <input
                            class="input input-bordered min-w-0 flex-1"
                            bind:value={composerText}
                            placeholder={`Message #${getDisplayConversationTitle(activeConversation)}`}
                            on:input={onHandleComposerInput}
                            on:keydown={(event) =>
                                event.key === "Enter" && onSendMessage()}
                        />
                        <button
                            class="btn btn-primary shrink-0"
                            on:click={onSendMessage}>Send</button
                        >
                    </div>
                </div>
            </div>
        {/if}
    </section>
</div>
