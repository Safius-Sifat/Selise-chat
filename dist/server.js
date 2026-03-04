"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_crypto_1 = __importDefault(require("node:crypto"));
const node_http_1 = __importDefault(require("node:http"));
const PORT = Number(process.env.PORT) || 3000;
const NAME = process.env.MY_NAME || 'Safius Sifat';
const info = [
    {
        name: NAME,
        roll: '2103085'
    }
];
const WEB_SOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const createWebSocketAccept = (key) => {
    return node_crypto_1.default.createHash('sha1').update(key + WEB_SOCKET_GUID, 'utf8').digest('base64');
};
const isWebSocketUpgradeRequest = (req) => {
    const upgradeHeader = req.headers.upgrade?.toLowerCase();
    const connectionHeaderValue = Array.isArray(req.headers.connection)
        ? req.headers.connection.join(',')
        : req.headers.connection ?? '';
    const connectionHeader = connectionHeaderValue
        .toLowerCase()
        .split(',')
        .map((part) => part.trim());
    return (upgradeHeader === 'websocket' &&
        connectionHeader.includes('upgrade') &&
        req.headers['sec-websocket-version'] === '13' &&
        typeof req.headers['sec-websocket-key'] === 'string');
};
const parseNameFromPayload = (payload) => {
    const trimmed = payload.trim();
    if (!trimmed) {
        return '';
    }
    try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed === 'string') {
            return parsed.trim();
        }
        if (typeof parsed === 'object' && parsed !== null) {
            const record = parsed;
            const candidate = String(record.name ?? '').trim();
            if (candidate) {
                return candidate;
            }
        }
    }
    catch {
        // ignore and fallback to raw text
    }
    return trimmed;
};
const createGreetingMessage = (name) => {
    return `hi ${name || 'there'}`;
};
const sendWebSocketFrame = (socket, payload, opcode = 0x1) => {
    const length = payload.length;
    let header;
    if (length < 126) {
        header = Buffer.alloc(2);
        header[0] = 0x80 | opcode;
        header[1] = length;
    }
    else if (length < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x80 | opcode;
        header[1] = 126;
        header.writeUInt16BE(length, 2);
    }
    else {
        header = Buffer.alloc(10);
        header[0] = 0x80 | opcode;
        header[1] = 127;
        header.writeUInt32BE(0, 2);
        header.writeUInt32BE(length, 6);
    }
    socket.write(Buffer.concat([header, payload]));
};
const sendGreetingOverSocket = (socket, rawPayload) => {
    const name = parseNameFromPayload(rawPayload);
    const response = createGreetingMessage(name);
    sendWebSocketFrame(socket, Buffer.from(response, 'utf8'));
};
const tryParseWebSocketFrame = (buffer) => {
    if (buffer.length < 2) {
        return null;
    }
    const firstByte = buffer[0];
    const secondByte = buffer[1];
    const opcode = firstByte & 0x0f;
    const masked = (secondByte & 0x80) !== 0;
    let payloadLength = secondByte & 0x7f;
    let offset = 2;
    if (payloadLength === 126) {
        if (buffer.length < offset + 2) {
            return null;
        }
        payloadLength = buffer.readUInt16BE(offset);
        offset += 2;
    }
    else if (payloadLength === 127) {
        if (buffer.length < offset + 8) {
            return null;
        }
        const high = buffer.readUInt32BE(offset);
        const low = buffer.readUInt32BE(offset + 4);
        if (high !== 0) {
            throw new Error('Payload too large to handle');
        }
        payloadLength = low;
        offset += 8;
    }
    const maskOffset = masked ? offset : undefined;
    if (masked) {
        if (buffer.length < offset + 4) {
            return null;
        }
        offset += 4;
    }
    if (buffer.length < offset + payloadLength) {
        return null;
    }
    const payload = Buffer.from(buffer.slice(offset, offset + payloadLength));
    if (masked && maskOffset !== undefined) {
        const mask = buffer.slice(maskOffset, maskOffset + 4);
        for (let i = 0; i < payloadLength; i += 1) {
            payload[i] ^= mask[i % 4];
        }
    }
    return { consumed: offset + payloadLength, opcode, payload };
};
const attachWebSocketHandlers = (socket, initialData) => {
    let buffered = initialData.length ? Buffer.from(initialData) : Buffer.alloc(0);
    const processBuffer = () => {
        let result;
        while ((result = tryParseWebSocketFrame(buffered))) {
            buffered = buffered.slice(result.consumed);
            if (result.opcode === 0x8) {
                // Close frame, reply with close and destroy socket.
                sendWebSocketFrame(socket, Buffer.alloc(0), 0x8);
                socket.end();
                return;
            }
            if (result.opcode === 0x1) {
                sendGreetingOverSocket(socket, result.payload.toString('utf8'));
            }
        }
    };
    socket.on('data', (chunk) => {
        buffered = buffered.length ? Buffer.concat([buffered, chunk]) : Buffer.from(chunk);
        processBuffer();
    });
    socket.on('close', () => {
        console.log('WebSocket client disconnected');
    });
    socket.on('error', (error) => {
        console.error('WebSocket socket error', error);
        socket.destroy();
    });
    processBuffer();
};
const sendJson = (res, statusCode, payload) => {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
};
const parseRequestBody = async (req) => {
    let body = '';
    for await (const chunk of req) {
        body += chunk.toString();
    }
    if (!body) {
        return {};
    }
    return JSON.parse(body);
};
const handleGetRoot = (_req, res) => {
    sendJson(res, 200, {
        name: NAME,
        role: 'Developer',
        project: 'Node HTTP Server (No Framework)',
        timestamp: new Date().toISOString()
    });
};
const handlePostRoot = async (req, res) => {
    try {
        const body = await parseRequestBody(req);
        const roll = String(body.roll ?? '');
        const student = info.find((item) => item.roll === roll);
        if (student) {
            sendJson(res, 200, student);
            return;
        }
        sendJson(res, 404, { error: 'Roll number not found' });
    }
    catch {
        sendJson(res, 400, { error: 'Invalid JSON body' });
    }
};
const handleDeleteRoot = async (req, res) => {
    try {
        const body = await parseRequestBody(req);
        const roll = String(body.roll ?? '');
        const index = info.findIndex((item) => item.roll === roll);
        if (index >= 0) {
            info.splice(index, 1);
            sendJson(res, 200, { message: 'Student deleted successfully' });
            return;
        }
        sendJson(res, 404, { error: 'Roll number not found' });
    }
    catch {
        sendJson(res, 400, { error: 'Invalid JSON body' });
    }
};
const handleNotFound = (_req, res) => {
    sendJson(res, 404, { error: 'Not Found' });
};
const printFunction = (value) => {
    console.log('Printing value:', value);
    return;
};
const handleRequest = async (req, res) => {
    if (req.url !== '/') {
        handleNotFound(req, res);
        return;
    }
    if (req.method === 'GET') {
        handleGetRoot(req, res);
        return;
    }
    if (req.method === 'POST') {
        await handlePostRoot(req, res);
        return;
    }
    if (req.method === 'DELETE') {
        await handleDeleteRoot(req, res);
        return;
    }
    handleNotFound(req, res);
};
const server = node_http_1.default.createServer(async (req, res) => {
    await handleRequest(req, res);
});
server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/' || !isWebSocketUpgradeRequest(req)) {
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
        socket.destroy();
        return;
    }
    const key = req.headers['sec-websocket-key'];
    const acceptKey = createWebSocketAccept(key);
    const responseHeaders = [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${acceptKey}`,
        '\r\n'
    ];
    socket.write(responseHeaders.join('\r\n'));
    console.log('WebSocket client connected');
    attachWebSocketHandlers(socket, head);
});
server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
//# sourceMappingURL=server.js.map