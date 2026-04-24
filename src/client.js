import { Editor } from '@tiptap/core'
import { StarterKit } from '@tiptap/starter-kit'
import { Image } from '@tiptap/extension-image'
import { Placeholder } from '@tiptap/extension-placeholder'
import { Collaboration } from '@tiptap/extension-collaboration'
import { BubbleMenu } from '@tiptap/extension-bubble-menu'
import { Underline } from '@tiptap/extension-underline'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'

const API_BASE = ''
let notes = []
let currentNoteId = null
let searchQuery = ''
let pendingDelete = null
let editor = null
let ydoc = null
let wsProvider = null
let awarenessChangeHandler = null
let syncHandler = null
let titleSaveTimeout = null
let editorInitialContent = null
let isDark = localStorage.getItem('eznote-dark') === 'true'

const COLLAB_COLORS = [
    '#f44336', '#e91e63', '#9c27b0', '#673ab7',
    '#3f51b5', '#2196f3', '#03a9f4', '#00bcd4',
    '#009688', '#4caf50', '#8bc34a', '#cddc39',
    '#ffeb3b', '#ffc107', '#ff9800', '#ff5722'
]

function randomColor() {
    return COLLAB_COLORS[Math.floor(Math.random() * COLLAB_COLORS.length)]
}

function randomName() {
    const names = ['用户', '协作者', '编辑者', '参与者']
    return names[Math.floor(Math.random() * names.length)] + Math.floor(Math.random() * 100)
}

const userName = randomName()
const userColor = randomColor()

const el = {
    app: document.getElementById('app'),
    notesList: document.getElementById('notesList'),
    newNoteBtn: document.getElementById('newNoteBtn'),
    emptyState: document.getElementById('emptyState'),
    editorWrapper: document.getElementById('editorWrapper'),
    noteTitle: document.getElementById('noteTitle'),
    editorContent: document.getElementById('editorContent'),
    deleteNoteBtn: document.getElementById('deleteNoteBtn'),
    saveIndicator: document.getElementById('saveIndicator'),
    searchInput: document.getElementById('searchInput'),
    backBtn: document.getElementById('backBtn'),
    darkToggle: document.getElementById('darkToggle'),
    bubbleMenu: document.getElementById('bubbleMenu'),
    onlineCount: document.getElementById('onlineCount'),
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
}

function highlightText(text, query) {
    const escaped = escapeHtml(text)
    if (!query) return escaped
    const escapedQuery = escapeHtml(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return escaped.replace(new RegExp(escapedQuery, 'gi'), m => `<mark>${m}</mark>`)
}

function applyDarkMode() {
    document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light')
    el.darkToggle.textContent = isDark ? '☀️' : '🌙'
}

async function fetchNotes() {
    try {
        const res = await fetch(`${API_BASE}/api/notes`)
        notes = await res.json()
        renderNotesList()
    } catch (err) {
        console.error('获取笔记失败:', err)
    }
}

function renderNotesList() {
    let filteredNotes = notes
    if (searchQuery) {
        const q = searchQuery.toLowerCase()
        filteredNotes = notes.filter(n =>
            n.title.toLowerCase().includes(q) ||
            (n.content || '').toLowerCase().includes(q)
        )
    }

    if (filteredNotes.length === 0) {
        el.notesList.innerHTML = '<div class="sidebar-empty">' +
            (searchQuery ? '没有找到匹配的笔记' : '暂无笔记，点击上方创建') + '</div>'
        return
    }

    filteredNotes.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))

    el.notesList.innerHTML = filteredNotes.map(note => `
        <div class="note-item ${note.id === currentNoteId ? 'active' : ''}" data-id="${escapeHtml(note.id)}">
            <div class="note-item-title">${highlightText(note.title || '无标题笔记', searchQuery)}</div>
            <div class="note-item-date">${escapeHtml(formatDate(note.updatedAt))}</div>
            <div class="note-item-preview">${highlightText((note.content || '').substring(0, 60) || '空笔记', searchQuery)}</div>
        </div>
    `).join('')

    el.notesList.querySelectorAll('.note-item').forEach(item => {
        item.addEventListener('click', () => selectNote(item.dataset.id))
    })
}

