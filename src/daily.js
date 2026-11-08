/**
 * 日报模块
 * 与笔记系统完全独立：自己的数据目录、自己的 API、自己的视图。
 * 不依赖 Tiptap / Yjs，纯 DOM 操作。
 */

const API_BASE = ''
const AUTH_TOKEN_KEY = 'eznote-auth-token'
const SAVE_DEBOUNCE_MS = 800
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

const DEFAULT_SECTIONS = [
    { key: 'done', title: '今日完成' },
    { key: 'plan', title: '明日计划' },
    { key: 'issue', title: '问题与思考' },
]

let currentDate = todayStr()
let current = null
let saveTimer = null
let saving = false
let dirty = false
let overviewOpen = false
let overviewRange = 14
let showEmpty = false
let active = false

// ---------- 工具 ----------

function authHeaders(extra) {
    const token = localStorage.getItem(AUTH_TOKEN_KEY) || ''
    return Object.assign({ 'x-auth-token': token }, extra || {})
}

function pad2(n) {
    return String(n).padStart(2, '0')
}

function todayStr() {
    const d = new Date()
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

function shiftDate(dateStr, n) {
    const [y, m, d] = dateStr.split('-').map(Number)
    const dt = new Date(y, m - 1, d + n)
    return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`
}

function dateLabel(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number)
    const dt = new Date(y, m - 1, d)
    const isToday = dateStr === todayStr()
    return `${m}月${d}日 ${WEEKDAYS[dt.getDay()]}${isToday ? ' · 今天' : ''}`
}

function shortDate(dateStr) {
    const [, m, d] = dateStr.split('-')
    return `${Number(m)}月${Number(d)}日`
}

function weekdayOf(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number)
    return WEEKDAYS[new Date(y, m - 1, d).getDay()]
}

function escapeHtml(str) {
    return String(str == null ? '' : str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
}

function emptyDay(date) {
    return {
        date,
        sections: DEFAULT_SECTIONS.map(s => ({ key: s.key, title: s.title, items: [] })),
        updatedAt: null,
    }
}

// ---------- DOM 引用 ----------

const el = {}

function cacheEl() {
    el.notesBtn = document.getElementById('viewNotesBtn')
    el.dailyBtn = document.getElementById('viewDailyBtn')
    el.editorContainer = document.getElementById('editorContainer')
    el.dailyContainer = document.getElementById('dailyContainer')
    el.dateTitle = document.getElementById('dailyDateTitle')
    el.prevBtn = document.getElementById('dailyPrev')
    el.nextBtn = document.getElementById('dailyNext')
    el.todayBtn = document.getElementById('dailyToday')
    el.pickDate = document.getElementById('dailyPickDate')
    el.overviewBtn = document.getElementById('dailyOverviewBtn')
    el.backBtn = document.getElementById('dailyBack')
    el.sections = document.getElementById('dailySections')
    el.overview = document.getElementById('dailyOverview')
    el.overviewHead = document.getElementById('dailyOverviewHead')
    el.overviewBody = document.getElementById('dailyOverviewBody')
    el.saveHint = document.getElementById('dailySaveHint')
}

// ---------- 数据 ----------

async function loadDay(date) {
    const res = await fetch(`${API_BASE}/api/daily/${date}`, { headers: authHeaders() })
    if (res.status === 401) {
        localStorage.removeItem(AUTH_TOKEN_KEY)
        location.reload()
        return null
    }
    if (!res.ok) return emptyDay(date)
    return await res.json()
}

async function saveNow() {
    if (!current || !dirty || saving) return
    saving = true
    dirty = false
    setHint('保存中…')

    const payload = {
        sections: current.sections.map(s => ({
            key: s.key,
            title: s.title,
            items: s.items.filter(it => it.text.trim()).map(it => ({
                text: it.text,
                checked: !!it.checked,
            })),
        })),
    }

    try {
        const res = await fetch(`${API_BASE}/api/daily/${current.date}`, {
            method: 'PUT',
            headers: authHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify(payload),
        })
        if (res.ok) {
            const data = await res.json()
            current.updatedAt = data.updatedAt
            setHint(data.updatedAt ? '已保存' : '')
        } else {
            setHint('保存失败')
            dirty = true
        }
    } catch {
        setHint('保存失败')
        dirty = true
    } finally {
        saving = false
        if (dirty) scheduleSave()
    }
}

function scheduleSave() {
    dirty = true
    setHint('未保存')
    clearTimeout(saveTimer)
    saveTimer = setTimeout(saveNow, SAVE_DEBOUNCE_MS)
}

let hintTimer = null
function setHint(text) {
    if (!el.saveHint) return
    el.saveHint.textContent = text
    el.saveHint.classList.toggle('visible', !!text)
    if (text === '已保存') {
        clearTimeout(hintTimer)
        hintTimer = setTimeout(() => setHint(''), 1500)
    }
}

// ---------- 单日渲染 ----------

function sectionByKey(key) {
    return current.sections.find(s => s.key === key)
}

function itemHtml(item, idx) {
    return `
        <div class="daily-item ${item.checked ? 'checked' : ''}" data-idx="${idx}">
            <input type="checkbox" class="daily-item-check" ${item.checked ? 'checked' : ''}>
            <input type="text" class="daily-item-input" value="${escapeHtml(item.text)}" placeholder="记一条…">
            <button class="daily-item-del" title="删除">×</button>
        </div>
    `
}

function sectionHtml(sec) {
    return `
        <div class="daily-section" data-key="${escapeHtml(sec.key)}">
            <div class="daily-section-head">
                <input type="text" class="daily-section-title" value="${escapeHtml(sec.title)}" maxlength="40">
            </div>
            <div class="daily-items"></div>
            <button class="daily-add" type="button">+ 添加一条</button>
        </div>
    `
}

function renderItems(key) {
    const sec = sectionByKey(key)
    const secEl = el.sections.querySelector(`.daily-section[data-key="${key}"]`)
    if (!sec || !secEl) return
    const box = secEl.querySelector('.daily-items')
    box.innerHTML = sec.items.map(itemHtml).join('')
}

function renderDay() {
    el.dateTitle.textContent = dateLabel(current.date)
    el.pickDate.value = current.date
    // 每栏至少留一个空输入行，方便直接开始写
    current.sections.forEach(s => {
        if (s.items.length === 0) s.items.push({ text: '', checked: false })
    })
    el.sections.innerHTML = current.sections.map(sectionHtml).join('')
    current.sections.forEach(s => renderItems(s.key))
    syncEmptyState()
}

// 完全没有内容时给个提示条（仍可输入）
function syncEmptyState() {
    const hasAny = current.sections.some(s => s.items.some(i => i.text.trim()))
    el.sections.classList.toggle('is-empty', !hasAny)
}

async function openDay(date) {
    currentDate = date
    await saveNow().catch(() => { })
    current = await loadDay(date)
    if (!current) return
    dirty = false
    renderDay()
    setHint('')
}

function focusItem(secKey, idx) {
    const input = el.sections.querySelector(
        `.daily-section[data-key="${secKey}"] .daily-item[data-idx="${idx}"] .daily-item-input`
    )
    if (input) input.focus()
}

// ---------- 交互 ----------

function bindSections() {
    el.sections.addEventListener('input', (e) => {
        const secEl = e.target.closest('.daily-section')
        if (!secEl) return
        const key = secEl.dataset.key

        if (e.target.classList.contains('daily-item-input')) {
            const idx = Number(e.target.closest('.daily-item').dataset.idx)
            const sec = sectionByKey(key)
            if (sec && sec.items[idx]) {
                sec.items[idx].text = e.target.value
                // 取消勾选状态时设成未做，不做自动推断
                scheduleSave()
                syncEmptyState()
            }
        } else if (e.target.classList.contains('daily-section-title')) {
            const sec = sectionByKey(key)
            if (sec) {
                sec.title = e.target.value.slice(0, 40)
                scheduleSave()
            }
        }
    })

    el.sections.addEventListener('change', (e) => {
        if (!e.target.classList.contains('daily-item-check')) return
        const secEl = e.target.closest('.daily-section')
        const key = secEl.dataset.key
        const itemEl = e.target.closest('.daily-item')
        const idx = Number(itemEl.dataset.idx)
        const sec = sectionByKey(key)
        if (sec && sec.items[idx]) {
            sec.items[idx].checked = e.target.checked
            itemEl.classList.toggle('checked', e.target.checked)
            scheduleSave()
        }
    })

    el.sections.addEventListener('keydown', (e) => {
        if (!e.target.classList.contains('daily-item-input')) return

        const secEl = e.target.closest('.daily-section')
        const key = secEl.dataset.key
        const itemEl = e.target.closest('.daily-item')
        const idx = Number(itemEl.dataset.idx)
        const sec = sectionByKey(key)
        if (!sec) return

        if (e.key === 'Enter') {
            e.preventDefault()
            // 先把当前输入同步进模型
            sec.items[idx].text = e.target.value
            const nextEmpty = idx + 1
            if (!sec.items[nextEmpty] || sec.items[nextEmpty].text.trim()) {
                sec.items.splice(nextEmpty, 0, { text: '', checked: false })
            }
            renderItems(key)
            focusItem(key, nextEmpty)
            scheduleSave()
        } else if (e.key === 'Backspace' && e.target.value === '') {
            // 空行按退格：删掉这一行，回到上一行末尾
            e.preventDefault()
            sec.items.splice(idx, 1)
            const focusIdx = Math.max(0, idx - 1)
            if (sec.items.length === 0) sec.items.push({ text: '', checked: false })
            renderItems(key)
            const input = el.sections.querySelector(
                `.daily-section[data-key="${key}"] .daily-item[data-idx="${focusIdx}"] .daily-item-input`
            )
            if (input) {
                input.focus()
                input.setSelectionRange(input.value.length, input.value.length)
            }
            scheduleSave()
        } else if (e.key === 'ArrowUp' && idx > 0) {
            e.preventDefault()
            focusItem(key, idx - 1)
        } else if (e.key === 'ArrowDown' && idx < sec.items.length - 1) {
            e.preventDefault()
            focusItem(key, idx + 1)
        }
    })

    // 空行失焦：删掉，但每栏至少保留一个输入行
    el.sections.addEventListener('focusout', (e) => {
        if (!e.target.classList.contains('daily-item-input')) return
        setTimeout(() => {
            const active = document.activeElement
            if (active && active.classList && active.classList.contains('daily-item-input')) return

            const secEl = e.target.closest('.daily-section')
            if (!secEl) return
            const key = secEl.dataset.key
            const sec = sectionByKey(key)
            if (!sec) return

            const before = sec.items.length
            sec.items = sec.items.filter(it => it.text.trim() || it.checked)
            if (sec.items.length === 0) sec.items.push({ text: '', checked: false })
            if (sec.items.length !== before) {
                renderItems(key)
                scheduleSave()
            }
        }, 120)
    })

    el.sections.addEventListener('click', (e) => {
        const addBtn = e.target.closest('.daily-add')
        if (addBtn) {
            const secEl = addBtn.closest('.daily-section')
            const key = secEl.dataset.key
            const sec = sectionByKey(key)
            if (!sec) return
            const last = sec.items.length - 1
            if (last >= 0 && !sec.items[last].text.trim() && !sec.items[last].checked) {
                focusItem(key, last)
            } else {
                sec.items.push({ text: '', checked: false })
                renderItems(key)
                focusItem(key, sec.items.length - 1)
            }
            return
        }

        const delBtn = e.target.closest('.daily-item-del')
        if (delBtn) {
            const secEl = delBtn.closest('.daily-section')
            const key = secEl.dataset.key
            const itemEl = delBtn.closest('.daily-item')
            const idx = Number(itemEl.dataset.idx)
            const sec = sectionByKey(key)
            if (!sec) return
            sec.items.splice(idx, 1)
            if (sec.items.length === 0) sec.items.push({ text: '', checked: false })
            renderItems(key)
            scheduleSave()
            syncEmptyState()
        }
    })
}

// ---------- 总览 ----------

async function openOverview() {
    overviewOpen = true
    el.overview.classList.remove('hidden')
    el.sections.classList.add('hidden')
    el.overviewBtn.classList.add('active')
    await renderOverview()
}

function closeOverview() {
    overviewOpen = false
    el.overview.classList.add('hidden')
    el.sections.classList.remove('hidden')
    el.overviewBtn.classList.remove('active')
}

async function fetchRange(days) {
    const to = todayStr()
    const res = await fetch(`${API_BASE}/api/daily?to=${to}&days=${days}`, { headers: authHeaders() })
    if (!res.ok) return []
    return await res.json()
}

async function renderOverview() {
    el.overviewBody.innerHTML = '<tr><td class="daily-ov-empty">加载中…</td></tr>'
    const list = await fetchRange(overviewRange)

    // 列：三个默认栏 + 数据里出现的额外栏
    const cols = DEFAULT_SECTIONS.map(s => ({ key: s.key, title: s.title }))
    const seen = new Set(cols.map(c => c.key))
    list.forEach(day => {
        day.sections.forEach(s => {
            if (!seen.has(s.key)) {
                seen.add(s.key)
                cols.push({ key: s.key, title: s.title })
            }
        })
    })

    // 默认只显示有记录的日期；打开「显示空白日期」才补齐
    const byDate = new Map(list.map(d => [d.date, d]))
    const rows = []
    const to = todayStr()
    for (let i = 0; i < overviewRange; i++) {
        const date = shiftDate(to, -i)
        const day = byDate.get(date) || null
        if (!day && !showEmpty) continue
        rows.push({ date, day })
    }

    el.overviewHead.innerHTML = `
        <tr>
            <th class="col-date">日期</th>
            ${cols.map(c => `<th>${escapeHtml(c.title)}</th>`).join('')}
        </tr>
    `

    el.overviewBody.innerHTML = rows.map(({ date, day }) => {
        const cells = cols.map(c => {
            const sec = day ? day.sections.find(s => s.key === c.key) : null
            const items = sec ? sec.items.filter(it => it.text.trim()) : []
            if (items.length === 0) return '<td class="cell-empty">—</td>'
            const shown = items.slice(0, 4).map(it => `
                <div class="ov-item ${it.checked ? 'checked' : ''}">
                    <span class="ov-mark">${it.checked ? '✓' : '·'}</span>
                    <span class="ov-text">${escapeHtml(it.text)}</span>
                </div>
            `).join('')
            const more = items.length > 4
                ? `<div class="ov-more">还有 ${items.length - 4} 条</div>`
                : ''
            return `<td>${shown}${more}</td>`
        }).join('')

        const rowClass = day ? 'has-data' : 'no-data'
        return `
            <tr class="${rowClass}" data-date="${date}">
                <td class="col-date">
                    <div class="ov-date">${shortDate(date)}</div>
                    <div class="ov-weekday">${weekdayOf(date)}</div>
                </td>
                ${cells}
            </tr>
        `
    }).join('') || '<tr><td class="daily-ov-empty" colspan="99">这段时间还没有记录</td></tr>'

    el.overviewBody.querySelectorAll('tr[data-date]').forEach(tr => {
        tr.addEventListener('click', () => {
            closeOverview()
            openDay(tr.dataset.date)
        })
    })
}

// ---------- 视图切换 ----------

export function openDaily() {
    active = true
    el.editorContainer.style.display = 'none'
    el.dailyContainer.classList.remove('hidden')
    el.notesBtn.classList.remove('active')
    el.dailyBtn.classList.add('active')
    document.getElementById('app').classList.add('daily-mode')
    if (!current) openDay(currentDate)
}

export function closeDaily() {
    active = false
    if (overviewOpen) closeOverview()
    saveNow().catch(() => { })
    el.dailyContainer.classList.add('hidden')
    el.editorContainer.style.display = ''
    el.dailyBtn.classList.remove('active')
    el.notesBtn.classList.add('active')
    document.getElementById('app').classList.remove('daily-mode')
}

export function isDailyActive() {
    return active
}

// ---------- 初始化 ----------

export function initDaily() {
    cacheEl()

    el.notesBtn.addEventListener('click', () => {
        if (active) closeDaily()
    })
    el.dailyBtn.addEventListener('click', () => openDaily())
    el.backBtn.addEventListener('click', () => closeDaily())

    el.prevBtn.addEventListener('click', () => openDay(shiftDate(currentDate, -1)))
    el.nextBtn.addEventListener('click', () => openDay(shiftDate(currentDate, 1)))
    el.todayBtn.addEventListener('click', () => openDay(todayStr()))
    el.pickDate.addEventListener('change', (e) => {
        if (e.target.value) openDay(e.target.value)
    })

    el.overviewBtn.addEventListener('click', () => {
        overviewOpen ? closeOverview() : openOverview()
    })

    const emptyToggle = document.getElementById('dailyShowEmpty')
    if (emptyToggle) {
        emptyToggle.addEventListener('change', (e) => {
            showEmpty = e.target.checked
            renderOverview()
        })
    }

    document.querySelectorAll('.daily-range-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            overviewRange = Number(btn.dataset.days)
            document.querySelectorAll('.daily-range-btn').forEach(b => {
                b.classList.toggle('active', b === btn)
            })
            renderOverview()
        })
    })

    bindSections()

    // 页面隐藏或关闭前尽力保存
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') saveNow().catch(() => { })
    })
    window.addEventListener('beforeunload', () => {
        if (dirty) saveNow().catch(() => { })
    })

}