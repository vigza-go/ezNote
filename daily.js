const fs = require('fs')
const fsp = fs.promises
const path = require('path')

const DAILY_DIR = path.join(__dirname, 'data', 'daily')

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const MAX_ITEMS_PER_SECTION = 200
const MAX_SECTIONS = 12
const MAX_TEXT_LEN = 2000
const MAX_TITLE_LEN = 40
const MAX_RANGE_DAYS = 366
const MAX_BODY_SIZE = 512 * 1024

const DEFAULT_SECTIONS = [
    { key: 'done', title: '今日完成' },
    { key: 'plan', title: '明日计划' },
    { key: 'issue', title: '问题与思考' },
]

if (!fs.existsSync(DAILY_DIR)) fs.mkdirSync(DAILY_DIR, { recursive: true })

function isValidDate(str) {
    if (typeof str !== 'string' || !DATE_RE.test(str)) return false
    const d = new Date(`${str}T00:00:00Z`)
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === str
}

function dailyPath(date) {
    return path.join(DAILY_DIR, `${date}.json`)
}

function sanitizeSections(raw) {
    if (!Array.isArray(raw)) return null
    const out = []
    const usedKeys = new Set()

    for (const sec of raw.slice(0, MAX_SECTIONS)) {
        if (!sec || typeof sec !== 'object') continue
        const key = typeof sec.key === 'string' && /^[a-zA-Z0-9_-]{1,32}$/.test(sec.key) ? sec.key : null
        if (!key || usedKeys.has(key)) continue
        usedKeys.add(key)

        const items = []
        if (Array.isArray(sec.items)) {
            for (const it of sec.items.slice(0, MAX_ITEMS_PER_SECTION)) {
                if (!it || typeof it !== 'object') continue
                const text = typeof it.text === 'string' ? it.text.slice(0, MAX_TEXT_LEN).trim() : ''
                if (!text) continue
                items.push({ text, checked: it.checked === true })
            }
        }

        const known = DEFAULT_SECTIONS.find(d => d.key === key)
        const fallbackTitle = known ? known.title : key
        const title = typeof sec.title === 'string' && sec.title.trim()
            ? sec.title.trim().slice(0, MAX_TITLE_LEN)
            : fallbackTitle

        out.push({ key, title, items })
    }
    return out
}

// 确保三个默认分栏存在且排在最前，用户自建的分栏附在后面
// 三个默认栏的标题固定用中文，避免前端不传 title 时被 key 覆盖
function ensureDefaults(sections) {
    const map = new Map(sections.map(s => [s.key, s]))
    const base = DEFAULT_SECTIONS.map(d => {
        const found = map.get(d.key)
        return { key: d.key, title: d.title, items: found ? found.items : [] }
    })
    const extra = sections.filter(s => !DEFAULT_SECTIONS.some(d => d.key === s.key))
    return base.concat(extra)
}

function emptyDaily(date) {
    return {
        date,
        sections: ensureDefaults([]),
        updatedAt: null,
    }
}

async function readDaily(date) {
    try {
        const raw = await fsp.readFile(dailyPath(date), 'utf-8')
        const data = JSON.parse(raw)
        const sections = sanitizeSections(data.sections) || []
        return {
            date,
            sections: ensureDefaults(sections),
            updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : null,
        }
    } catch {
        return null
    }
}

async function writeDaily(daily) {
    const tmp = `${dailyPath(daily.date)}.${process.pid}.tmp`
    await fsp.writeFile(tmp, JSON.stringify(daily, null, 2))
    await fsp.rename(tmp, dailyPath(daily.date))
}

async function listDates() {
    let files = []
    try {
        files = await fsp.readdir(DAILY_DIR)
    } catch {
        return []
    }
    return files
        .filter(f => f.endsWith('.json'))
        .map(f => f.slice(0, -5))
        .filter(isValidDate)
        .sort()
        .reverse()
}

function addDays(dateStr, n) {
    const d = new Date(`${dateStr}T00:00:00Z`)
    d.setUTCDate(d.getUTCDate() + n)
    return d.toISOString().slice(0, 10)
}