function formatDate(dateStr) {
    const date = new Date(dateStr)
    const now = new Date()
    const diff = now - date
    if (diff < 60000) return '刚刚'
    if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`
    if (diff < 604800000) return `${Math.floor(diff / 86400000)}天前`
    return date.toLocaleDateString('zh-CN')
}

function destroyEditor() {
    if (wsProvider) {
        if (awarenessChangeHandler && wsProvider.awareness) {
            wsProvider.awareness.off('change', awarenessChangeHandler)
        }
        if (syncHandler) {
            wsProvider.off('sync', syncHandler)
        }
        wsProvider.disconnect()
        wsProvider.destroy()
        wsProvider = null
        awarenessChangeHandler = null
        syncHandler = null
    }
    if (editor) {
        editor.destroy()
        editor = null
    }
    if (ydoc) {
        ydoc.destroy()
        ydoc = null
    }
}

async function selectNote(id) {
    if (currentNoteId === id) return
    destroyEditor()
    currentNoteId = id
    editorInitialContent = null

    const note = notes.find(n => n.id === id)
    if (!note) return

    el.emptyState.style.display = 'none'
    el.editorWrapper.style.display = 'flex'
    el.noteTitle.value = note.title
    el.app.classList.add('editor-active')

    ydoc = new Y.Doc()

    const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    wsProvider = new WebsocketProvider(
        `${wsProtocol}//${location.host}`,
        id,
        ydoc,
        {
            connect: true,
            resyncInterval: 5000,
            disableBc: true,
        }
    )

    wsProvider.on('status', ({ status }) => {
        if (status === 'connected') {
            el.saveIndicator.textContent = '已连接'
            el.saveIndicator.className = 'save-indicator saved'
        } else if (status === 'connecting') {
            el.saveIndicator.textContent = '连接中...'
            el.saveIndicator.className = 'save-indicator saving'
        } else {
            el.saveIndicator.textContent = '离线'
            el.saveIndicator.className = 'save-indicator'
        }
    })

    wsProvider.awareness.setLocalStateField('user', {
        name: userName,
        color: userColor,
    })

    awarenessChangeHandler = () => {
        const states = wsProvider.awareness.getStates()
        const count = states.size
        const onlineEl = document.getElementById('onlineCount')
        if (onlineEl) {
            onlineEl.textContent = count > 1 ? `${count}人在线` : ''
        }
    }
    wsProvider.awareness.on('change', awarenessChangeHandler)

    let initialContent = note.content || ''
    if (typeof initialContent === 'string' && initialContent.length > 0) {
        const htmlContent = initialContent.split('\n').map(line =>
            `<p>${line || '<br>'}</p>`
        ).join('')
        initialContent = htmlContent
    } else {
        initialContent = '<p></p>'
    }

    const initEditor = (content) => {
        if (editor) return
        editor = new Editor({
            element: el.editorContent,
            extensions: [
                StarterKit.configure({
                    history: false,
                    undoRedo: false,
                    underline: false,
                }),
                Underline,
                Image.configure({
                    inline: false,
                    allowBase64: false,
                }),
                Placeholder.configure({
                    placeholder: '开始写笔记...',
                }),
                Collaboration.configure({
                    document: ydoc,
                }),
                BubbleMenu.configure({
                    element: el.bubbleMenu,
                    shouldShow: ({ state }) => {
                        const { from, to } = state.selection
                        return from !== to
                    },
                }),
            ],
            content: content,
            editorProps: {
                attributes: {
                    class: 'tiptap-editor',
                },
                handlePaste: (view, event) => {
                    const items = event.clipboardData?.items
                    if (!items) return false

                    for (const item of items) {
                        if (item.type.startsWith('image/')) {
                            event.preventDefault()
                            const file = item.getAsFile()
                            if (file) uploadAndInsertImage(file)
                            return true
                        }
                    }
                    return false
                },
                handleDrop: (view, event) => {
                    const files = event.dataTransfer?.files
                    if (!files || files.length === 0) return false

                    for (const file of files) {
                        if (file.type.startsWith('image/')) {
                            event.preventDefault()
                            uploadAndInsertImage(file)
                            return true
                        }
                    }
                    return false
                },
            },
            onUpdate: ({ editor }) => {
                const text = editor.getText()
                const note = notes.find(n => n.id === currentNoteId)
                if (note) {
                    note.content = text.substring(0, 100000)
                    var f = (x) => {
		    	console.log("type",typeof x)
			console.log("str",x)
		    }
		console.log(1)
		    f(editorInitialContent)
		console.log(2)
		    f(text)
		    if(editorInitialContent === null && text != ""){
                        editorInitialContent = text
			
                    }
                    if (editorInitialContent !== null && text !== editorInitialContent) {
                        note.updatedAt = new Date().toISOString()
                    }
                    renderNotesList()
                }
            },
        })
        window.editor = editor
        // 记录初始内容，用于检测真正的编辑
        renderNotesList()
    }

    // 立即用 initialContent 初始化编辑器，让用户立刻看到内容
    // Yjs 同步在后台进行，完成后自动更新编辑器
    initEditor(initialContent)
}

