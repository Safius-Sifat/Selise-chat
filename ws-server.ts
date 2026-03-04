import http from 'node:http';

import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import PocketBase from 'pocketbase';
import { WebSocket, WebSocketServer, type RawData } from 'ws';

const PORT = Number(process.env.WS_PORT ?? process.env.PORT) || 4000;
const POCKETBASE_URL = process.env.POCKETBASE_URL ?? 'http://127.0.0.1:8090';
const POCKETBASE_ADMIN_EMAIL = process.env.POCKETBASE_ADMIN_EMAIL ?? '';
const POCKETBASE_ADMIN_PASSWORD = process.env.POCKETBASE_ADMIN_PASSWORD ?? '';
const POCKETBASE_AUTO_BOOTSTRAP_SCHEMA = !['0', 'false', 'off', 'no'].includes(
    (process.env.POCKETBASE_AUTO_BOOTSTRAP_SCHEMA ?? 'true').trim().toLowerCase()
);

const USERS_COLLECTION = 'users';
const CONVERSATIONS_COLLECTION = 'conversations';
const MESSAGES_COLLECTION = 'messages';

const pbFileResolver = new PocketBase(POCKETBASE_URL);
const adminPb = new PocketBase(POCKETBASE_URL);

let adminAuthInFlight: Promise<void> | null = null;

class ApiError extends Error {
    statusCode: number;

    constructor(statusCode: number, message: string) {
        super(message);
        this.statusCode = statusCode;
    }
}

type RecordMap = Record<string, unknown>;

type MessageStatus = 'sending' | 'sent' | 'delivered' | 'seen' | 'failed';

interface ApiUser {
    id: string;
    email: string;
    name: string;
    avatarUrl: string | null;
    online: boolean;
}

interface ApiMessage {
    id: string;
    conversationId: string;
    sender: ApiUser;
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

interface ApiConversation {
    id: string;
    type: 'direct' | 'group';
    title: string;
    isPublic: boolean;
    createdBy: string;
    members: ApiUser[];
    memberIds: string[];
    lastMessage: ApiMessage | null;
    created: string;
    updated: string;
}

interface MessageStatusUpdate {
    messageId: string;
    conversationId: string;
    status: MessageStatus;
    deliveredTo: string[];
    seenBy: string[];
}

interface AuthenticatedRequest extends Request {
    authUser?: ApiUser;
    authToken?: string;
}

interface AuthenticatedSocket extends WebSocket {
    userId: string;
}

interface CollectionFieldSpec {
    name: string;
    type: string;
    required?: boolean;
    options?: Record<string, unknown>;
}

const socketsByUserId = new Map<string, Set<AuthenticatedSocket>>();
const typingByConversation = new Map<string, Set<string>>();

const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 15 * 1024 * 1024
    }
});

const app = express();

app.use(
    cors({
        origin: true,
        credentials: true
    })
);
app.use(express.json({ limit: '20mb' }));

const asString = (value: unknown): string => {
    return typeof value === 'string' ? value : '';
};

const asBoolean = (value: unknown): boolean => {
    return typeof value === 'boolean' ? value : false;
};

const asStringArray = (value: unknown): string[] => {
    if (Array.isArray(value)) {
        return value.filter((item): item is string => typeof item === 'string');
    }

    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value) as unknown;

            if (Array.isArray(parsed)) {
                return parsed.filter((item): item is string => typeof item === 'string');
            }
        } catch {
            if (value.trim()) {
                return [value.trim()];
            }
        }
    }

    return [];
};

const toUniqueStringArray = (values: string[]): string[] => {
    return Array.from(new Set(values.filter(Boolean)));
};

const escapeFilterValue = (value: string): string => {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
};

const isNotFoundError = (error: unknown): boolean => {
    if (typeof error !== 'object' || error === null) {
        return false;
    }

    const asError = error as {
        status?: unknown;
        response?: Record<string, unknown>;
    };

    if (asError.status === 404) {
        return true;
    }

    const response = asError.response;

    if (response && response.code === 404) {
        return true;
    }

    return false;
};

const cloneRecordMap = <T>(value: T): T => {
    return JSON.parse(JSON.stringify(value)) as T;
};

const getPocketbaseErrorMessage = (error: unknown): string => {
    if (error instanceof ApiError) {
        return error.message;
    }

    if (error instanceof Error && error.message) {
        return error.message;
    }

    if (typeof error === 'object' && error !== null && 'response' in error) {
        const response = (error as { response?: Record<string, unknown> }).response;

        if (response && typeof response.message === 'string') {
            return response.message;
        }
    }

    return 'Unknown server error';
};

const getFileUrl = (record: RecordMap, fieldName: string): string | null => {
    const fileName = asString(record[fieldName]);

    if (!fileName) {
        return null;
    }

    return pbFileResolver.files.getURL(record as never, fileName);
};

const isUserOnline = (userId: string): boolean => {
    return (socketsByUserId.get(userId)?.size ?? 0) > 0;
};

const toUserDTO = (record: RecordMap): ApiUser => {
    const id = asString(record.id);
    const email = asString(record.email);
    const fallbackName = email.includes('@') ? email.split('@')[0] : `user-${id.slice(0, 5)}`;

    return {
        id,
        email,
        name: asString(record.name) || asString(record.username) || fallbackName,
        avatarUrl: getFileUrl(record, 'avatar'),
        online: isUserOnline(id)
    };
};

const toReplyDTO = (record: RecordMap | null): ApiMessage['replyTo'] => {
    if (!record) {
        return null;
    }

    const expand = (record.expand as RecordMap | undefined) ?? {};
    const sender = (expand.sender as RecordMap | undefined) ?? null;

    return {
        id: asString(record.id),
        text: asString(record.text),
        senderName: sender ? toUserDTO(sender).name : 'unknown',
        imageUrl: getFileUrl(record, 'image')
    };
};

