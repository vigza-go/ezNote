const http = require('http')
const fs = require('fs')
const fsp = fs.promises
const path = require('path')
const crypto = require('crypto')
const zlib = require('zlib')
const Y = require('yjs')
const { WebSocketServer } = require('ws')
const encoding = require('lib0/encoding')
const decoding = require('lib0/decoding')
const syncProtocol = require('y-protocols/sync')
const awarenessProtocol = require('y-protocols/awareness')

const PORT = process.env.PORT || 3000
const NOTES_DIR = path.join(__dirname, 'data', 'notes')
const IMAGES_DIR = path.join(__dirname, 'data', 'images')
const YJS_DIR = path.join(__dirname, 'data', 'yjs')
const MAX_BODY_SIZE = 1 * 1024 * 1024
const MAX_UPLOAD_SIZE = 3 * 1024 * 1024
const SAVE_DEBOUNCE_MS = 2000

const messageSync = 0
const messageAwareness = 1
const messageAuth = 2
const messageQueryAwareness = 3

process.on('uncaughtException', (err) => console.error('未捕获的异常:', err))
process.on('unhandledRejection', (reason) => console.error('未处理的 Promise rejection:', reason))

;[NOTES_DIR, IMAGES_DIR, YJS_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
})

function generateId() {
    return Date.now().toString(36) + crypto.randomBytes(4).toString('hex')
}

function isValidId(id) {
    return typeof id === 'string' && /^[a-z0-9]+$/.test(id)
}

async function getNotes() {
    const files = (await fsp.readdir(NOTES_DIR)).filter(f => f.endsWith('.json'))
    const notes = []
    for (const file of files) {
        try {
            const content = await fsp.readFile(path.join(NOTES_DIR, file), 'utf-8')
            notes.push(JSON.parse(content))
        } catch { }
    }
    return notes
}

async function getNote(id) {
    try {
        const content = await fsp.readFile(path.join(NOTES_DIR, `${id}.json`), 'utf-8')
        return JSON.parse(content)
    } catch {
        return null
    }
}

async function saveNote(note) {
    await fsp.writeFile(path.join(NOTES_DIR, `${note.id}.json`), JSON.stringify(note, null, 2))
}

async function deleteNote(id) {
    try {
        await fsp.unlink(path.join(NOTES_DIR, `${id}.json`))
        try { await fsp.unlink(path.join(YJS_DIR, `${id}.yjs`)) } catch { }
        return true
    } catch {
        return false
    }
}

function extractTextFromYNodes(nodes) {
    let text = ''
    for (const node of nodes) {
        if (node instanceof Y.XmlText) {
            text += node.toString()
        } else if (node instanceof Y.XmlElement) {
            const children = node.toArray()
            text += extractTextFromYNodes(children)
            if (['paragraph', 'heading', 'codeBlock', 'blockquote', 'listItem', 'hardBreak'].includes(node.nodeName)) {
                text += '\n'
            }
        }
    }
    return text
}

function getPlainTextFromDoc(ydoc) {
    const fragment = ydoc.getXmlFragment('default')
    return extractTextFromYNodes(fragment.toArray()).trim()
}

const docs = new Map()
const saveTimers = new Map()

function getYDoc(noteId) {
    if (!docs.has(noteId)) {
        const ydoc = new Y.Doc()
        const awareness = new awarenessProtocol.Awareness(ydoc)
        const conns = new Map()

        const yjsPath = path.join(YJS_DIR, `${noteId}.yjs`)
        if (fs.existsSync(yjsPath)) {
            try {
                const state = fs.readFileSync(yjsPath)
                Y.applyUpdate(ydoc, state)
            } catch (err) {
                console.error(`加载 Yjs 文档失败 ${noteId}:`, err.message)
            }
        }

        ydoc.on('update', (update, origin) => {
            const encoder = encoding.createEncoder()
            encoding.writeVarUint(encoder, messageSync)
            syncProtocol.writeUpdate(encoder, update)
            const message = Buffer.from(encoding.toUint8Array(encoder))

            for (const [conn] of conns) {
                if (conn !== origin && conn.readyState === 1) {
                    conn.send(message)
                }
            }

            scheduleSave(noteId)
        })

        docs.set(noteId, { ydoc, awareness, conns })
    }
    return docs.get(noteId)
}