async function uploadAndInsertImage(file) {
    if (file.size > 3 * 1024 * 1024) {
        showToast('图片大小不能超过 3MB')
        return
    }

    const formData = new FormData()
    formData.append('image', file)

    try {
        const res = await fetch(`${API_BASE}/api/upload`, {
            method: 'POST',
            body: formData,
        })
        if (!res.ok) {
            const err = await res.json()
            showToast(err.error || '上传失败')
            return
        }
        const data = await res.json()
        if (editor) {
            editor.chain().focus().setImage({ src: data.url }).run()
        }
    } catch (err) {
        console.error('上传图片失败:', err)
        showToast('上传图片失败')
    }
}

function showToast(message) {
    const existing = document.querySelector('.toast')
    if (existing) existing.remove()

    const toast = document.createElement('div')
    toast.className = 'toast'
    toast.innerHTML = `<span>${escapeHtml(message)}</span>`
    document.body.appendChild(toast)
    setTimeout(() => toast.remove(), 3000)
}

function goBackToList() {
    destroyEditor()
    currentNoteId = null
    el.app.classList.remove('editor-active')
    el.editorWrapper.style.display = 'none'
    el.emptyState.style.display = 'flex'
    renderNotesList()
}

async function createNote() {
    try {
        const res = await fetch(`${API_BASE}/api/notes`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: '', content: '' })
        })
        const newNote = await res.json()
        notes.unshift(newNote)
        selectNote(newNote.id)
        renderNotesList()
    } catch (err) {
        console.error('创建笔记失败:', err)
    }
}