const toMessageDTO = (record: RecordMap): ApiMessage => {
    const expand = (record.expand as RecordMap | undefined) ?? {};
    const senderRecord = (expand.sender as RecordMap | undefined) ?? {
        id: asString(record.sender),
        email: '',
        name: '',
        username: '',
        avatar: ''
    };

    const replyRecord = (expand.replyTo as RecordMap | undefined) ?? null;

    const deliveredTo = toUniqueStringArray(asStringArray(record.deliveredTo));
    const seenBy = toUniqueStringArray(asStringArray(record.seenBy));

    return {
        id: asString(record.id),
        conversationId: asString(record.conversation),
        sender: toUserDTO(senderRecord),
        text: asString(record.text),
        imageUrl: getFileUrl(record, 'image'),
        replyTo: toReplyDTO(replyRecord),
        status: (asString(record.status) as MessageStatus) || 'sent',
        deliveredTo,
        seenBy,
        created: asString(record.created),
        updated: asString(record.updated),
        clientTempId: asString(record.clientTempId) || null
    };
};

const toConversationDTO = (
    record: RecordMap,
    viewerId: string,
    lastMessage: ApiMessage | null
): ApiConversation => {
    const expand = (record.expand as RecordMap | undefined) ?? {};
    const membersExpanded = Array.isArray(expand.members)
        ? (expand.members as RecordMap[])
        : [];

    const memberIds = toUniqueStringArray(asStringArray(record.members));
    const members = membersExpanded.map((memberRecord) => toUserDTO(memberRecord));

    const type = asString(record.type) === 'group' ? 'group' : 'direct';
    const titleFromRecord = asString(record.title);

    let title = titleFromRecord;
    if (!title && type === 'direct') {
        const other = members.find((member) => member.id !== viewerId);
        title = other?.name ?? 'Direct chat';
    }

    if (!title) {
        title = type === 'group' ? 'Untitled Group' : 'Direct chat';
    }

    return {
        id: asString(record.id),
        type,
        title,
        isPublic: asBoolean(record.isPublic),
        createdBy: asString(record.createdBy),
        members,
        memberIds,
        lastMessage,
        created: asString(record.created),
        updated: asString(record.updated)
    };
};

const sendToSocket = (socket: WebSocket, payload: unknown): void => {
    if (socket.readyState !== WebSocket.OPEN) {
        return;
    }

    socket.send(JSON.stringify(payload));
};

const sendToUser = (userId: string, payload: unknown): void => {
    const sockets = socketsByUserId.get(userId);

    if (!sockets || sockets.size === 0) {
        return;
    }

    for (const socket of sockets) {
        sendToSocket(socket, payload);
    }
};

const broadcastToUsers = (userIds: string[], payload: unknown): void => {
    for (const userId of toUniqueStringArray(userIds)) {
        sendToUser(userId, payload);
    }
};

const allOnlineUserIds = (): string[] => {
    return Array.from(socketsByUserId.entries())
        .filter(([, sockets]) => sockets.size > 0)
        .map(([userId]) => userId);
};

const getBearerToken = (request: Request): string => {
    const authorization = request.headers.authorization;

    if (!authorization || !authorization.startsWith('Bearer ')) {
        return '';
    }

    return authorization.replace('Bearer ', '').trim();
};

const ensureAdminAuth = async (): Promise<void> => {
    if (adminPb.authStore.isValid) {
        return;
    }

    if (!POCKETBASE_ADMIN_EMAIL || !POCKETBASE_ADMIN_PASSWORD) {
        throw new ApiError(
            500,
            'Set POCKETBASE_ADMIN_EMAIL and POCKETBASE_ADMIN_PASSWORD to enable server-side PocketBase operations.'
        );
    }

    if (!adminAuthInFlight) {
        adminAuthInFlight = adminPb
            .collection('_superusers')
            .authWithPassword(POCKETBASE_ADMIN_EMAIL, POCKETBASE_ADMIN_PASSWORD)
            .then(() => undefined)
            .finally(() => {
                adminAuthInFlight = null;
            });
    }

    await adminAuthInFlight;
};

const toFieldPayload = (spec: CollectionFieldSpec): RecordMap => {
    return {
        name: spec.name,
        type: spec.type,
        required: spec.required ?? false,
        hidden: false,
        presentable: false,
        system: false,
        options: spec.options ?? {}
    };
};

const buildConversationFieldSpecs = (usersCollectionId: string): CollectionFieldSpec[] => {
    return [
        {
            name: 'type',
            type: 'select',
            required: true,
            options: {
                maxSelect: 1,
                values: ['direct', 'group']
            }
        },
        {
            name: 'title',
            type: 'text',
            required: false,
            options: {
                min: null,
                max: null,
                pattern: ''
            }
        },
        {
            name: 'isPublic',
            type: 'bool',
            required: false,
            options: {}
        },
        {
            name: 'createdBy',
            type: 'relation',
            required: false,
            options: {
                collectionId: usersCollectionId,
                cascadeDelete: false,
                minSelect: 0,
                maxSelect: 1,
                displayFields: []
            }
        },
        {
            name: 'members',
            type: 'relation',
            required: false,
            options: {
                collectionId: usersCollectionId,
                cascadeDelete: false,
                minSelect: 0,
                maxSelect: 999,
                displayFields: []
            }
        },
        {
            name: 'lastMessageAt',
            type: 'date',
            required: false,
            options: {
                min: '',
                max: ''
            }
        }
    ];
};