async function persistDoc(noteId) {
    const docInfo = docs.get(noteId)
    if (!docInfo) return

    try {
        const state = Y.encodeStateAsUpdate(docInfo.ydoc)
        await fsp.writeFile(path.join(YJS_DIR, `${noteId}.yjs`), Buffer.from(state))

        const plainText = getPlainTextFromDoc(docInfo.ydoc)
        const note = await getNote(noteId)
        if (note) {
            note.content = plainText
            note.updatedAt = new Date().toISOString()
            await saveNote(note)
        }
    } catch (err) {
        console.error(`持久化文档失败 ${noteId}:`, err.message)
    }
}

function scheduleSave(noteId) {
    if (saveTimers.has(noteId)) clearTimeout(saveTimers.get(noteId))
    saveTimers.set(noteId, setTimeout(() => {
        saveTimers.delete(noteId)
        persistDoc(noteId)
    }, SAVE_DEBOUNCE_MS))
}

function closeDoc(noteId) {
    const docInfo = docs.get(noteId)
    if (!docInfo) return
    if (docInfo.conns.size === 0) {
        if (saveTimers.has(noteId)) {
            clearTimeout(saveTimers.get(noteId))
            saveTimers.delete(noteId)
        }
        persistDoc(noteId)
        docInfo.ydoc.destroy()
        docInfo.awareness.destroy()
        docs.delete(noteId)
    }
}

function sendWS(conn, data) {
    if (conn.readyState === 1) {
        conn.send(data)
    }
}

function setupWSConnection(conn, req) {
    const url = new URL(req.url, `http://localhost:${PORT}`)
    const noteId = url.pathname.slice(1)

    if (!isValidId(noteId)) {
        conn.close()
        return
    }

    const docInfo = getYDoc(noteId)
    docInfo.conns.set(conn, { synced: false })

    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, messageSync)
    syncProtocol.writeSyncStep1(encoder, docInfo.ydoc)
    sendWS(conn, Buffer.from(encoding.toUint8Array(encoder)))

    conn.on('message', (message) => {
        try {
            const decoder = decoding.createDecoder(new Uint8Array(message))
            const encoder = encoding.createEncoder()
            const messageType = decoding.readVarUint(decoder)

            switch (messageType) {
                case messageSync: {
                    encoding.writeVarUint(encoder, messageSync)
                    const syncMessageType = syncProtocol.readSyncMessage(
                        decoder, encoder, docInfo.ydoc, conn
                    )
                    if (syncMessageType === syncProtocol.messageYjsSyncStep1) {
                        const encoder2 = encoding.createEncoder()
                        encoding.writeVarUint(encoder2, messageSync)
                        syncProtocol.writeSyncStep1(encoder2, docInfo.ydoc)
                        sendWS(conn, Buffer.from(encoding.toUint8Array(encoder2)))
                    }
                    const connInfo = docInfo.conns.get(conn)
                    if (connInfo && syncMessageType === syncProtocol.messageYjsSyncStep2) {
                        connInfo.synced = true
                    }
                    break
                }
                case messageAwareness: {
                    awarenessProtocol.applyAwarenessUpdate(
                        docInfo.awareness, decoding.readVarUint8Array(decoder), conn
                    )
                    const relayMsg = message
                    for (const [c] of docInfo.conns) {
                        if (c !== conn) sendWS(c, relayMsg)
                    }
                    break
                }
                case messageQueryAwareness: {
                    encoding.writeVarUint(encoder, messageAwareness)
                    encoding.writeVarUint8Array(encoder,
                        awarenessProtocol.encodeAwarenessUpdate(
                            docInfo.awareness,
                            Array.from(docInfo.awareness.getStates().keys())
                        )
                    )
                    break
                }
            }

            if (encoding.length(encoder) > 1) {
                sendWS(conn, Buffer.from(encoding.toUint8Array(encoder)))
            }
        } catch (err) {
            console.error('处理 WebSocket 消息出错:', err.message)
        }
    })

    conn.on('close', () => {
        const connInfo = docInfo.conns.get(conn)
        if (connInfo) {
            docInfo.conns.delete(conn)
            awarenessProtocol.removeAwarenessStates(
                docInfo.awareness,
                [connInfo.clientId || docInfo.awareness.clientID],
                'disconnect'
            )
        }
    })

    const pingInterval = setInterval(() => {
        if (conn.readyState === 1) conn.ping()
    }, 30000)
    conn.on('close', () => clearInterval(pingInterval))
}

function sendJSON(res, statusCode, data) {
    const json = JSON.stringify(data)
    res.writeHead(statusCode, { 'Content-Type': 'application/json' })
    res.end(json)
}

