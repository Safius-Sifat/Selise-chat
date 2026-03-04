export type AuthMode = "signin" | "signup";
export type SidebarTab = "chats" | "users" | "groups";
export type MessageStatus = "sending" | "sent" | "delivered" | "seen" | "failed";
export type SocketStatus = "disconnected" | "connecting" | "connected";

export interface ChatUser {
    id: string;
    email: string;
    name: string;
    avatarUrl: string | null;
    online: boolean;
}

export interface ChatMessage {
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

export interface Conversation {
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

export interface GroupConversation extends Conversation {
    isMember: boolean;
    memberCount: number;
}

export interface WsEventPayload {
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