const buildMessageFieldSpecs = (params: {
    conversationsCollectionId: string;
    usersCollectionId: string;
    messagesCollectionId?: string;
}): CollectionFieldSpec[] => {
    const { conversationsCollectionId, usersCollectionId, messagesCollectionId } = params;

    const specs: CollectionFieldSpec[] = [
        {
            name: 'conversation',
            type: 'relation',
            required: true,
            options: {
                collectionId: conversationsCollectionId,
                cascadeDelete: true,
                minSelect: 1,
                maxSelect: 1,
                displayFields: []
            }
        },
        {
            name: 'sender',
            type: 'relation',
            required: true,
            options: {
                collectionId: usersCollectionId,
                cascadeDelete: false,
                minSelect: 1,
                maxSelect: 1,
                displayFields: []
            }
        },
        {
            name: 'text',
            type: 'text',
            required: false,
            options: {
                min: null,
                max: null,
                pattern: ''
            }
        },
        {
            name: 'image',
            type: 'file',
            required: false,
            options: {
                maxSelect: 1,
                maxSize: 15728640,
                mimeTypes: [],
                thumbs: [],
                protected: false
            }
        },
        {
            name: 'status',
            type: 'select',
            required: false,
            options: {
                maxSelect: 1,
                values: ['sent', 'delivered', 'seen']
            }
        },
        {
            name: 'deliveredTo',
            type: 'json',
            required: false,
            options: {
                maxSize: 0
            }
        },
        {
            name: 'seenBy',
            type: 'json',
            required: false,
            options: {
                maxSize: 0
            }
        },
        {
            name: 'clientTempId',
            type: 'text',
            required: false,
            options: {
                min: null,
                max: null,
                pattern: ''
            }
        }
    ];

    if (messagesCollectionId) {
        specs.push({
            name: 'replyTo',
            type: 'relation',
            required: false,
            options: {
                collectionId: messagesCollectionId,
                cascadeDelete: false,
                minSelect: 0,
                maxSelect: 1,
                displayFields: []
            }
        });
    }

    return specs;
};

const getCollectionByName = async (collectionName: string): Promise<RecordMap | null> => {
    try {
        return (await adminPb.collections.getOne(collectionName)) as unknown as RecordMap;
    } catch (error) {
        if (isNotFoundError(error)) {
            return null;
        }

        throw error;
    }
};

const ensureCollectionFields = async (
    collection: RecordMap,
    desiredFieldSpecs: CollectionFieldSpec[]
): Promise<{ collection: RecordMap; addedFieldNames: string[] }> => {
    const collectionId = asString(collection.id);
    const existingFields = Array.isArray(collection.fields)
        ? (collection.fields as RecordMap[]).map((field) => cloneRecordMap(field))
        : [];

    const existingByName = new Map<string, RecordMap>();
    for (const field of existingFields) {
        const fieldName = asString(field.name);

        if (!fieldName) {
            continue;
        }

        existingByName.set(fieldName, field);
    }

    const addedFieldNames: string[] = [];

    for (const desiredField of desiredFieldSpecs) {
        const existingField = existingByName.get(desiredField.name);

        if (!existingField) {
            existingFields.push(toFieldPayload(desiredField));
            addedFieldNames.push(desiredField.name);
            continue;
        }

        const existingType = asString(existingField.type);
        if (existingType && existingType !== desiredField.type) {
            console.warn(
                `[schema bootstrap] Field type mismatch in "${asString(collection.name)}.${desiredField.name}" ` +
                `(existing: ${existingType}, expected: ${desiredField.type}). Keeping existing field.`
            );
        }
    }

    if (addedFieldNames.length === 0) {
        return {
            collection,
            addedFieldNames
        };
    }

    await adminPb.collections.update(collectionId, {
        fields: existingFields
    });

    const refreshed = (await adminPb.collections.getOne(collectionId)) as unknown as RecordMap;

    return {
        collection: refreshed,
        addedFieldNames
    };
};

const ensureBaseCollection = async (
    collectionName: string,
    desiredFieldSpecs: CollectionFieldSpec[]
): Promise<RecordMap> => {
    let collection = await getCollectionByName(collectionName);

    if (!collection) {
        collection = (await adminPb.collections.create({
            name: collectionName,
            type: 'base',
            fields: desiredFieldSpecs.map((field) => toFieldPayload(field))
        })) as unknown as RecordMap;

        console.log(`[schema bootstrap] Created collection "${collectionName}".`);
        return collection;
    }

    const { collection: updatedCollection, addedFieldNames } = await ensureCollectionFields(
        collection,
        desiredFieldSpecs
    );

    if (addedFieldNames.length > 0) {
        console.log(
            `[schema bootstrap] Added missing fields to "${collectionName}": ${addedFieldNames.join(', ')}.`
        );
    }

    return updatedCollection;
};

const bootstrapPocketbaseSchema = async (): Promise<void> => {
    const usersCollection = await adminPb.collections.getOne(USERS_COLLECTION);
    const usersCollectionId = asString((usersCollection as unknown as RecordMap).id);

    if (!usersCollectionId) {
        throw new ApiError(
            500,
            'Could not resolve the built-in users collection id while bootstrapping schema.'
        );
    }

    const conversationsCollection = await ensureBaseCollection(
        CONVERSATIONS_COLLECTION,
        buildConversationFieldSpecs(usersCollectionId)
    );

    const conversationsCollectionId = asString(conversationsCollection.id);

    if (!conversationsCollectionId) {
        throw new ApiError(500, 'Could not resolve conversations collection id after bootstrap.');
    }

    let messagesCollection = await ensureBaseCollection(
        MESSAGES_COLLECTION,
        buildMessageFieldSpecs({
            conversationsCollectionId,
            usersCollectionId
        })
    );

    const messagesCollectionId = asString(messagesCollection.id);

    if (!messagesCollectionId) {
        throw new ApiError(500, 'Could not resolve messages collection id after bootstrap.');
    }

    const messageFieldsWithReply = buildMessageFieldSpecs({
        conversationsCollectionId,
        usersCollectionId,
        messagesCollectionId
    });

    const ensuredMessagesResult = await ensureCollectionFields(messagesCollection, messageFieldsWithReply);
    messagesCollection = ensuredMessagesResult.collection;

    if (ensuredMessagesResult.addedFieldNames.length > 0) {
        console.log(
            `[schema bootstrap] Added missing fields to "${MESSAGES_COLLECTION}": ${ensuredMessagesResult.addedFieldNames.join(', ')}.`
        );
    }

    console.log('[schema bootstrap] PocketBase chat schema bootstrap completed.');
};