function sendCompressedJSON(res, statusCode, data) {
    const json = JSON.stringify(data)
    const acceptEncoding = res.req.headers['accept-encoding'] || ''

    if (acceptEncoding.includes('gzip')) {
        zlib.gzip(json, (err, compressed) => {
            if (err) {
                res.writeHead(statusCode, { 'Content-Type': 'application/json' })
                res.end(json)
                return
            }
            res.writeHead(statusCode, {
                'Content-Type': 'application/json',
                'Content-Encoding': 'gzip'
            })
            res.end(compressed)
        })
    } else if (acceptEncoding.includes('deflate')) {
        zlib.deflate(json, (err, compressed) => {
            if (err) {
                res.writeHead(statusCode, { 'Content-Type': 'application/json' })
                res.end(json)
                return
            }
            res.writeHead(statusCode, {
                'Content-Type': 'application/json',
                'Content-Encoding': 'deflate'
            })
            res.end(compressed)
        })
    } else {
        res.writeHead(statusCode, { 'Content-Type': 'application/json' })
        res.end(json)
    }
}

function readBody(req, maxSize) {
    return new Promise((resolve, reject) => {
        let chunks = []
        let size = 0
        let settled = false
        req.on('data', chunk => {
            if (settled) return
            size += chunk.length
            if (size > maxSize) {
                settled = true
                reject(Object.assign(new Error('Body too large'), { status: 413 }))
                req.destroy()
                return
            }
            chunks.push(chunk)
        })
        req.on('end', () => {
            if (!settled) {
                settled = true
                resolve(Buffer.concat(chunks))
            }
        })
        req.on('error', (err) => {
            if (!settled) {
                settled = true
                reject(err)
            }
        })
    })
}

function sanitizeString(val, maxLen) {
    return typeof val === 'string' ? val.slice(0, maxLen) : undefined
}

const IMAGE_EXTENSIONS = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg'
}