async function saveTitle() {
    if (!currentNoteId) return
    const note = notes.find(n => n.id === currentNoteId)
    if (!note) return

    try {
        await fetch(`${API_BASE}/api/notes/${currentNoteId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: el.noteTitle.value })
        })
        note.title = el.noteTitle.value
        note.updatedAt = new Date().toISOString()
        renderNotesList()
    } catch (err) {
        console.error('保存标题失败:', err)
    }
}

function scheduleTitleSave() {
    if (titleSaveTimeout) clearTimeout(titleSaveTimeout)
    titleSaveTimeout = setTimeout(saveTitle, 500)
}

function showDeleteToast(note) {
    if (pendingDelete) {
        clearTimeout(pendingDelete.timer)
        pendingDelete.toastEl.remove()
        fetch(`${API_BASE}/api/notes/${pendingDelete.note.id}`, { method: 'DELETE' })
            .catch(err => console.error('删除失败:', err))
    }

    const toast = document.createElement('div')
    toast.className = 'toast'
    toast.innerHTML = `<span>笔记已删除</span><button class="toast-undo">撤销</button>`
    document.body.appendChild(toast)

    const timer = setTimeout(() => {
        fetch(`${API_BASE}/api/notes/${note.id}`, { method: 'DELETE' })
            .catch(err => console.error('删除失败:', err))
        toast.remove()
        pendingDelete = null
    }, 4000)

    toast.querySelector('.toast-undo').addEventListener('click', async () => {
        clearTimeout(timer)
        toast.remove()
        pendingDelete = null
        notes.push(note)
        try {
            await fetch(`${API_BASE}/api/notes`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title: note.title, content: note.content, id: note.id })
            })
        } catch (err) {
            console.error('恢复笔记失败:', err)
        }
        selectNote(note.id)
        renderNotesList()
    })

    pendingDelete = { note, timer, toastEl: toast }
}

function deleteNote() {
    if (!currentNoteId) return
    const note = notes.find(n => n.id === currentNoteId)
    if (!note) return

    destroyEditor()
    notes = notes.filter(n => n.id !== currentNoteId)
    currentNoteId = null

    el.editorWrapper.style.display = 'none'
    el.emptyState.style.display = 'flex'
    el.app.classList.remove('editor-active')

    renderNotesList()
    showDeleteToast(note)
}

function setupBubbleMenu() {
    const btnBold = el.bubbleMenu.querySelector('[data-action="bold"]')
    const btnItalic = el.bubbleMenu.querySelector('[data-action="italic"]')
    const btnUnderline = el.bubbleMenu.querySelector('[data-action="underline"]')
    const btnStrike = el.bubbleMenu.querySelector('[data-action="strike"]')
    const btnCode = el.bubbleMenu.querySelector('[data-action="code"]')
    const btnH2 = el.bubbleMenu.querySelector('[data-action="h2"]')
    const btnH3 = el.bubbleMenu.querySelector('[data-action="h3"]')
    const btnBulletList = el.bubbleMenu.querySelector('[data-action="bulletList"]')
    const btnOrderedList = el.bubbleMenu.querySelector('[data-action="orderedList"]')
    const btnBlockquote = el.bubbleMenu.querySelector('[data-action="blockquote"]')
    const btnCodeBlock = el.bubbleMenu.querySelector('[data-action="codeBlock"]')

    const actions = [
        [btnBold, () => editor.chain().focus().toggleBold().run()],
        [btnItalic, () => editor.chain().focus().toggleItalic().run()],
        [btnUnderline, () => editor.chain().focus().toggleUnderline().run()],
        [btnStrike, () => editor.chain().focus().toggleStrike().run()],
        [btnCode, () => editor.chain().focus().toggleCode().run()],
        [btnH2, () => editor.chain().focus().toggleHeading({ level: 2 }).run()],
        [btnH3, () => editor.chain().focus().toggleHeading({ level: 3 }).run()],
        [btnBulletList, () => editor.chain().focus().toggleBulletList().run()],
        [btnOrderedList, () => editor.chain().focus().toggleOrderedList().run()],
        [btnBlockquote, () => editor.chain().focus().toggleBlockquote().run()],
        [btnCodeBlock, () => editor.chain().focus().toggleCodeBlock().run()],
    ]

    actions.forEach(([btn, fn]) => {
        if (btn) btn.addEventListener('click', fn)
    })
}

el.newNoteBtn.addEventListener('click', createNote)
el.deleteNoteBtn.addEventListener('click', deleteNote)
el.backBtn.addEventListener('click', goBackToList)
el.noteTitle.addEventListener('input', scheduleTitleSave)
el.searchInput.addEventListener('input', (e) => {
    searchQuery = e.target.value
    renderNotesList()
})
el.darkToggle.addEventListener('click', () => {
    isDark = !isDark
    localStorage.setItem('eznote-dark', isDark)
    applyDarkMode()
})

applyDarkMode()
setupBubbleMenu()
fetchNotes()