const validateUserToken = async (token: string): Promise<ApiUser> => {
    if (!token) {
        throw new ApiError(401, 'Missing token');
    }

    const pb = new PocketBase(POCKETBASE_URL);
    pb.authStore.save(token, null as never);

    const authRefreshResult = await pb.collection(USERS_COLLECTION).authRefresh();
    const userRecord = authRefreshResult.record as unknown as RecordMap;

    return toUserDTO(userRecord);
};

const requireAuth = async (
    request: AuthenticatedRequest,
    _response: Response,
    next: NextFunction
): Promise<void> => {
    try {
        const token = getBearerToken(request);
        const user = await validateUserToken(token);

        request.authToken = token;
        request.authUser = user;
        next();
    } catch {
        next(new ApiError(401, 'Unauthorized'));
    }
};

const asyncHandler = <TRequest extends Request>(
    handler: (request: TRequest, response: Response) => Promise<void>
): ((request: Request, response: Response, next: NextFunction) => void) => {
    return (request: Request, response: Response, next: NextFunction): void => {
        handler(request as TRequest, response).catch(next);
    };
};

const getConversationRecord = async (conversationId: string): Promise<RecordMap> => {
    await ensureAdminAuth();

    return (await adminPb.collection(CONVERSATIONS_COLLECTION).getOne(conversationId, {
        expand: 'members,createdBy'
    })) as unknown as RecordMap;
};

const getConversationMemberIds = (conversationRecord: RecordMap): string[] => {
    return toUniqueStringArray(asStringArray(conversationRecord.members));
};

const ensureConversationMembership = async (
    conversationId: string,
    userId: string
): Promise<RecordMap> => {
    const conversation = await getConversationRecord(conversationId);
    const members = getConversationMemberIds(conversation);

    if (!members.includes(userId)) {
        throw new ApiError(403, 'You are not a member of this conversation');
    }

    return conversation;
};

const getLatestConversationMessage = async (
    conversationId: string
): Promise<ApiMessage | null> => {
    await ensureAdminAuth();

    try {
        const record = (await adminPb.collection(MESSAGES_COLLECTION).getFirstListItem(
            `conversation = "${escapeFilterValue(conversationId)}"`,
            {
                sort: '-created',
                expand: 'sender,replyTo,replyTo.sender'
            }
        )) as unknown as RecordMap;

        return toMessageDTO(record);
    } catch {
        return null;
    }
};

const markConversationSeen = async (
    conversationRecord: RecordMap,
    viewerId: string
): Promise<MessageStatusUpdate[]> => {
    await ensureAdminAuth();

    const conversationId = asString(conversationRecord.id);
    const memberIds = getConversationMemberIds(conversationRecord);

    const records = (await adminPb.collection(MESSAGES_COLLECTION).getFullList({
        filter: `conversation = "${escapeFilterValue(conversationId)}" && sender != "${escapeFilterValue(viewerId)}"`,
        sort: '-created'
    })) as unknown as RecordMap[];

    const recentMessages = records.slice(0, 120);
    const updates: MessageStatusUpdate[] = [];

    for (const record of recentMessages) {
        const recordId = asString(record.id);
        const senderId = asString(record.sender);

        const deliveredTo = toUniqueStringArray([
            ...asStringArray(record.deliveredTo),
            viewerId
        ]);
        const seenBy = toUniqueStringArray([...asStringArray(record.seenBy), viewerId]);

        const others = memberIds.filter((memberId) => memberId !== senderId);
        const allOthersSeen = others.every((memberId) => seenBy.includes(memberId));

        const nextStatus: MessageStatus = allOthersSeen && others.length > 0 ? 'seen' : 'delivered';

        const beforeDeliveredTo = asStringArray(record.deliveredTo);
        const beforeSeenBy = asStringArray(record.seenBy);
        const beforeStatus = (asString(record.status) as MessageStatus) || 'sent';

        const changed =
            beforeStatus !== nextStatus ||
            beforeDeliveredTo.length !== deliveredTo.length ||
            beforeSeenBy.length !== seenBy.length;

        if (!changed) {
            continue;
        }

        await adminPb.collection(MESSAGES_COLLECTION).update(recordId, {
            status: nextStatus,
            deliveredTo,
            seenBy
        });

        updates.push({
            messageId: recordId,
            conversationId,
            status: nextStatus,
            deliveredTo,
            seenBy
        });
    }

    return updates;
};

