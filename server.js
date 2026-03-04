const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const NOTES_DIR = path.join(__dirname, 'data', 'notes');

if (!fs.existsSync(NOTES_DIR)) {
    fs.mkdirSync(NOTES_DIR, { recursive: true });
}

function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

function getNotes() {
    const files = fs.readdirSync(NOTES_DIR).filter(f => f.endsWith('.json'));
    return files.map(file => {
        const content = fs.readFileSync(path.join(NOTES_DIR, file), 'utf-8');
        return JSON.parse(content);
    });
}

function getNote(id) {
    const filePath = path.join(NOTES_DIR, `${id}.json`);
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function saveNote(note) {
    const filePath = path.join(NOTES_DIR, `${note.id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(note, null, 2));
}

function deleteNote(id) {
    const filePath = path.join(NOTES_DIR, `${id}.json`);
    if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        return true;
    }
    return false;
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

const server = http.createServer((req, res) => {
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

    if (pathname === '/api/notes' && req.method === 'GET') {
        const notes = getNotes();
        sendJSON(res, 200, notes);
        return;
    }

    if (pathname === '/api/notes' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            const { title, content } = JSON.parse(body);
            const note = {
                id: generateId(),
                title: title || '',
                content: content || '',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            };
            saveNote(note);
            sendJSON(res, 201, note);
        });
        return;
    }

    const noteMatch = pathname.match(/^\/api\/notes\/(.+)$/);
    if (noteMatch) {
        const id = noteMatch[1];

        if (req.method === 'GET') {
            const note = getNote(id);
            if (note) {
                sendJSON(res, 200, note);
            } else {
                sendJSON(res, 404, { error: 'Note not found' });
            }
            return;
        }

        if (req.method === 'PUT') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', () => {
                const { title, content } = JSON.parse(body);
                const note = getNote(id);
                if (note) {
                    note.title = title;
                    note.content = content;
                    note.updatedAt = new Date().toISOString();
                    saveNote(note);
                    sendJSON(res, 200, note);
                } else {
                    sendJSON(res, 404, { error: 'Note not found' });
                }
            });
            return;
        }

        if (req.method === 'DELETE') {
            if (deleteNote(id)) {
                sendJSON(res, 200, { success: true });
            } else {
                sendJSON(res, 404, { error: 'Note not found' });
            }
            return;
        }
    }

    if (pathname === '/' || pathname === '/index.html') {
        sendFile(res, path.join(__dirname, 'public', 'index.html'), 'text/html');
        return;
    }

    res.writeHead(404);
    res.end('Not Found');
});

server.listen(PORT, () => {
    console.log(`服务器运行在 http://localhost:${PORT}`);
});
