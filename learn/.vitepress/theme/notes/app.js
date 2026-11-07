/**
 * 笔记应用：状态、界面、选区/元素/文档三种笔记、GitHub 账号同步。
 * 本地优先（离线可写），登录后与账号私有 Gist 合并同步。
 */
import * as gh from './github.js'
import * as anchors from './anchors.js'
import { renderMarkdown, TOOLBAR, applyToolbar } from './markdown.js'

const LOCAL_KEY = 'wn:notes:local'
const state = {
  token: '',
  user: null,
  gistId: '',
  notes: [],
  currentDoc: '/',
  filter: 'doc',
  view: 'list',
  status: 'local',
  statusText: '仅本机保存',
  dirty: false,
  syncing: false,
  editor: null,
  pendingSelection: null,
  activeElement: null
}

let els = {}
let syncTimer = null
let hideElemTimer = null

function notesKey() {
  return state.user ? `wn:notes:${state.user.login}` : LOCAL_KEY
}
function readNotes(key) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch { return [] }
}
function saveLocal() {
  try { localStorage.setItem(notesKey(), JSON.stringify(state.notes)) } catch { /* ignore */ }
}
function uid() {
  return `n_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}
function timeText(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}
function typeLabel(type) {
  return type === 'selection' ? '选区' : type === 'element' ? '要素' : '整篇'
}
function docTitle(path) {
  if (path === '/' || path === '/index') return '首页'
  const map = {
    '/guide/orientation': '站点导览', '/domain/proxy-basics': '代理与 CONNECT',
    '/domain/tls-mitm': '证书链与 MITM', '/domain/web-protocols': 'HTTP/2 与 WebSocket',
    '/domain/debugging-workflow': '抓包能力模型', '/architecture/overview': '全局架构',
    '/architecture/startup': '启动链路', '/architecture/process-config': '进程与配置',
    '/core/http-request': 'HTTP 请求旅程', '/core/connect-mitm': 'CONNECT 与解密',
    '/core/tunnel-websocket': '隧道与帧', '/core/capture-data': '抓包数据',
    '/modules/rules-engine': '规则引擎', '/modules/protocol-catalog': '指令体系',
    '/modules/certificates': '证书体系', '/modules/plugins': '插件系统',
    '/modules/webui': 'Web 管理界面', '/scenarios/index': '工程场景总览',
    '/advanced/hands-on': '动手实验', '/advanced/source-reading': '源码阅读',
    '/advanced/reference': '速查表', '/concepts/index': '概念精解总览',
    '/concepts/glossary': '术语索引'
  }
  const heading = document.querySelector('.vp-doc h1')
  return map[path] || (heading ? heading.textContent.trim() : path)
}

function setStatus(kind, text) {
  state.status = kind
  state.statusText = text
  refreshStatus()
}

function refreshStatus() {
  if (!els.status) return
  els.status.className = `wn-status wn-status-${state.status}`
  const dot = state.status === 'synced' ? '✓' : state.status === 'syncing' ? '…' : state.status === 'error' ? '!' : '·'
  els.status.innerHTML = `<span class="wn-status-dot">${dot}</span><span></span>`
  els.status.lastElementChild.textContent = state.statusText
  if (els.accountState) {
    els.accountState.textContent = state.user
      ? `${state.user.name}（${state.user.login}）· 私有 Gist`
      : '未连接 GitHub · 笔记仅保存在本浏览器'
  }
  if (els.syncBtn) els.syncBtn.disabled = !state.user || state.syncing
  if (els.loginBtn) els.loginBtn.textContent = state.user ? '切换 / 退出账号' : '连接 GitHub 账号'
}

function toast(message, kind = 'info') {
  if (!els.toast) return
  els.toast.textContent = message
  els.toast.className = `wn-toast wn-toast-${kind} is-visible`
  window.clearTimeout(toast.timer)
  toast.timer = window.setTimeout(() => { els.toast.className = 'wn-toast' }, 2800)
}

function buildUI() {
  const root = document.createElement('div')
  root.className = 'wn-root wn-ignore'
  root.innerHTML = `
    <button class="wn-fab" type="button" aria-label="打开学习笔记" title="学习笔记">
      <span class="wn-fab-icon">✎</span><span class="wn-fab-text">笔记</span><span class="wn-badge" hidden>0</span>
    </button>
    <div class="wn-selbar" hidden><button type="button">为选中内容记笔记</button></div>
    <button class="wn-elem-btn" type="button" hidden title="为这个要素记笔记">✎</button>
    <aside class="wn-drawer" aria-label="学习笔记">
      <header class="wn-head">
        <div><strong>学习笔记</strong><small>Markdown · 按 GitHub 账号同步</small></div>
        <button class="wn-icon-btn wn-close" type="button" title="关闭">×</button>
      </header>
      <div class="wn-account">
        <div class="wn-avatar" hidden></div>
        <div class="wn-account-txt"><span class="wn-account-state"></span><span class="wn-status"></span></div>
        <button class="wn-sync" type="button" title="立即同步">同步</button>
      </div>
      <nav class="wn-tabs">
        <button type="button" data-filter="doc" class="is-active">本篇</button>
        <button type="button" data-filter="all">全部</button>
        <button type="button" data-view="account">账号</button>
      </nav>
      <div class="wn-body">
        <div class="wn-list"></div>
        <div class="wn-account-view" hidden>
          <h3>GitHub 账号存储</h3>
          <p>笔记保存在<strong>你自己 GitHub 账号的私有 Gist</strong>里，按账号隔离，换设备输入同一个令牌即可继续。令牌只存在当前浏览器，请求只发往 api.github.com。</p>
          <button class="wn-primary wn-login" type="button">连接 GitHub 账号</button>
          <div class="wn-token-box" hidden>
            <label for="wn-token">GitHub Personal Access Token（classic，勾选 <code>gist</code>）</label>
            <input id="wn-token" type="password" autocomplete="off" spellcheck="false" placeholder="ghp_...">
            <div class="wn-token-actions">
              <button class="wn-primary wn-token-save" type="button">校验并连接</button>
              <a href="${gh.TOKEN_HELP_URL}" target="_blank" rel="noopener noreferrer">创建令牌</a>
            </div>
            <p class="wn-hint">只需 <code>gist</code> 一项权限，请勿勾选其它权限。私有 Gist 不会出现在公开列表，但知道链接的人可访问，请勿存放敏感信息。</p>
          </div>
          <button class="wn-ghost wn-logout" type="button" hidden>退出登录（保留本机笔记）</button>
          <h3>数据与同步</h3>
          <p>离线也能写，改动会先落在本机并标记为待同步；连接账号后自动合并到 Gist。同一条笔记以最后修改时间为准。</p>
          <button class="wn-ghost wn-export" type="button">导出全部笔记（JSON）</button>
        </div>
      </div>
      <footer class="wn-foot"><button class="wn-primary wn-new" type="button">＋ 新建整篇笔记</button></footer>
    </aside>
    <div class="wn-modal" hidden>
      <div class="wn-modal-card" role="dialog" aria-modal="true" aria-label="编辑笔记">
        <header class="wn-modal-head"><span class="wn-modal-title">新建笔记</span><button class="wn-icon-btn wn-modal-close" type="button">×</button></header>
        <div class="wn-quote" hidden></div>
        <div class="wn-toolbar"></div>
        <div class="wn-editor-wrap">
          <textarea class="wn-textarea" spellcheck="false" placeholder="用 Markdown 记录…支持 **粗体**、列表、代码块、链接"></textarea>
          <div class="wn-preview" hidden></div>
        </div>
        <footer class="wn-modal-foot">
          <div class="wn-mode"><button type="button" data-mode="edit" class="is-active">编辑</button><button type="button" data-mode="preview">预览</button></div>
          <div class="wn-modal-actions">
            <button class="wn-ghost wn-delete" type="button" hidden>删除</button>
            <button class="wn-ghost wn-cancel" type="button">取消</button>
            <button class="wn-primary wn-save" type="button">保存</button>
          </div>
        </footer>
      </div>
    </div>
    <div class="wn-toast"></div>
  `
  document.body.appendChild(root)

  const q = (selector) => root.querySelector(selector)
  els = {
    root,
    fab: q('.wn-fab'), badge: q('.wn-badge'),
    selbar: q('.wn-selbar'), elemBtn: q('.wn-elem-btn'),
    drawer: q('.wn-drawer'), close: q('.wn-close'),
    avatar: q('.wn-avatar'), accountState: q('.wn-account-state'), status: q('.wn-status'),
    syncBtn: q('.wn-sync'), tabs: q('.wn-tabs'),
    list: q('.wn-list'), accountView: q('.wn-account-view'),
    loginBtn: q('.wn-login'), tokenBox: q('.wn-token-box'), tokenInput: q('#wn-token'),
    tokenSave: q('.wn-token-save'), logout: q('.wn-logout'), exportBtn: q('.wn-export'),
    newBtn: q('.wn-new'),
    modal: q('.wn-modal'), modalTitle: q('.wn-modal-title'), quote: q('.wn-quote'),
    toolbar: q('.wn-toolbar'), textarea: q('.wn-textarea'), preview: q('.wn-preview'),
    mode: q('.wn-mode'), save: q('.wn-save'), cancel: q('.wn-cancel'),
    delete: q('.wn-delete'), modalClose: q('.wn-modal-close'),
    toast: q('.wn-toast')
  }

  els.toolbar.innerHTML = TOOLBAR.map((action) =>
    `<button type="button" data-action="${action.id}" title="${action.title}">${action.label}</button>`
  ).join('')
}

function bindEvents() {
  els.fab.addEventListener('click', () => els.drawer.classList.toggle('is-open'))
  els.close.addEventListener('click', () => els.drawer.classList.remove('is-open'))

  els.tabs.addEventListener('click', (event) => {
    const button = event.target.closest('button')
    if (!button) return
    if (button.dataset.filter) {
      state.filter = button.dataset.filter
      state.view = 'list'
      els.tabs.querySelectorAll('button').forEach((item) => item.classList.remove('is-active'))
      button.classList.add('is-active')
    } else {
      state.view = state.view === 'account' ? 'list' : 'account'
      els.tabs.querySelectorAll('button').forEach((item) => {
        item.classList.toggle('is-active', item.dataset.view === 'account' ? state.view === 'account' : false)
      })
    }
    renderView()
  })

  els.syncBtn.addEventListener('click', () => pushAll())
  els.newBtn.addEventListener('click', () => openEditor({ type: 'page', anchor: null, quote: '' }))

  els.loginBtn.addEventListener('click', () => {
    els.tokenBox.hidden = !els.tokenBox.hidden
    if (!els.tokenBox.hidden) els.tokenInput.focus()
  })
  els.tokenSave.addEventListener('click', () => signIn(els.tokenInput.value.trim()))
  els.tokenInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') signIn(els.tokenInput.value.trim())
  })
  els.logout.addEventListener('click', signOut)
  els.exportBtn.addEventListener('click', exportNotes)

  els.selbar.addEventListener('mousedown', (event) => event.preventDefault())
  els.selbar.querySelector('button').addEventListener('click', () => {
    const pending = state.pendingSelection
    hideSelectionBar()
    if (!pending) return
    openEditor({ type: 'selection', anchor: pending.anchor, quote: pending.quote })
  })

  els.elemBtn.addEventListener('mouseenter', () => window.clearTimeout(hideElemTimer))
  els.elemBtn.addEventListener('mouseleave', () => { els.elemBtn.hidden = true })
  els.elemBtn.addEventListener('click', () => {
    const element = state.activeElement
    els.elemBtn.hidden = true
    if (!element) return
    const anchor = anchors.serializeElement(element)
    if (!anchor) return
    openEditor({
      type: 'element',
      anchor,
      quote: (element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200)
    })
  })

  els.toolbar.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]')
    if (!button) return
    const action = TOOLBAR.find((item) => item.id === button.dataset.action)
    if (state.mode === 'preview') switchMode('edit')
    applyToolbar(els.textarea, action)
  })
  els.textarea.addEventListener('input', updatePreview)
  els.mode.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-mode]')
    if (button) switchMode(button.dataset.mode)
  })
  els.save.addEventListener('click', saveEditor)
  els.cancel.addEventListener('click', closeEditor)
  els.modalClose.addEventListener('click', closeEditor)
  els.delete.addEventListener('click', deleteFromEditor)
  els.modal.addEventListener('mousedown', (event) => {
    if (event.target === els.modal) closeEditor()
  })

  els.list.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-act]')
    if (!button) return
    const note = state.notes.find((item) => item.id === button.dataset.id)
    if (!note) return
    const action = button.dataset.act
    if (action === 'locate') {
      if (note.doc !== state.currentDoc) {
        toast('这条笔记在其它文档，请先跳转到该篇', 'info')
        return
      }
      if (!anchors.focusNote(note)) toast('原文已变化，暂时无法定位', 'warn')
    } else if (action === 'edit') {
      openEditor({ note })
    } else if (action === 'del') {
      if (!window.confirm('确定删除这条笔记？')) return
      state.notes = state.notes.filter((item) => item.id !== note.id)
      afterChange('已删除笔记')
    }
  })

  document.addEventListener('mouseup', onSelectionEnd)
  document.addEventListener('keyup', (event) => { if (event.key === 'Shift') onSelectionEnd() })
  document.addEventListener('mousedown', (event) => {
    if (!els.selbar.hidden && !els.selbar.contains(event.target)) hideSelectionBar()
  })
  document.addEventListener('mouseover', onElementHover)
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (!els.modal.hidden) closeEditor()
      else els.drawer.classList.remove('is-open')
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && !els.modal.hidden) {
      event.preventDefault()
      saveEditor()
    }
  })
  window.addEventListener('scroll', () => { if (!els.elemBtn.hidden) els.elemBtn.hidden = true }, { passive: true })
}

function onSelectionEnd() {
  window.setTimeout(() => {
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      hideSelectionBar()
      return
    }
    const range = selection.getRangeAt(0)
    const root = anchors.getRoot()
    if (!root || !root.contains(range.commonAncestorContainer)) {
      hideSelectionBar()
      return
    }
    const quote = range.toString().replace(/\s+/g, ' ').trim()
    if (quote.length < 2) { hideSelectionBar(); return }
    const anchor = anchors.serializeSelection(range)
    if (!anchor) { hideSelectionBar(); return }
    state.pendingSelection = { anchor, quote }
    const rect = range.getBoundingClientRect()
    els.selbar.hidden = false
    const left = Math.max(12, Math.min(window.innerWidth - 190, rect.left + rect.width / 2 - 90))
    const top = Math.max(12, rect.top - 46)
    els.selbar.style.left = `${left}px`
    els.selbar.style.top = `${top}px`
  }, 10)
}

function hideSelectionBar() {
  if (els.selbar) els.selbar.hidden = true
}

function onElementHover(event) {
  const root = anchors.getRoot()
  if (!root || els.root.contains(event.target)) return
  const selector = anchors.ELEMENT_TAGS.join(',')
  const element = event.target.closest && event.target.closest(selector)
  if (!element || !root.contains(element)) {
    window.clearTimeout(hideElemTimer)
    hideElemTimer = window.setTimeout(() => { els.elemBtn.hidden = true }, 160)
    return
  }
  window.clearTimeout(hideElemTimer)
  state.activeElement = element
  const rect = element.getBoundingClientRect()
  els.elemBtn.hidden = false
  els.elemBtn.style.top = `${Math.max(8, rect.top + 4)}px`
  els.elemBtn.style.left = `${Math.max(4, rect.left - 34)}px`
}

function renderView() {
  els.list.hidden = state.view === 'account'
  els.accountView.hidden = state.view !== 'account'
  els.newBtn.disabled = state.view === 'account'
  renderList()
  refreshStatus()
}

function renderList() {
  const notes = state.filter === 'doc'
    ? state.notes.filter((note) => note.doc === state.currentDoc)
    : state.notes
  const visible = [...notes].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))

  if (!visible.length) {
    els.list.innerHTML = `<div class="wn-empty"><strong>还没有笔记</strong><p>选中一段文字、把鼠标移到段落左侧点 ✎，或点下方「新建整篇笔记」。内容支持 Markdown。</p></div>`
    return
  }

  let lastDoc = null
  const parts = []
  visible.forEach((note) => {
    if (state.filter === 'all' && note.doc !== lastDoc) {
      lastDoc = note.doc
      parts.push(`<div class="wn-group">${escapeText(docTitle(note.doc))} <span>${escapeText(note.doc)}</span></div>`)
    }
    const reference = note.type === 'selection'
      ? `<div class="wn-ref">选区：${escapeText((note.quote || '').slice(0, 110))}</div>`
      : note.type === 'element'
        ? `<div class="wn-ref">要素：${escapeText(anchors.elementLabel(note.anchor))}</div>`
        : '<div class="wn-ref">整篇文档</div>'
    parts.push(`
      <article class="wn-card" data-id="${note.id}">
        <div class="wn-card-top">
          <span class="wn-tag wn-tag-${note.type}">${typeLabel(note.type)}</span>
          <time>${escapeText(timeText(note.updatedAt))}</time>
        </div>
        ${reference}
        <div class="wn-card-body">${renderMarkdown(note.content || '')}</div>
        <div class="wn-card-actions">
          ${note.type !== 'page' ? `<button type="button" data-act="locate" data-id="${note.id}">定位原文</button>` : ''}
          <button type="button" data-act="edit" data-id="${note.id}">编辑</button>
          <button type="button" data-act="del" data-id="${note.id}">删除</button>
        </div>
      </article>
    `)
  })
  els.list.innerHTML = parts.join('')
}

function escapeText(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function refreshBadge() {
  const count = state.notes.filter((note) => note.doc === state.currentDoc).length
  els.badge.hidden = count === 0
  els.badge.textContent = String(count)
}

function refresh() {
  renderView()
  refreshBadge()
  applyHighlightsSafe()
}

function applyHighlightsSafe() {
  window.setTimeout(() => anchors.applyHighlights(state.notes, state.currentDoc), 60)
  window.setTimeout(() => anchors.applyHighlights(state.notes, state.currentDoc), 420)
}

function openEditor(options) {
  const note = options.note
  state.editor = {
    id: note ? note.id : null,
    type: note ? note.type : options.type,
    anchor: note ? note.anchor : options.anchor,
    quote: note ? note.quote : options.quote,
    doc: note ? note.doc : state.currentDoc,
    createdAt: note ? note.createdAt : new Date().toISOString()
  }
  els.modalTitle.textContent = note ? '编辑笔记' : '新建笔记'
  els.textarea.value = note ? note.content || '' : ''
  els.delete.hidden = !note
  if (state.editor.quote) {
    els.quote.hidden = false
    els.quote.textContent = state.editor.type === 'selection'
      ? `“${state.editor.quote.slice(0, 180)}”`
      : anchors.elementLabel(state.editor.anchor)
  } else {
    els.quote.hidden = true
  }
  switchMode('edit')
  els.modal.hidden = false
  document.body.classList.add('wn-no-scroll')
  window.setTimeout(() => els.textarea.focus(), 30)
}

function switchMode(mode) {
  state.mode = mode
  els.mode.querySelectorAll('button').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.mode === mode)
  })
  els.textarea.hidden = mode === 'preview'
  els.preview.hidden = mode !== 'preview'
  els.toolbar.style.opacity = mode === 'preview' ? '0.45' : '1'
  els.toolbar.style.pointerEvents = mode === 'preview' ? 'none' : 'auto'
  updatePreview()
}

function updatePreview() {
  if (els.preview) els.preview.innerHTML = renderMarkdown(els.textarea.value)
}

function closeEditor() {
  els.modal.hidden = true
  document.body.classList.remove('wn-no-scroll')
  state.editor = null
}

function saveEditor() {
  const editor = state.editor
  if (!editor) return
  const content = els.textarea.value.trim()
  if (!content) { toast('请先写点内容', 'warn'); return }
  const now = new Date().toISOString()
  const existing = state.notes.find((note) => note.id === editor.id)
  const record = {
    id: editor.id || uid(),
    doc: editor.doc,
    docTitle: docTitle(editor.doc),
    type: editor.type,
    anchor: editor.anchor,
    quote: editor.quote || '',
    content,
    createdAt: editor.createdAt,
    updatedAt: now
  }
  if (existing) Object.assign(existing, record)
  else state.notes.unshift(record)
  closeEditor()
  afterChange(existing ? '笔记已更新' : '笔记已保存')
}

function deleteFromEditor() {
  const editor = state.editor
  if (!editor || !editor.id) return
  if (!window.confirm('确定删除这条笔记？')) return
  state.notes = state.notes.filter((note) => note.id !== editor.id)
  closeEditor()
  afterChange('已删除笔记')
}

function afterChange(message) {
  saveLocal()
  state.dirty = true
  refresh()
  toast(message, 'ok')
  scheduleSync()
}

function scheduleSync() {
  window.clearTimeout(syncTimer)
  if (!state.token || !state.user) {
    setStatus('local', '仅本机保存')
    return
  }
  setStatus('dirty', '有改动待同步')
  syncTimer = window.setTimeout(() => pushAll(), 1800)
}

async function pushAll() {
  if (!state.token || !state.user || state.syncing) return
  state.syncing = true
  setStatus('syncing', '正在同步…')
  try {
    const data = {
      version: 1,
      owner: state.user.login,
      updatedAt: new Date().toISOString(),
      notes: state.notes
    }
    if (!state.gistId) {
      state.gistId = await gh.createGist(state.token, data)
      gh.setGistId(state.user.login, state.gistId)
    } else {
      await gh.updateGist(state.token, state.gistId, data)
    }
    state.dirty = false
    setStatus('synced', `已同步 · ${state.user.login}`)
    toast('笔记已同步到你的 GitHub Gist', 'ok')
  } catch (error) {
    if (error.status === 404) {
      state.gistId = ''
      gh.setGistId(state.user.login, '')
      setStatus('error', 'Gist 不存在，下次同步将自动重建')
    } else {
      setStatus('error', error.message)
    }
    toast(error.message, 'error')
  } finally {
    state.syncing = false
    refreshStatus()
  }
}

async function connectWithToken(token, { remember = true } = {}) {
  if (!token) { toast('请先填写 GitHub Token', 'warn'); return }
  setStatus('syncing', '正在校验令牌…')
  try {
    const user = await gh.fetchUser(token)
    const localDraft = readNotes(LOCAL_KEY)
    state.token = token
    state.user = user
    if (remember) gh.setToken(token)
    state.gistId = gh.getGistId(user.login)
    state.notes = readNotes(notesKey())

    const remote = await gh.loadGist(token, state.gistId)
    if (remote.notFound) {
      state.gistId = ''
      gh.setGistId(user.login, '')
    }
    const merged = gh.mergeData(
      { owner: user.login, notes: [...state.notes, ...localDraft] },
      remote.data || { owner: user.login, notes: [] }
    )
    state.notes = merged.notes
    saveLocal()
    if (localDraft.length) {
      try { localStorage.removeItem(LOCAL_KEY) } catch { /* ignore */ }
    }

    if (els.avatar) {
      els.avatar.hidden = false
      els.avatar.innerHTML = user.avatar
        ? `<img src="${escapeText(user.avatar)}" alt="">`
        : ''
    }
    if (els.logout) els.logout.hidden = false
    if (els.tokenBox) els.tokenBox.hidden = true
    if (els.tokenInput) els.tokenInput.value = ''
    refresh()
    await pushAll()
  } catch (error) {
    // 认证失效才清令牌；网络抖动保留，下次访问自动重试
    if (error.status === 401 || error.status === 403) gh.clearToken()
    state.token = ''
    state.user = null
    state.gistId = ''
    saveLocal() // 保留当前笔记到本机，避免刷新后「看不见」
    setStatus('error', error.message)
    toast(error.message, 'error')
    refresh()
  }
}

function signIn(token) { return connectWithToken(token) }

function signOut() {
  gh.clearToken()
  state.token = ''
  state.user = null
  state.gistId = ''
  state.notes = readNotes(LOCAL_KEY)
  if (els.avatar) { els.avatar.hidden = true; els.avatar.innerHTML = '' }
  if (els.logout) els.logout.hidden = true
  if (els.tokenBox) els.tokenBox.hidden = true
  setStatus('local', '仅本机保存')
  refresh()
  toast('已退出，笔记仍保留在本浏览器', 'info')
}

function exportNotes() {
  const blob = new Blob([JSON.stringify({
    version: 1,
    owner: state.user ? state.user.login : 'local',
    exportedAt: new Date().toISOString(),
    notes: state.notes
  }, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = 'whistle-study-notes.json'
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function restoreSession() {
  const token = gh.getToken()
  if (!token) {
    setStatus('local', '仅本机保存')
    return
  }
  connectWithToken(token, { remember: false })
}

/** VitePress 是 SPA：轮询路径变化，比依赖 router 回调更稳妥 */
function watchPath() {
  const current = anchors.docPath()
  if (current !== state.currentDoc) onNotesRouteChange()
  window.setTimeout(watchPath, 400)
}

export function initNotes() {
  if (typeof window === 'undefined') return
  buildUI()
  bindEvents()
  state.currentDoc = anchors.docPath()
  state.notes = readNotes(LOCAL_KEY)
  refresh()
  restoreSession()
  window.setTimeout(watchPath, 400)
}

export function onNotesRouteChange() {
  if (typeof window === 'undefined' || !els.root) return
  state.currentDoc = anchors.docPath()
  state.pendingSelection = null
  hideSelectionBar()
  refresh()
}