const markDeliveredForUser = async (userId: string): Promise<void> => {
    await ensureAdminAuth();

    const conversations = (await adminPb.collection(CONVERSATIONS_COLLECTION).getFullList({
        filter: `members ?= "${escapeFilterValue(userId)}"`
    })) as unknown as RecordMap[];

    for (const conversation of conversations) {
        const conversationId = asString(conversation.id);
        const memberIds = getConversationMemberIds(conversation);

        const records = (await adminPb.collection(MESSAGES_COLLECTION).getFullList({
            filter: `conversation = "${escapeFilterValue(conversationId)}" && sender != "${escapeFilterValue(userId)}"`,
            sort: '-created'
        })) as unknown as RecordMap[];

        const updates: MessageStatusUpdate[] = [];

        for (const record of records.slice(0, 100)) {
            const recordId = asString(record.id);
            const senderId = asString(record.sender);

            const deliveredTo = toUniqueStringArray([
                ...asStringArray(record.deliveredTo),
                userId
            ]);
            const seenBy = toUniqueStringArray(asStringArray(record.seenBy));

            const others = memberIds.filter((memberId) => memberId !== senderId);
            const allOthersSeen = others.every((memberId) => seenBy.includes(memberId));
            const nextStatus: MessageStatus = allOthersSeen && others.length > 0 ? 'seen' : 'delivered';

            const beforeDeliveredTo = asStringArray(record.deliveredTo);

            if (beforeDeliveredTo.length === deliveredTo.length && asString(record.status) === nextStatus) {
                continue;
            }

            await adminPb.collection(MESSAGES_COLLECTION).update(recordId, {
                status: nextStatus,
                deliveredTo,
                seenBy
            });

            updates.push({
                messageId: recordId,
                conversationId,
                status: nextStatus,
                deliveredTo,
                seenBy
            });
        }

        if (updates.length > 0) {
            broadcastToUsers(memberIds, {
                type: 'message:status-bulk',
                conversationId,
                updates
            });
        }
    }
};

const createMessageRecord = async (params: {
    conversationId: string;
    senderId: string;
    text: string;
    replyToId?: string;
    file?: Express.Multer.File;
    clientTempId?: string;
}): Promise<RecordMap> => {
    const { conversationId, senderId, text, replyToId, file, clientTempId } = params;

    const formData = new FormData();
    formData.append('conversation', conversationId);
    formData.append('sender', senderId);
    formData.append('text', text);
    formData.append('status', 'sent');
    formData.append('deliveredTo', JSON.stringify([senderId]));
    formData.append('seenBy', JSON.stringify([senderId]));

    if (replyToId) {
        formData.append('replyTo', replyToId);
    }

    if (clientTempId) {
        formData.append('clientTempId', clientTempId);
    }

    if (file) {
        const blob = new Blob([new Uint8Array(file.buffer)], {
            type: file.mimetype || 'application/octet-stream'
        });
        formData.append('image', blob, file.originalname || `upload-${Date.now()}`);
    }

    const record = (await adminPb.collection(MESSAGES_COLLECTION).create(formData, {
        expand: 'sender,replyTo,replyTo.sender'
    })) as unknown as RecordMap;

    return record;
};

const emitConversationUpsert = async (
    conversationRecord: RecordMap,
    viewerIds: string[]
): Promise<void> => {
    const latestMessage = await getLatestConversationMessage(asString(conversationRecord.id));

    for (const viewerId of viewerIds) {
        sendToUser(viewerId, {
            type: 'conversation:upsert',
            conversation: toConversationDTO(conversationRecord, viewerId, latestMessage)
        });
    }
};

app.get('/api/health', (_request, response) => {
    response.json({
        ok: true,
        service: 'PocketBase WhatsApp-like chat backend',
        pocketbaseUrl: POCKETBASE_URL,
        schemaAutoBootstrap: POCKETBASE_AUTO_BOOTSTRAP_SCHEMA,
        now: new Date().toISOString()
    });
});

app.post(
    '/api/auth/signup',
    asyncHandler(async (request, response) => {
        const body = request.body as RecordMap;
        const email = asString(body.email).trim().toLowerCase();
        const password = asString(body.password);
        const passwordConfirm = asString(body.passwordConfirm) || password;
        const name = asString(body.name).trim();

        if (!email || !password) {
            throw new ApiError(400, 'Email and password are required');
        }

        const usernameBase =
            (email.split('@')[0] || 'user').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 20) || 'user';
        const username = `${usernameBase}_${Math.floor(Math.random() * 9999)}`;

        const userPb = new PocketBase(POCKETBASE_URL);
        await userPb.collection(USERS_COLLECTION).create({
            email,
            password,
            passwordConfirm,
            name: name || usernameBase,
            username
        });

        const authResult = await userPb.collection(USERS_COLLECTION).authWithPassword(email, password);
        const user = toUserDTO(authResult.record as unknown as RecordMap);

        response.status(201).json({
            token: authResult.token,
            user
        });
    })
);

app.post(
    '/api/auth/signin',
    asyncHandler(async (request, response) => {
        const body = request.body as RecordMap;
        const email = asString(body.email).trim().toLowerCase();
        const password = asString(body.password);

        if (!email || !password) {
            throw new ApiError(400, 'Email and password are required');
        }

        const userPb = new PocketBase(POCKETBASE_URL);
        const authResult = await userPb.collection(USERS_COLLECTION).authWithPassword(email, password);

        response.json({
            token: authResult.token,
            user: toUserDTO(authResult.record as unknown as RecordMap)
        });
    })
);

app.get(
    '/api/auth/me',
    requireAuth,
    asyncHandler(async (request: AuthenticatedRequest, response) => {
        response.json({
            user: request.authUser
        });
    })
);

app.get(
    '/api/users',
    requireAuth,
    asyncHandler(async (request: AuthenticatedRequest, response) => {
        await ensureAdminAuth();

        const me = request.authUser as ApiUser;
        const query = asString(request.query.search).trim().toLowerCase();

        const records = (await adminPb.collection(USERS_COLLECTION).getFullList({
            sort: 'name'
        })) as unknown as RecordMap[];

        const items = records
            .filter((record) => asString(record.id) !== me.id)
            .map((record) => toUserDTO(record))
            .filter((user) => {
                if (!query) {
                    return true;
                }

                return `${user.name} ${user.email}`.toLowerCase().includes(query);
            })
            .slice(0, 100);

        response.json({ items });
    })
);