/**
 * 处理 /api/daily 下的所有请求。
 * 返回 true 表示已处理，false 表示交还给上层。
 */
function createDailyRouter({ sendJSON, sendCompressedJSON, readBody }) {

    async function handleGetOne(date, res) {
        const daily = (await readDaily(date)) || emptyDaily(date)
        sendCompressedJSON(res, 200, daily)
    }

    async function handlePutOne(date, req, res) {
        let body
        try {
            body = JSON.parse((await readBody(req, MAX_BODY_SIZE)).toString())
        } catch (e) {
            sendJSON(res, e.status === 413 ? 413 : 400, {
                error: e.status === 413 ? 'Request body too large' : 'Invalid JSON'
            })
            return
        }

        const sections = sanitizeSections(body.sections)
        if (!sections) {
            sendJSON(res, 400, { error: 'sections 必须是数组' })
            return
        }

        const daily = {
            date,
            sections: ensureDefaults(sections),
            updatedAt: new Date().toISOString(),
        }

        // 三栏全空视为没有记录，直接删文件，保持 data/daily 干净
        const isEmpty = daily.sections.every(s => s.items.length === 0)
        if (isEmpty) {
            try { await fsp.unlink(dailyPath(date)) } catch { }
            sendJSON(res, 200, { ...daily, updatedAt: null })
            return
        }

        await writeDaily(daily)
        sendJSON(res, 200, daily)
    }

    async function handleRange(url, res) {
        const to = url.searchParams.get('to') || new Date().toISOString().slice(0, 10)
        const fromParam = url.searchParams.get('from')
        const days = Number(url.searchParams.get('days'))

        if (!isValidDate(to)) {
            sendJSON(res, 400, { error: 'to 日期格式应为 YYYY-MM-DD' })
            return
        }

        let from
        if (fromParam) {
            if (!isValidDate(fromParam)) {
                sendJSON(res, 400, { error: 'from 日期格式应为 YYYY-MM-DD' })
                return
            }
            from = fromParam
        } else {
            const span = Number.isFinite(days) && days > 0 ? Math.min(days, MAX_RANGE_DAYS) : 14
            from = addDays(to, -(span - 1))
        }

        if (from > to) {
            sendJSON(res, 400, { error: 'from 不能晚于 to' })
            return
        }

        // 区间太长时按最长 366 天截断
        const maxFrom = addDays(to, -(MAX_RANGE_DAYS - 1))
        if (from < maxFrom) from = maxFrom

        const result = []
        for (let d = from; d <= to; d = addDays(d, 1)) {
            const daily = await readDaily(d)
            if (daily) result.push(daily)
        }
        sendCompressedJSON(res, 200, result)
    }

    return async function route(req, res, pathname, url) {
        if (!pathname.startsWith('/api/daily')) return false

        // GET /api/daily/dates
        if (pathname === '/api/daily/dates') {
            if (req.method !== 'GET') {
                sendJSON(res, 405, { error: 'Method not allowed' })
                return true
            }
            sendCompressedJSON(res, 200, await listDates())
            return true
        }

        // GET /api/daily  -> 区间查询
        if (pathname === '/api/daily') {
            if (req.method !== 'GET') {
                sendJSON(res, 405, { error: 'Method not allowed' })
                return true
            }
            await handleRange(url, res)
            return true
        }

        // /api/daily/:date
        const m = pathname.match(/^\/api\/daily\/([^/]+)$/)
        if (!m) return false

        const date = m[1]
        if (!isValidDate(date)) {
            sendJSON(res, 400, { error: '日期格式应为 YYYY-MM-DD' })
            return true
        }

        if (req.method === 'GET') {
            await handleGetOne(date, res)
            return true
        }

        if (req.method === 'PUT') {
            await handlePutOne(date, req, res)
            return true
        }

        if (req.method === 'DELETE') {
            try { await fsp.unlink(dailyPath(date)) } catch { }
            sendJSON(res, 200, { success: true })
            return true
        }

        sendJSON(res, 405, { error: 'Method not allowed' })
        return true
    }
}

module.exports = {
    DAILY_DIR,
    DEFAULT_SECTIONS,
    createDailyRouter,
}