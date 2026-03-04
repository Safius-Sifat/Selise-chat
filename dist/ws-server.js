"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_crypto_1 = require("node:crypto");
const node_http_1 = __importDefault(require("node:http"));
const node_url_1 = require("node:url");
const ws_1 = require("ws");
const PORT = Number(process.env.WS_PORT) || 4000;
const toMessageString = (rawData) => {
    if (typeof rawData === 'string') {
        return rawData;
    }
    if (Buffer.isBuffer(rawData)) {
        return rawData.toString('utf8');
    }
    if (Array.isArray(rawData)) {
        return Buffer.concat(rawData).toString('utf8');
    }
    return Buffer.from(rawData).toString('utf8');
};
const parseMessagePayload = (rawData) => {
    const text = toMessageString(rawData).trim();
    if (!text) {
        return { text: '' };
    }
    try {
        const parsed = JSON.parse(text);
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
            return { text, json: parsed };
        }
    }
    catch {
        // Not JSON, use plain text.
    }
    return { text };
};
const safeSend = (socket, payload) => {
    if (socket.readyState !== ws_1.WebSocket.OPEN) {
        return;
    }
    socket.send(JSON.stringify(payload));
};
const server = node_http_1.default.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        service: 'WS examples',
        routes: ['/ws/echo', '/ws/broadcast', '/ws/group?group=team-a&clientId=alice']
    }));
});
const echoWss = new ws_1.WebSocketServer({ noServer: true });
const broadcastWss = new ws_1.WebSocketServer({ noServer: true });
const groupWss = new ws_1.WebSocketServer({ noServer: true });
echoWss.on('connection', (socket, req) => {
    const clientId = new node_url_1.URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`).searchParams.get('clientId') ?? (0, node_crypto_1.randomUUID)();
    safeSend(socket, {
        type: 'connected',
        mode: 'echo',
        clientId,
        note: 'Only the sender receives responses in this mode.'
    });
    socket.on('message', (rawData) => {
        const { text, json } = parseMessagePayload(rawData);
        const message = typeof json?.message === 'string' ? json.message : text;
        safeSend(socket, {
            type: 'echo',
            mode: 'echo',
            from: clientId,
            message
        });
    });
});
broadcastWss.on('connection', (socket, req) => {
    const clientId = new node_url_1.URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`).searchParams.get('clientId') ?? (0, node_crypto_1.randomUUID)();
    safeSend(socket, {
        type: 'connected',
        mode: 'broadcast',
        clientId,
        note: 'Every connected broadcast client receives each message.'
    });
    socket.on('message', (rawData) => {
        const { text, json } = parseMessagePayload(rawData);
        const message = typeof json?.message === 'string' ? json.message : text;
        const payload = {
            type: 'broadcast',
            mode: 'broadcast',
            from: clientId,
            message
        };
        for (const client of broadcastWss.clients) {
            safeSend(client, payload);
        }
    });
});
const groupBySocket = new Map();
const clientIdBySocket = new Map();
const normalizeGroupName = (value) => {
    if (typeof value !== 'string') {
        return 'default';
    }
    const group = value.trim();
    return group || 'default';
};
const normalizeClientId = (value) => {
    if (typeof value !== 'string') {
        return (0, node_crypto_1.randomUUID)();
    }
    const clientId = value.trim();
    return clientId || (0, node_crypto_1.randomUUID)();
};
const getSocketGroup = (socket) => {
    return groupBySocket.get(socket) ?? 'default';
};
const getSocketClientId = (socket) => {
    return clientIdBySocket.get(socket) ?? 'unknown-client';
};
const listGroupMembers = (group) => {
    const members = [];
    for (const client of groupWss.clients) {
        if (groupBySocket.get(client) === group) {
            const member = clientIdBySocket.get(client);
            if (member) {
                members.push(member);
            }
        }
    }
    return members.sort((left, right) => left.localeCompare(right));
};
const broadcastToGroup = (group, payload) => {
    for (const client of groupWss.clients) {
        if (groupBySocket.get(client) === group) {
            safeSend(client, payload);
        }
    }
};
const emitGroupMembersUpdate = (group) => {
    broadcastToGroup(group, {
        type: 'members-update',
        mode: 'group',
        group,
        members: listGroupMembers(group),
        at: new Date().toISOString()
    });
};
const emitGroupSystemEvent = (group, message) => {
    broadcastToGroup(group, {
        type: 'system',
        mode: 'group',
        group,
        message,
        at: new Date().toISOString()
    });
};
groupWss.on('connection', (socket, req) => {
    const url = new node_url_1.URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const initialGroup = normalizeGroupName(url.searchParams.get('group'));
    const clientId = normalizeClientId(url.searchParams.get('clientId'));
    groupBySocket.set(socket, initialGroup);
    clientIdBySocket.set(socket, clientId);
    safeSend(socket, {
        type: 'connected',
        mode: 'group',
        clientId,
        group: initialGroup,
        members: listGroupMembers(initialGroup),
        at: new Date().toISOString(),
        note: 'Only members of the same group receive group messages.'
    });
    emitGroupSystemEvent(initialGroup, `${clientId} joined #${initialGroup}`);
    emitGroupMembersUpdate(initialGroup);
    socket.on('message', (rawData) => {
        const { text, json } = parseMessagePayload(rawData);
        const messageType = typeof json?.type === 'string' ? json.type : '';
        if (messageType === 'join' && typeof json?.group === 'string') {
            const previousGroup = getSocketGroup(socket);
            const nextGroup = normalizeGroupName(json.group);
            if (nextGroup === previousGroup) {
                safeSend(socket, {
                    type: 'joined',
                    mode: 'group',
                    clientId,
                    group: nextGroup,
                    members: listGroupMembers(nextGroup),
                    at: new Date().toISOString()
                });
                return;
            }
            groupBySocket.set(socket, nextGroup);
            safeSend(socket, {
                type: 'joined',
                mode: 'group',
                clientId,
                previousGroup,
                group: nextGroup,
                members: listGroupMembers(nextGroup),
                at: new Date().toISOString()
            });
            emitGroupSystemEvent(previousGroup, `${clientId} left #${previousGroup}`);
            emitGroupMembersUpdate(previousGroup);
            emitGroupSystemEvent(nextGroup, `${clientId} joined #${nextGroup}`);
            emitGroupMembersUpdate(nextGroup);
            return;
        }
        const currentGroup = getSocketGroup(socket);
        const message = typeof json?.message === 'string' ? json.message.trim() : text;
        if (!message) {
            return;
        }
        const payload = {
            type: 'group-broadcast',
            mode: 'group',
            from: clientId,
            group: currentGroup,
            message,
            at: new Date().toISOString()
        };
        broadcastToGroup(currentGroup, payload);
    });
    socket.on('close', () => {
        const currentGroup = getSocketGroup(socket);
        const currentClientId = getSocketClientId(socket);
        groupBySocket.delete(socket);
        clientIdBySocket.delete(socket);
        emitGroupSystemEvent(currentGroup, `${currentClientId} left #${currentGroup}`);
        emitGroupMembersUpdate(currentGroup);
    });
});
const routeUpgrade = (wss, req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (clientSocket) => {
        wss.emit('connection', clientSocket, req);
    });
};
server.on('upgrade', (req, socket, head) => {
    const host = req.headers.host ?? 'localhost';
    const pathname = new node_url_1.URL(req.url ?? '/', `http://${host}`).pathname;
    if (pathname === '/ws/echo') {
        routeUpgrade(echoWss, req, socket, head);
        return;
    }
    if (pathname === '/ws/broadcast') {
        routeUpgrade(broadcastWss, req, socket, head);
        return;
    }
    if (pathname === '/ws/group') {
        routeUpgrade(groupWss, req, socket, head);
        return;
    }
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
});
server.listen(PORT, () => {
    console.log(`WS server running at ws://localhost:${PORT}`);
    console.log('Modes: /ws/echo, /ws/broadcast, /ws/group');
});
//# sourceMappingURL=ws-server.js.map