app.get(
    '/api/conversations',
    requireAuth,
    asyncHandler(async (request: AuthenticatedRequest, response) => {
        await ensureAdminAuth();

        const me = request.authUser as ApiUser;

        const records = (await adminPb.collection(CONVERSATIONS_COLLECTION).getFullList({
            filter: `members ?= "${escapeFilterValue(me.id)}"`,
            sort: '-updated',
            expand: 'members,createdBy'
        })) as unknown as RecordMap[];

        const items = await Promise.all(
            records.map(async (record) => {
                const latestMessage = await getLatestConversationMessage(asString(record.id));
                return toConversationDTO(record, me.id, latestMessage);
            })
        );

        response.json({ items });
    })
);

app.post(
    '/api/conversations/direct/:otherUserId',
    requireAuth,
    asyncHandler(async (request: AuthenticatedRequest, response) => {
        await ensureAdminAuth();

        const me = request.authUser as ApiUser;
        const otherUserId = asString(request.params.otherUserId).trim();

        if (!otherUserId) {
            throw new ApiError(400, 'Target user is required');
        }

        if (otherUserId === me.id) {
            throw new ApiError(400, 'Cannot create direct chat with yourself');
        }

        const filter =
            `type = "direct" && ` +
            `members ?= "${escapeFilterValue(me.id)}" && ` +
            `members ?= "${escapeFilterValue(otherUserId)}"`;

        let conversationRecord: RecordMap;

        try {
            conversationRecord = (await adminPb.collection(CONVERSATIONS_COLLECTION).getFirstListItem(filter, {
                expand: 'members,createdBy'
            })) as unknown as RecordMap;
        } catch {
            const created = (await adminPb.collection(CONVERSATIONS_COLLECTION).create({
                type: 'direct',
                title: '',
                isPublic: false,
                createdBy: me.id,
                members: [me.id, otherUserId],
                lastMessageAt: new Date().toISOString()
            })) as unknown as RecordMap;

            conversationRecord = await getConversationRecord(asString(created.id));
        }

        const latestMessage = await getLatestConversationMessage(asString(conversationRecord.id));
        const conversationDto = toConversationDTO(conversationRecord, me.id, latestMessage);

        const memberIds = getConversationMemberIds(conversationRecord);
        await emitConversationUpsert(conversationRecord, memberIds);

        response.json({ item: conversationDto });
    })
);

app.get(
    '/api/groups',
    requireAuth,
    asyncHandler(async (request: AuthenticatedRequest, response) => {
        await ensureAdminAuth();

        const me = request.authUser as ApiUser;
        const query = asString(request.query.search).trim().toLowerCase();

        const records = (await adminPb.collection(CONVERSATIONS_COLLECTION).getFullList({
            filter: 'type = "group"',
            sort: '-updated',
            expand: 'members,createdBy'
        })) as unknown as RecordMap[];

        const filtered = records.filter((record) => {
            const title = asString(record.title).toLowerCase();
            const memberIds = getConversationMemberIds(record);
            const isMember = memberIds.includes(me.id);
            const isPublic = asBoolean(record.isPublic);

            if (!isPublic && !isMember) {
                return false;
            }

            if (!query) {
                return true;
            }

            return title.includes(query);
        });

        const items = await Promise.all(
            filtered.map(async (record) => {
                const latestMessage = await getLatestConversationMessage(asString(record.id));
                const conversation = toConversationDTO(record, me.id, latestMessage);

                return {
                    ...conversation,
                    isMember: conversation.memberIds.includes(me.id),
                    memberCount: conversation.memberIds.length
                };
            })
        );

        response.json({ items });
    })
);

app.post(
    '/api/groups',
    requireAuth,
    asyncHandler(async (request: AuthenticatedRequest, response) => {
        await ensureAdminAuth();

        const me = request.authUser as ApiUser;
        const body = request.body as RecordMap;
        const title = asString(body.title).trim();
        const isPublic = body.isPublic === undefined ? true : asBoolean(body.isPublic);
        const requestedMembers = asStringArray(body.memberIds);

        if (!title) {
            throw new ApiError(400, 'Group title is required');
        }

        const members = toUniqueStringArray([me.id, ...requestedMembers]);

        const created = (await adminPb.collection(CONVERSATIONS_COLLECTION).create({
            type: 'group',
            title,
            isPublic,
            createdBy: me.id,
            members,
            lastMessageAt: new Date().toISOString()
        })) as unknown as RecordMap;

        const conversationRecord = await getConversationRecord(asString(created.id));
        const latestMessage = await getLatestConversationMessage(asString(conversationRecord.id));

        await emitConversationUpsert(conversationRecord, members);

        response.status(201).json({
            item: toConversationDTO(conversationRecord, me.id, latestMessage)
        });
    })
);

app.post(
    '/api/groups/:groupId/join',
    requireAuth,
    asyncHandler(async (request: AuthenticatedRequest, response) => {
        await ensureAdminAuth();

        const me = request.authUser as ApiUser;
        const groupId = asString(request.params.groupId);

        const record = await getConversationRecord(groupId);

        if (asString(record.type) !== 'group') {
            throw new ApiError(400, 'Conversation is not a group');
        }

        const members = toUniqueStringArray([...getConversationMemberIds(record), me.id]);

        await adminPb.collection(CONVERSATIONS_COLLECTION).update(groupId, {
            members
        });

        const updatedRecord = await getConversationRecord(groupId);

        await emitConversationUpsert(updatedRecord, members);

        broadcastToUsers(members, {
            type: 'system',
            conversationId: groupId,
            message: `${me.name} joined the group`
        });

        response.json({
            item: toConversationDTO(updatedRecord, me.id, await getLatestConversationMessage(groupId))
        });
    })
);