const server = http.createServer(async (req, res) => {
    try {
        const url = new URL(req.url, `http://localhost:${PORT}`)
        const pathname = url.pathname

        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

        if (req.method === 'OPTIONS') {
            res.writeHead(204)
            res.end()
            return
        }

        if (pathname.startsWith('/images/')) {
            const imageName = pathname.slice(8)
            if (!/^[a-z0-9]+\.[a-z0-9]+$/i.test(imageName)) {
                res.writeHead(400)
                res.end('Bad Request')
                return
            }
            const imagePath = path.join(IMAGES_DIR, imageName)
            try {
                await fsp.access(imagePath)
            } catch {
                res.writeHead(404)
                res.end('Not Found')
                return
            }
            const ext = path.extname(imageName).toLowerCase()
            const contentTypes = {
                '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
                '.png': 'image/png', '.gif': 'image/gif',
                '.webp': 'image/webp', '.svg': 'image/svg+xml'
            }
            res.writeHead(200, {
                'Content-Type': contentTypes[ext] || 'application/octet-stream',
                'Cache-Control': 'public, max-age=31536000',
                'Vary': 'Accept-Encoding'
            })
            fs.createReadStream(imagePath).pipe(res)
            return
        }

        if (pathname === '/api/upload' && req.method === 'POST') {
            const contentType = req.headers['content-type'] || ''
            if (!contentType.startsWith('multipart/form-data') && !contentType.startsWith('image/')) {
                sendJSON(res, 400, { error: 'Content-Type must be multipart/form-data or image/*' })
                return
            }

            let fileBuffer
            let fileExt = '.jpg'

            if (contentType.startsWith('image/')) {
                fileBuffer = await readBody(req, MAX_UPLOAD_SIZE)
                fileExt = IMAGE_EXTENSIONS[contentType] || '.jpg'
            } else {
                const boundary = contentType.split('boundary=')[1]
                if (!boundary) {
                    sendJSON(res, 400, { error: 'Invalid multipart boundary' })
                    return
                }
                const raw = await readBody(req, MAX_UPLOAD_SIZE)
                const boundaryStr = `--${boundary}`
                const parts = raw.toString('binary').split(boundaryStr)

                for (const part of parts) {
                    if (part.includes('Content-Type: image') || part.includes('filename=')) {
                        const headerEnd = part.indexOf('\r\n\r\n')
                        if (headerEnd === -1) continue
                        const header = part.substring(0, headerEnd)
                        const mimeMatch = header.match(/Content-Type:\s*(image\/[a-z+]+)/i)
                        if (mimeMatch) {
                            fileExt = IMAGE_EXTENSIONS[mimeMatch[1]] || '.jpg'
                        }
                        const bodyStart = headerEnd + 4
                        const bodyEnd = part.lastIndexOf('\r\n')
                        if (bodyEnd > bodyStart) {
                            fileBuffer = Buffer.from(part.substring(bodyStart, bodyEnd), 'binary')
                        }
                        break
                    }
                }
            }

            if (!fileBuffer || fileBuffer.length === 0) {
                sendJSON(res, 400, { error: 'No image data found' })
                return
            }

            const imageId = crypto.randomBytes(4).toString('hex')
            const fileName = `${imageId}${fileExt}`
            await fsp.writeFile(path.join(IMAGES_DIR, fileName), fileBuffer)
            sendJSON(res, 200, { url: `/images/${fileName}` })
            return
        }

        if (pathname === '/api/notes' && req.method === 'GET') {
            const notes = await getNotes()
            sendCompressedJSON(res, 200, notes)
            return
        }

        if (pathname === '/api/notes' && req.method === 'POST') {
            let body
            try {
                body = JSON.parse((await readBody(req, MAX_BODY_SIZE)).toString())
            } catch (e) {
                sendJSON(res, e.status === 413 ? 413 : 400, { error: e.status === 413 ? 'Request body too large' : 'Invalid JSON' })
                return
            }
            const note = {
                id: generateId(),
                title: sanitizeString(body.title, 500) ?? '',
                content: sanitizeString(body.content, 100000) ?? '',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            }
            await saveNote(note)
            sendJSON(res, 201, note)
            return
        }

        const noteMatch = pathname.match(/^\/api\/notes\/([^/]+)$/)
        if (noteMatch) {
            const id = noteMatch[1]
            if (!isValidId(id)) {
                sendJSON(res, 400, { error: 'Invalid note ID' })
                return
            }

            if (req.method === 'GET') {
                const note = await getNote(id)
                note ? sendCompressedJSON(res, 200, note) : sendJSON(res, 404, { error: 'Note not found' })
                return
            }

            if (req.method === 'PUT') {
                let body
                try {
                    body = JSON.parse((await readBody(req, MAX_BODY_SIZE)).toString())
                } catch (e) {
                    sendJSON(res, e.status === 413 ? 413 : 400, { error: e.status === 413 ? 'Request body too large' : 'Invalid JSON' })
                    return
                }
                const note = await getNote(id)
                if (!note) {
                    sendJSON(res, 404, { error: 'Note not found' })
                    return
                }
                const title = sanitizeString(body.title, 500)
                if (title !== undefined) note.title = title
                note.updatedAt = new Date().toISOString()
                await saveNote(note)
                sendJSON(res, 200, note)
                return
            }

            if (req.method === 'DELETE') {
                const deleted = await deleteNote(id)
                deleted ? sendJSON(res, 200, { success: true }) : sendJSON(res, 404, { error: 'Note not found' })
                return
            }
        }

        if (pathname === '/' || pathname === '/index.html') {
            try {
                const html = await fsp.readFile(path.join(__dirname, 'public', 'index.html'), 'utf-8')
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
                res.end(html)
            } catch {
                res.writeHead(404)
                res.end('Not Found')
            }
            return
        }

        if (pathname === '/bundle.js') {
            try {
                const js = await fsp.readFile(path.join(__dirname, 'public', 'bundle.js'))
                res.writeHead(200, { 'Content-Type': 'application/javascript' })
                res.end(js)
            } catch {
                res.writeHead(404)
                res.end('Not Found')
            }
            return
        }

        res.writeHead(404)
        res.end('Not Found')
    } catch (err) {
        console.error('Server error:', err)
        if (!res.headersSent) {
            sendJSON(res, 500, { error: 'Internal server error' })
        }
    }
})

const wss = new WebSocketServer({ server })
wss.on('connection', (ws, req) => {
    setupWSConnection(ws, req)
})

server.on('error', (err) => console.error('服务器错误:', err))

server.listen(PORT, () => {
    console.log(`ezNote 服务器运行在 http://localhost:${PORT}`)
    console.log(`  笔记目录: ${NOTES_DIR}`)
    console.log(`  图片目录: ${IMAGES_DIR}`)
    console.log(`  Yjs 目录:  ${YJS_DIR}`)
})
