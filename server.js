const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const NOTES_DIR = path.join(__dirname, 'data', 'notes');
const MAX_BODY_SIZE = 1 * 1024 * 1024; // 1MB

if (!fs.existsSync(NOTES_DIR)) {
    fs.mkdirSync(NOTES_DIR, { recursive: true });
}

function generateId() {
    return Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
}

function isValidId(id) {
    return typeof id === 'string' && /^[a-z0-9]+$/.test(id);
}

async function getNotes() {
    const files = (await fsp.readdir(NOTES_DIR)).filter(f => f.endsWith('.json'));
    const notes = [];
    for (const file of files) {
        try {
            const content = await fsp.readFile(path.join(NOTES_DIR, file), 'utf-8');
            notes.push(JSON.parse(content));
        } catch {
            // 跳过损坏的文件，不影响其他笔记
        }
    }
    return notes;
}

async function getNote(id) {
    const filePath = path.join(NOTES_DIR, `${id}.json`);
    try {
        const content = await fsp.readFile(filePath, 'utf-8');
        return JSON.parse(content);
    } catch {
        return null;
    }
}

async function saveNote(note) {
    const filePath = path.join(NOTES_DIR, `${note.id}.json`);
    await fsp.writeFile(filePath, JSON.stringify(note, null, 2));
}

async function deleteNote(id) {
    const filePath = path.join(NOTES_DIR, `${id}.json`);
    try {
        await fsp.unlink(filePath);
        return true;
    } catch {
        return false;
    }
}

function sendJSON(res, statusCode, data) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

function sendFile(res, filePath, contentType) {
    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404);
            res.end('Not Found');
            return;
        }
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(data);
    });
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        let size = 0;
        req.on('data', chunk => {
            size += chunk.length;
            if (size > MAX_BODY_SIZE) {
                reject(Object.assign(new Error('Body too large'), { status: 413 }));
                req.destroy();
                return;
            }
            body += chunk;
        });
        req.on('end', () => resolve(body));
        req.on('error', reject);
    });
}

function sanitizeString(val, maxLen) {
    return typeof val === 'string' ? val.slice(0, maxLen) : undefined;
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const pathname = url.pathname;

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    try {
        if (pathname === '/api/notes' && req.method === 'GET') {
            const notes = await getNotes();
            sendJSON(res, 200, notes);
            return;
        }

        if (pathname === '/api/notes' && req.method === 'POST') {
            let body;
            try {
                body = JSON.parse(await readBody(req));
            } catch (e) {
                sendJSON(res, e.status === 413 ? 413 : 400, { error: e.status === 413 ? 'Request body too large' : 'Invalid JSON' });
                return;
            }
            const note = {
                id: generateId(),
                title: sanitizeString(body.title, 500) ?? '',
                content: sanitizeString(body.content, 100000) ?? '',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            };
            await saveNote(note);
            sendJSON(res, 201, note);
            return;
        }

        const noteMatch = pathname.match(/^\/api\/notes\/([^/]+)$/);
        if (noteMatch) {
            const id = noteMatch[1];

            if (!isValidId(id)) {
                sendJSON(res, 400, { error: 'Invalid note ID' });
                return;
            }

            if (req.method === 'GET') {
                const note = await getNote(id);
                note ? sendJSON(res, 200, note) : sendJSON(res, 404, { error: 'Note not found' });
                return;
            }

            if (req.method === 'PUT') {
                let body;
                try {
                    body = JSON.parse(await readBody(req));
                } catch (e) {
                    sendJSON(res, e.status === 413 ? 413 : 400, { error: e.status === 413 ? 'Request body too large' : 'Invalid JSON' });
                    return;
                }
                const note = await getNote(id);
                if (!note) {
                    sendJSON(res, 404, { error: 'Note not found' });
                    return;
                }
                const title = sanitizeString(body.title, 500);
                const content = sanitizeString(body.content, 100000);
                if (title !== undefined) note.title = title;
                if (content !== undefined) note.content = content;
                note.updatedAt = new Date().toISOString();
                await saveNote(note);
                sendJSON(res, 200, note);
                return;
            }

            if (req.method === 'DELETE') {
                const deleted = await deleteNote(id);
                deleted ? sendJSON(res, 200, { success: true }) : sendJSON(res, 404, { error: 'Note not found' });
                return;
            }
        }

        if (pathname === '/' || pathname === '/index.html') {
            sendFile(res, path.join(__dirname, 'public', 'index.html'), 'text/html');
            return;
        }

        res.writeHead(404);
        res.end('Not Found');
    } catch (err) {
        console.error('Server error:', err);
        if (!res.headersSent) {
            sendJSON(res, 500, { error: 'Internal server error' });
        }
    }
});

server.listen(PORT, () => {
    console.log(`服务器运行在 http://localhost:${PORT}`);
});