app.post(
    '/api/groups/:groupId/leave',
    requireAuth,
    asyncHandler(async (request: AuthenticatedRequest, response) => {
        await ensureAdminAuth();

        const me = request.authUser as ApiUser;
        const groupId = asString(request.params.groupId);

        const record = await getConversationRecord(groupId);

        if (asString(record.type) !== 'group') {
            throw new ApiError(400, 'Conversation is not a group');
        }

        const membersBefore = getConversationMemberIds(record);

        if (!membersBefore.includes(me.id)) {
            response.json({ ok: true });
            return;
        }

        const membersAfter = membersBefore.filter((memberId) => memberId !== me.id);

        await adminPb.collection(CONVERSATIONS_COLLECTION).update(groupId, {
            members: membersAfter
        });

        const updatedRecord = await getConversationRecord(groupId);

        await emitConversationUpsert(updatedRecord, membersAfter);

        sendToUser(me.id, {
            type: 'conversation:removed',
            conversationId: groupId
        });

        broadcastToUsers(membersAfter, {
            type: 'system',
            conversationId: groupId,
            message: `${me.name} left the group`
        });

        response.json({ ok: true });
    })
);

app.get(
    '/api/groups/:groupId/members',
    requireAuth,
    asyncHandler(async (request: AuthenticatedRequest, response) => {
        const me = request.authUser as ApiUser;
        const record = await ensureConversationMembership(asString(request.params.groupId), me.id);

        if (asString(record.type) !== 'group') {
            throw new ApiError(400, 'Conversation is not a group');
        }

        const expand = (record.expand as RecordMap | undefined) ?? {};
        const membersExpanded = Array.isArray(expand.members)
            ? (expand.members as RecordMap[])
            : [];

        response.json({
            items: membersExpanded.map((memberRecord) => toUserDTO(memberRecord))
        });
    })
);

app.get(
    '/api/conversations/:conversationId/messages',
    requireAuth,
    asyncHandler(async (request: AuthenticatedRequest, response) => {
        await ensureAdminAuth();

        const me = request.authUser as ApiUser;
        const conversationId = asString(request.params.conversationId);

        await ensureConversationMembership(conversationId, me.id);

        const page = Math.max(Number(request.query.page) || 1, 1);
        const perPage = Math.min(Math.max(Number(request.query.perPage) || 40, 1), 100);

        const listResult = (await adminPb.collection(MESSAGES_COLLECTION).getList(page, perPage, {
            filter: `conversation = "${escapeFilterValue(conversationId)}"`,
            sort: '-created',
            expand: 'sender,replyTo,replyTo.sender'
        })) as unknown as {
            page: number;
            perPage: number;
            totalItems: number;
            totalPages: number;
            items: RecordMap[];
        };

        response.json({
            page: listResult.page,
            perPage: listResult.perPage,
            totalItems: listResult.totalItems,
            totalPages: listResult.totalPages,
            items: [...listResult.items].reverse().map((record) => toMessageDTO(record))
        });
    })
);

app.post(
    '/api/conversations/:conversationId/messages',
    requireAuth,
    upload.single('image'),
    asyncHandler(async (request: AuthenticatedRequest, response) => {
        await ensureAdminAuth();

        const me = request.authUser as ApiUser;
        const conversationId = asString(request.params.conversationId);
        const conversationRecord = await ensureConversationMembership(conversationId, me.id);

        const text = asString(request.body.text).trim();
        const replyToId = asString(request.body.replyTo).trim();
        const clientTempId = asString(request.body.clientTempId).trim();

        if (!text && !request.file) {
            throw new ApiError(400, 'Message text or image is required');
        }

        const created = await createMessageRecord({
            conversationId,
            senderId: me.id,
            text,
            replyToId: replyToId || undefined,
            file: request.file ?? undefined,
            clientTempId: clientTempId || undefined
        });

        const memberIds = getConversationMemberIds(conversationRecord);
        const onlineRecipients = memberIds.filter(
            (memberId) => memberId !== me.id && isUserOnline(memberId)
        );

        let messageRecord = created;

        if (onlineRecipients.length > 0) {
            const deliveredTo = toUniqueStringArray([me.id, ...onlineRecipients]);

            messageRecord = (await adminPb.collection(MESSAGES_COLLECTION).update(asString(created.id), {
                status: 'delivered',
                deliveredTo
            }, {
                expand: 'sender,replyTo,replyTo.sender'
            })) as unknown as RecordMap;
        }

        await adminPb.collection(CONVERSATIONS_COLLECTION).update(conversationId, {
            lastMessageAt: new Date().toISOString()
        });

        const messageDto = toMessageDTO(messageRecord);
        const conversationAfter = await getConversationRecord(conversationId);

        await emitConversationUpsert(conversationAfter, memberIds);

        broadcastToUsers(memberIds, {
            type: 'message:new',
            conversationId,
            message: messageDto
        });

        response.status(201).json({ item: messageDto });
    })
);

app.post(
    '/api/conversations/:conversationId/seen',
    requireAuth,
    asyncHandler(async (request: AuthenticatedRequest, response) => {
        await ensureAdminAuth();

        const me = request.authUser as ApiUser;
        const conversationId = asString(request.params.conversationId);
        const conversationRecord = await ensureConversationMembership(conversationId, me.id);
        const memberIds = getConversationMemberIds(conversationRecord);

        const updates = await markConversationSeen(conversationRecord, me.id);

        if (updates.length > 0) {
            broadcastToUsers(memberIds, {
                type: 'message:status-bulk',
                conversationId,
                updates
            });
        }

        response.json({ updated: updates.length });
    })
);

app.use(
    (error: unknown, _request: Request, response: Response, _next: NextFunction): void => {
        if (error instanceof ApiError) {
            response.status(error.statusCode).json({
                error: error.message
            });
            return;
        }

        response.status(500).json({
            error: getPocketbaseErrorMessage(error)
        });
    }
);

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

const addSocketForUser = (userId: string, socket: AuthenticatedSocket): void => {
    const sockets = socketsByUserId.get(userId) ?? new Set<AuthenticatedSocket>();
    sockets.add(socket);
    socketsByUserId.set(userId, sockets);
};

const removeSocketForUser = (userId: string, socket: AuthenticatedSocket): void => {
    const sockets = socketsByUserId.get(userId);

    if (!sockets) {
        return;
    }

    sockets.delete(socket);

    if (sockets.size === 0) {
        socketsByUserId.delete(userId);
    }
};

const removeUserFromTypingState = (userId: string): void => {
    for (const [conversationId, typingUsers] of typingByConversation.entries()) {
        if (!typingUsers.has(userId)) {
            continue;
        }

        typingUsers.delete(userId);

        if (typingUsers.size === 0) {
            typingByConversation.delete(conversationId);
        }

        broadcastToUsers(allOnlineUserIds(), {
            type: 'typing:update',
            conversationId,
            userId,
            isTyping: false
        });
    }
};

const parseWsEvent = (rawData: RawData): RecordMap | null => {
    try {
        const text =
            typeof rawData === 'string'
                ? rawData
                : Buffer.isBuffer(rawData)
                    ? rawData.toString('utf8')
                    : Array.isArray(rawData)
                        ? Buffer.concat(rawData).toString('utf8')
                        : Buffer.from(rawData).toString('utf8');

        return JSON.parse(text) as RecordMap;
    } catch {
        return null;
    }
};

const handleTypingEvent = async (
    socket: AuthenticatedSocket,
    event: RecordMap
): Promise<void> => {
    await ensureAdminAuth();

    const conversationId = asString(event.conversationId).trim();

    if (!conversationId) {
        return;
    }

    const conversationRecord = await ensureConversationMembership(conversationId, socket.userId);
    const memberIds = getConversationMemberIds(conversationRecord);

    const typingUsers = typingByConversation.get(conversationId) ?? new Set<string>();
    const isTyping = asBoolean(event.isTyping);

    if (isTyping) {
        typingUsers.add(socket.userId);
    } else {
        typingUsers.delete(socket.userId);
    }

    if (typingUsers.size === 0) {
        typingByConversation.delete(conversationId);
    } else {
        typingByConversation.set(conversationId, typingUsers);
    }

    broadcastToUsers(memberIds.filter((memberId) => memberId !== socket.userId), {
        type: 'typing:update',
        conversationId,
        userId: socket.userId,
        isTyping
    });
};

const handleSeenEvent = async (socket: AuthenticatedSocket, event: RecordMap): Promise<void> => {
    await ensureAdminAuth();

    const conversationId = asString(event.conversationId).trim();

    if (!conversationId) {
        return;
    }

    const conversationRecord = await ensureConversationMembership(conversationId, socket.userId);
    const memberIds = getConversationMemberIds(conversationRecord);
    const updates = await markConversationSeen(conversationRecord, socket.userId);

    if (updates.length > 0) {
        broadcastToUsers(memberIds, {
            type: 'message:status-bulk',
            conversationId,
            updates
        });
    }
};

wss.on('connection', (socket: WebSocket) => {
    const authSocket = socket as AuthenticatedSocket;
    const userId = authSocket.userId;

    addSocketForUser(userId, authSocket);

    sendToSocket(authSocket, {
        type: 'hello',
        userId,
        onlineUserIds: allOnlineUserIds()
    });

    broadcastToUsers(allOnlineUserIds(), {
        type: 'presence:update',
        userId,
        online: true
    });

    void markDeliveredForUser(userId).catch(() => {
        // no-op
    });

    authSocket.on('message', (rawData) => {
        const event = parseWsEvent(rawData);

        if (!event || typeof event.type !== 'string') {
            return;
        }

        if (event.type === 'typing') {
            void handleTypingEvent(authSocket, event).catch(() => {
                // no-op
            });
            return;
        }

        if (event.type === 'seen') {
            void handleSeenEvent(authSocket, event).catch(() => {
                // no-op
            });
        }
    });

    authSocket.on('close', () => {
        removeSocketForUser(userId, authSocket);
        removeUserFromTypingState(userId);

        if (!isUserOnline(userId)) {
            broadcastToUsers(allOnlineUserIds(), {
                type: 'presence:update',
                userId,
                online: false
            });
        }
    });
});

server.on('upgrade', async (request, socket, head) => {
    const host = request.headers.host ?? 'localhost';
    const url = new URL(request.url ?? '/', `http://${host}`);

    if (url.pathname !== '/ws/chat') {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
    }

    const token = url.searchParams.get('token') ?? '';

    try {
        const user = await validateUserToken(token);

        wss.handleUpgrade(request, socket, head, (websocket) => {
            const authenticatedSocket = websocket as AuthenticatedSocket;
            authenticatedSocket.userId = user.id;
            wss.emit('connection', authenticatedSocket, request);
        });
    } catch {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
    }
});

server.listen(PORT, async () => {
    try {
        await ensureAdminAuth();
        console.log('PocketBase admin authentication succeeded.');

        if (POCKETBASE_AUTO_BOOTSTRAP_SCHEMA) {
            await bootstrapPocketbaseSchema();
        } else {
            console.log(
                'PocketBase schema bootstrap disabled (set POCKETBASE_AUTO_BOOTSTRAP_SCHEMA=true to enable).'
            );
        }
    } catch (error) {
        console.error('PocketBase admin authentication failed:', getPocketbaseErrorMessage(error));
    }

    console.log(`Chat backend running on http://localhost:${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/api/health`);
    console.log(`WebSocket endpoint: ws://localhost:${PORT}/ws/chat?token=<pocketbase_user_token>`);
});
