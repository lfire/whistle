/**
 * 笔记应用：状态、界面、选区/要素/文档三种笔记、标签与复习、GitHub 账号同步。
 * 本地优先（离线可写），登录后与账号私有 Gist 合并同步。
 */
import * as gh from './github.js'
import * as anchors from './anchors.js'
import { renderMarkdown, TOOLBAR, applyToolbar } from './markdown.js'

const LOCAL_KEY = 'wn:notes:local'
const DRAFT_KEY = 'wn:draft'

const TAGS = [
  { id: 'plain', label: '普通' },
  { id: 'focus', label: '重点' },
  { id: 'question', label: '疑问' },
  { id: 'todo', label: '待办' },
  { id: 'insight', label: '心得' }
]
const TEMPLATES = {
  plain: '',
  focus: '### 为什么重要\n\n',
  question: '### 我的疑问\n\n\n\n### 待查证\n\n- [ ] \n',
  todo: '### 待办\n\n- [ ] \n',
  insight: '### 我的理解\n\n'
}
const QUICK_TAGS = ['plain', 'focus', 'question', 'todo']

const state = {
  token: '', user: null, gistId: '',
  notes: [], currentDoc: '/',
  filter: 'doc', view: 'list',
  status: 'local', statusText: '仅本机保存',
  dirty: false, syncing: false,
  query: '', tagFilter: 'all', sort: 'newest',
  editor: null, mode: 'edit', editorTag: 'plain',
  pendingSelection: null, activeElement: null,
  expanded: new Set(),
  review: { index: 0, revealed: false, masteredOnly: false },
  draftAvailable: false
}

let els = {}
let syncTimer = null
let hideElemTimer = null
let draftTimer = null
let emphasizeTimer = null

/* ---------- 基础工具 ---------- */

function notesKey() { return state.user ? `wn:notes:${state.user.login}` : LOCAL_KEY }
function readNotes(key) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || '[]')
    return Array.isArray(parsed) ? parsed.map(normalizeNote) : []
  } catch { return [] }
}
function normalizeNote(note) {
  return {
    id: note.id || uid(),
    doc: note.doc || '/',
    docTitle: note.docTitle || note.doc || '/',
    section: note.section || '',
    type: note.type || 'page',
    anchor: note.anchor || null,
    quote: note.quote || '',
    content: note.content || '',
    tag: note.tag || 'plain',
    mastered: !!note.mastered,
    createdAt: note.createdAt || new Date().toISOString(),
    updatedAt: note.updatedAt || note.createdAt || new Date().toISOString()
  }
}
function saveLocal() {
  try { localStorage.setItem(notesKey(), JSON.stringify(state.notes)) } catch { /* ignore */ }
}
function uid() { return `n_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}` }
function tagLabel(id) { return (TAGS.find((tag) => tag.id === id) || TAGS[0]).label }
function typeLabel(type) { return type === 'selection' ? '选区' : type === 'element' ? '要素' : '整篇' }
function timeText(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}
function relativeTime(value) {
  const diff = Date.now() - new Date(value).getTime()
  if (Number.isNaN(diff)) return ''
  if (diff < 60000) return '刚刚'
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`
  return `${Math.floor(diff / 86400000)} 天前`
}
function escapeText(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
function docTitle(path) {
  if (path === '/' || path === '/index') return '首页'
  const heading = document.querySelector('.vp-doc h1')
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
  return map[path] || (heading ? heading.textContent.trim() : path)
}
function nearestHeading(element) {
  const root = anchors.getRoot()
  if (!root) return ''
  let target = element
  if (!target) {
    const node = window.getSelection() && window.getSelection().anchorNode
    target = node && node.parentElement
  }
  if (!target) return ''
  const top = target.getBoundingClientRect().top
  let best = ''
  for (const heading of root.querySelectorAll('h2, h3')) {
    if (heading.getBoundingClientRect().top <= top + 10) best = heading.textContent.trim()
    else break
  }
  return best.slice(0, 80)
}
function setStatus(kind, text) {
  state.status = kind
  state.statusText = text
  refreshStatus()
}
function toast(message, kind = 'info') {
  if (!els.toast) return
  els.toast.textContent = message
  els.toast.className = `wn-toast wn-toast-${kind} is-visible`
  window.clearTimeout(toast.timer)
  toast.timer = window.setTimeout(() => { els.toast.className = 'wn-toast' }, 2600)
}

/* ---------- 界面骨架 ---------- */

function buildUI() {
  const root = document.createElement('div')
  root.className = 'wn-root wn-ignore'
  root.innerHTML = `
    <button class="wn-fab" type="button" aria-label="打开学习笔记" title="学习笔记（N 新建）">
      <span class="wn-fab-icon">✎</span><span class="wn-fab-text">笔记</span><span class="wn-badge" hidden>0</span>
    </button>
    <div class="wn-selbar" hidden>
      <span class="wn-selbar-label">标记</span>
      ${QUICK_TAGS.map((tag) => `<button type="button" data-quick="${tag}" class="wn-q-${tag}">${tagLabel(tag)}</button>`).join('')}
      <button type="button" data-quick="compose" class="wn-q-compose">写笔记…</button>
    </div>
    <button class="wn-elem-btn" type="button" hidden title="为这个要素记笔记">✎</button>
    <aside class="wn-drawer" aria-label="学习笔记">
      <header class="wn-head">
        <div class="wn-head-main"><strong>学习笔记</strong><span class="wn-stat"></span></div>
        <button class="wn-icon-btn wn-close" type="button" title="关闭">×</button>
      </header>
      <div class="wn-account">
        <div class="wn-avatar" hidden></div>
        <div class="wn-account-txt"><span class="wn-account-state"></span><span class="wn-status"></span></div>
        <button class="wn-sync" type="button" title="立即同步">同步</button>
      </div>
      <div class="wn-tools">
        <div class="wn-search-wrap">
          <span class="wn-search-icon">⌕</span>
          <input class="wn-search" type="search" placeholder="搜索笔记…" autocomplete="off">
        </div>
        <button class="wn-sort" type="button" title="切换排序">最新</button>
      </div>
      <div class="wn-filters"></div>
      <nav class="wn-tabs">
        <button type="button" data-view="list" data-filter="doc" class="is-active">本篇</button>
        <button type="button" data-view="list" data-filter="all">全部</button>
        <button type="button" data-view="review">复习</button>
        <button type="button" data-view="account">账号</button>
      </nav>
      <div class="wn-body">
        <div class="wn-list"></div>
        <div class="wn-review" hidden></div>
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
            <p class="wn-hint">只需 <code>gist</code> 一项权限。私有 Gist 不出现在公开列表，但知道链接的人可访问，请勿存放敏感信息。</p>
          </div>
          <button class="wn-ghost wn-logout" type="button" hidden>退出登录（保留本机笔记）</button>
          <h3>数据与同步</h3>
          <p>离线也能写，改动先落在本机；连接账号后按笔记 id 合并（最后修改者为准）并自动同步。</p>
          <div class="wn-export-row">
            <button class="wn-ghost wn-export" type="button">导出 JSON</button>
            <button class="wn-ghost wn-export-md" type="button">导出 Markdown</button>
          </div>
        </div>
      </div>
      <footer class="wn-foot">
        <button class="wn-primary wn-new" type="button">＋ 新建整篇笔记</button>
        <span class="wn-shortcut">N 新建 · / 搜索 · Esc 关闭</span>
      </footer>
    </aside>
    <div class="wn-modal" hidden>
      <div class="wn-modal-card" role="dialog" aria-modal="true" aria-label="编辑笔记">
        <header class="wn-modal-head">
          <div><span class="wn-modal-title">新建笔记</span><span class="wn-modal-sub"></span></div>
          <div class="wn-tag-picker"></div>
          <button class="wn-icon-btn wn-modal-close" type="button">×</button>
        </header>
        <div class="wn-quote" hidden><span class="wn-quote-text"></span><button class="wn-insert-quote" type="button" title="把原文插入笔记">插入原文</button></div>
        <div class="wn-toolbar"></div>
        <div class="wn-editor-wrap">
          <textarea class="wn-textarea" spellcheck="false" placeholder="用 Markdown 记录…支持 **粗体**、列表、代码块、链接"></textarea>
          <div class="wn-preview" hidden></div>
        </div>
        <div class="wn-editor-status">
          <span class="wn-count">0 字</span>
          <span class="wn-editor-hint">Markdown · Ctrl/⌘ + Enter 保存</span>
          <button class="wn-restore" type="button" hidden>恢复上次草稿</button>
        </div>
        <footer class="wn-modal-foot">
          <div class="wn-mode">
            <button type="button" data-mode="edit" class="is-active">编辑</button>
            <button type="button" data-mode="split">分栏</button>
            <button type="button" data-mode="preview">预览</button>
          </div>
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
    drawer: q('.wn-drawer'), close: q('.wn-close'), stat: q('.wn-stat'),
    avatar: q('.wn-avatar'), accountState: q('.wn-account-state'), status: q('.wn-status'),
    syncBtn: q('.wn-sync'), search: q('.wn-search'), sort: q('.wn-sort'),
    filters: q('.wn-filters'), tabs: q('.wn-tabs'),
    list: q('.wn-list'), review: q('.wn-review'), accountView: q('.wn-account-view'),
    loginBtn: q('.wn-login'), tokenBox: q('.wn-token-box'), tokenInput: q('#wn-token'),
    tokenSave: q('.wn-token-save'), logout: q('.wn-logout'),
    exportBtn: q('.wn-export'), exportMd: q('.wn-export-md'), newBtn: q('.wn-new'),
    modal: q('.wn-modal'), modalTitle: q('.wn-modal-title'), modalSub: q('.wn-modal-sub'),
    tagPicker: q('.wn-tag-picker'), quote: q('.wn-quote'), quoteText: q('.wn-quote-text'),
    insertQuote: q('.wn-insert-quote'),
    toolbar: q('.wn-toolbar'), editorWrap: q('.wn-editor-wrap'),
    textarea: q('.wn-textarea'), preview: q('.wn-preview'),
    count: q('.wn-count'), restore: q('.wn-restore'),
    mode: q('.wn-mode'), save: q('.wn-save'), cancel: q('.wn-cancel'),
    delete: q('.wn-delete'), modalClose: q('.wn-modal-close'), toast: q('.wn-toast')
  }

  els.toolbar.innerHTML = TOOLBAR.map((action) =>
    `<button type="button" data-action="${action.id}" title="${action.title}">${action.label}</button>`
  ).join('')
  els.tagPicker.innerHTML = TAGS.map((tag) =>
    `<button type="button" data-tag="${tag.id}" class="wn-chip wn-chip-${tag.id}">${tag.label}</button>`
  ).join('')
  els.filters.innerHTML = [{ id: 'all', label: '全部标签' }].concat(TAGS).map((tag) =>
    `<button type="button" data-tag="${tag.id}" class="wn-filter-chip${tag.id === 'all' ? ' is-active' : ''}">${tag.label}</button>`
  ).join('')
}

/* ---------- 状态显示 ---------- */

function refreshStatus() {
  if (!els.status) return
  els.status.className = `wn-status wn-status-${state.status}`
  const dot = state.status === 'synced' ? '✓' : state.status === 'syncing' ? '…'
    : state.status === 'error' ? '!' : state.status === 'dirty' ? '↑' : '·'
  els.status.innerHTML = `<span class="wn-status-dot">${dot}</span><span></span>`
  els.status.lastElementChild.textContent = state.statusText
  if (els.accountState) {
    els.accountState.textContent = state.user
      ? `${state.user.name}（${state.user.login}）· 私有 Gist`
      : '未连接 GitHub'
  }
  if (els.syncBtn) els.syncBtn.disabled = !state.user || state.syncing
  if (els.loginBtn) els.loginBtn.textContent = state.user ? '切换 / 退出账号' : '连接 GitHub 账号'
}

function refreshStats() {
  if (!els.stat) return
  const current = state.notes.filter((note) => note.doc === state.currentDoc).length
  const latest = state.notes.reduce((max, note) => Math.max(max, new Date(note.updatedAt).getTime() || 0), 0)
  els.stat.textContent = `本篇 ${current} 条 · 共 ${state.notes.length} 条${latest ? ` · ${relativeTime(latest)}` : ''}`
  els.badge.hidden = current === 0
  els.badge.textContent = String(current)
}

function refresh() {
  renderView()
  refreshBadge()
  window.setTimeout(() => anchors.applyHighlights(state.notes, state.currentDoc), 60)
  window.setTimeout(() => anchors.applyHighlights(state.notes, state.currentDoc), 420)
}
function refreshBadge() { refreshStats() }

/* ---------- 列表、筛选、复习 ---------- */

function filteredNotes() {
  const query = state.query.trim().toLowerCase()
  return state.notes
    .filter((note) => state.filter === 'all' || note.doc === state.currentDoc)
    .filter((note) => state.tagFilter === 'all' || note.tag === state.tagFilter)
    .filter((note) => !query || [note.content, note.quote, note.docTitle, note.section, tagLabel(note.tag)]
      .join(' ').toLowerCase().includes(query))
    .sort((a, b) => state.sort === 'newest'
      ? new Date(b.updatedAt) - new Date(a.updatedAt)
      : new Date(a.updatedAt) - new Date(b.updatedAt))
}

function renderView() {
  const view = state.view
  els.list.hidden = view !== 'list'
  els.review.hidden = view !== 'review'
  els.accountView.hidden = view !== 'account'
  els.search.closest('.wn-tools').hidden = view === 'account'
  els.filters.hidden = view === 'account'
  els.newBtn.disabled = view !== 'list'
  els.tabs.querySelectorAll('button').forEach((button) => {
    const matches = button.dataset.view === view &&
      (view !== 'list' || button.dataset.filter === state.filter)
    button.classList.toggle('is-active', matches)
  })
  if (view === 'list') renderList()
  if (view === 'review') renderReview()
  refreshStatus()
  refreshStats()
}

function referenceHtml(note) {
  if (note.type === 'selection') {
    const quote = (note.quote || '').replace(/\s+/g, ' ').trim()
    return `选区：${escapeText(quote.slice(0, 48))}${quote.length > 48 ? '…（原文见下方引用）' : ''}`
  }
  if (note.type === 'element') return `要素：${escapeText(anchors.elementLabel(note.anchor))}`
  return '整篇文档'
}

function renderList() {
  const notes = filteredNotes()
  if (!notes.length) {
    const hint = state.query || state.tagFilter !== 'all'
      ? '试试清空搜索或切换标签。'
      : '选中一段文字快速标记，把鼠标移到段落左侧点 ✎，或点下方「新建整篇笔记」。'
    els.list.innerHTML = `<div class="wn-empty"><div class="wn-empty-art"><span></span><span></span><span></span></div><strong>${state.query || state.tagFilter !== 'all' ? '没有匹配的笔记' : '还没有笔记'}</strong><p>${hint}</p></div>`
    return
  }
  let lastDoc = null
  const parts = []
  notes.forEach((note) => {
    if (state.filter === 'all' && note.doc !== lastDoc) {
      lastDoc = note.doc
      const count = notes.filter((item) => item.doc === note.doc).length
      parts.push(`<div class="wn-group">${escapeText(note.docTitle || docTitle(note.doc))}<span>${count} 条 · ${escapeText(note.doc)}</span></div>`)
    }
    const clamp = (note.content || '').length > 130
    parts.push(`
      <article class="wn-card wn-card-${note.tag}" data-id="${note.id}">
        <div class="wn-card-top">
          <div class="wn-card-tags"><span class="wn-tag wn-tag-${note.type}">${typeLabel(note.type)}</span><span class="wn-tag-label wn-tag-label-${note.tag}">${tagLabel(note.tag)}</span>${note.mastered ? '<span class="wn-mastered">已掌握</span>' : ''}</div>
          <time>${escapeText(timeText(note.updatedAt))}</time>
        </div>
        ${note.section ? `<div class="wn-section">${escapeText(note.section)}</div>` : ''}
        <div class="wn-ref">${referenceHtml(note)}</div>
        <div class="wn-card-body${clamp && !state.expanded.has(note.id) ? ' is-clamped' : ''}">${renderMarkdown(note.content || '')}</div>
        ${clamp ? `<button class="wn-expand" type="button" data-act="expand" data-id="${note.id}">${state.expanded.has(note.id) ? '收起' : '展开全文'}</button>` : ''}
        <div class="wn-card-actions">
          ${note.type !== 'page' ? `<button type="button" data-act="locate" data-id="${note.id}">定位原文</button>` : ''}
          <button type="button" data-act="edit" data-id="${note.id}">编辑</button>
          <button type="button" data-act="master" data-id="${note.id}">${note.mastered ? '取消掌握' : '标记掌握'}</button>
          <button type="button" data-act="del" data-id="${note.id}">删除</button>
        </div>
      </article>
    `)
  })
  els.list.innerHTML = parts.join('')
}

function renderReview() {
  const pool = state.notes.filter((note) => state.tagFilter === 'all' || note.tag === state.tagFilter)
  if (!pool.length) {
    els.review.innerHTML = `<div class="wn-empty"><strong>没有可复习的笔记</strong><p>先记几条笔记，或把标签筛选切回「全部标签」。</p></div>`
    return
  }
  if (state.review.index >= pool.length) state.review.index = 0
  const note = pool[state.review.index]
  els.review.innerHTML = `
    <div class="wn-review-top">
      <span>第 ${state.review.index + 1} / ${pool.length} 条</span>
      <span class="wn-tag-label wn-tag-label-${note.tag}">${tagLabel(note.tag)}</span>
    </div>
    <div class="wn-review-progress"><i style="width:${((state.review.index + 1) / pool.length) * 100}%"></i></div>
    <div class="wn-review-card">
      <div class="wn-review-meta">${escapeText(note.docTitle || docTitle(note.doc))}${note.section ? ` · ${escapeText(note.section)}` : ''}</div>
      <div class="wn-review-ref">${referenceHtml(note)}</div>
      <div class="wn-review-content" ${state.review.revealed ? '' : 'hidden'}>${renderMarkdown(note.content || '')}</div>
      <button class="wn-primary wn-reveal" type="button" ${state.review.revealed ? 'hidden' : ''}>先回想一下，再显示笔记</button>
    </div>
    <div class="wn-review-actions">
      <button class="wn-ghost" type="button" data-review="prev">上一条</button>
      <button class="wn-ghost" type="button" data-review="random">随机</button>
      <button class="wn-primary" type="button" data-review="next">下一条</button>
    </div>
    <button class="wn-ghost wn-master-btn" type="button" data-review="master">${note.mastered ? '✓ 已掌握（点击取消）' : '标记为已掌握'}</button>
  `
}

/* ---------- 事件 ---------- */

function bindEvents() {
  els.fab.addEventListener('click', () => els.drawer.classList.toggle('is-open'))
  els.close.addEventListener('click', () => els.drawer.classList.remove('is-open'))

  els.tabs.addEventListener('click', (event) => {
    const button = event.target.closest('button')
    if (!button) return
    state.view = button.dataset.view
    if (button.dataset.filter) state.filter = button.dataset.filter
    if (state.view === 'review') { state.review.index = 0; state.review.revealed = false }
    renderView()
  })

  els.search.addEventListener('input', () => { state.query = els.search.value; renderList() })
  els.sort.addEventListener('click', () => {
    state.sort = state.sort === 'newest' ? 'oldest' : 'newest'
    els.sort.textContent = state.sort === 'newest' ? '最新' : '最早'
    renderList()
  })
  els.filters.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-tag]')
    if (!button) return
    state.tagFilter = button.dataset.tag
    els.filters.querySelectorAll('button').forEach((item) =>
      item.classList.toggle('is-active', item === button))
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
  els.exportMd.addEventListener('click', exportMarkdown)

  els.selbar.addEventListener('mousedown', (event) => event.preventDefault())
  els.selbar.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-quick]')
    if (!button) return
    const pending = state.pendingSelection
    hideSelectionBar()
    if (!pending) return
    const tag = button.dataset.quick
    if (tag === 'compose') {
      openEditor({ type: 'selection', anchor: pending.anchor, quote: pending.quote })
    } else {
      createQuickNote(tag, pending)
    }
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
      type: 'element', anchor,
      quote: (element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200),
      section: nearestHeading(element)
    })
  })

  els.tagPicker.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-tag]')
    if (!button) return
    setEditorTag(button.dataset.tag)
  })
  els.insertQuote.addEventListener('click', () => {
    const quote = state.editor && state.editor.quote
    if (!quote) return
    const text = `> ${quote.slice(0, 300).replace(/\n/g, ' ')}\n\n`
    els.textarea.setRangeText(text, els.textarea.selectionStart, els.textarea.selectionEnd, 'end')
    els.textarea.focus()
    els.textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
  els.toolbar.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]')
    if (!button) return
    if (state.mode === 'preview') switchMode('edit')
    applyToolbar(els.textarea, TOOLBAR.find((item) => item.id === button.dataset.action))
  })
  els.textarea.addEventListener('input', () => { updatePreview(); scheduleDraft() })
  els.mode.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-mode]')
    if (button) switchMode(button.dataset.mode)
  })
  els.save.addEventListener('click', saveEditor)
  els.cancel.addEventListener('click', closeEditor)
  els.modalClose.addEventListener('click', closeEditor)
  els.delete.addEventListener('click', deleteFromEditor)
  els.restore.addEventListener('click', restoreDraft)
  els.modal.addEventListener('mousedown', (event) => {
    if (event.target === els.modal) closeEditor()
  })

  els.list.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-act]')
    if (!button) return
    const note = state.notes.find((item) => item.id === button.dataset.id)
    if (!note) return
    const action = button.dataset.act
    if (action === 'expand') {
      if (state.expanded.has(note.id)) state.expanded.delete(note.id)
      else state.expanded.add(note.id)
      renderList()
    } else if (action === 'locate') {
      if (note.doc !== state.currentDoc) { toast('这条笔记在其它文档', 'info'); return }
      if (!anchors.focusNote(note)) toast('原文已变化，暂时无法定位', 'warn')
    } else if (action === 'edit') {
      openEditor({ note })
    } else if (action === 'master') {
      note.mastered = !note.mastered
      note.updatedAt = new Date().toISOString()
      afterChange(note.mastered ? '已标记为掌握' : '已取消掌握')
    } else if (action === 'del') {
      if (!window.confirm('确定删除这条笔记？')) return
      state.notes = state.notes.filter((item) => item.id !== note.id)
      afterChange('已删除笔记')
    }
  })
  els.list.addEventListener('mouseover', (event) => {
    const card = event.target.closest('.wn-card[data-id]')
    if (!card) return
    window.clearTimeout(emphasizeTimer)
    const note = state.notes.find((item) => item.id === card.dataset.id)
    emphasizeTimer = window.setTimeout(() => anchors.emphasize(note), 160)
  })

  els.review.addEventListener('click', (event) => {
    const reveal = event.target.closest('.wn-reveal')
    if (reveal) { state.review.revealed = true; renderReview(); return }
    const button = event.target.closest('button[data-review]')
    if (!button) return
    const pool = state.notes.filter((note) => state.tagFilter === 'all' || note.tag === state.tagFilter)
    const action = button.dataset.review
    if (action === 'prev') state.review.index = (state.review.index - 1 + pool.length) % pool.length
    if (action === 'next') state.review.index = (state.review.index + 1) % pool.length
    if (action === 'random') state.review.index = Math.floor(Math.random() * pool.length)
    if (action === 'master') {
      const note = pool[state.review.index]
      if (note) {
        note.mastered = !note.mastered
        note.updatedAt = new Date().toISOString()
        saveLocal()
        scheduleSync()
        toast(note.mastered ? '已标记为掌握' : '已取消掌握', 'ok')
      }
    }
    state.review.revealed = false
    renderReview()
  })

  document.addEventListener('mouseup', onSelectionEnd)
  document.addEventListener('keyup', (event) => { if (event.key === 'Shift') onSelectionEnd() })
  document.addEventListener('mousedown', (event) => {
    if (!els.selbar.hidden && !els.selbar.contains(event.target)) hideSelectionBar()
  })
  document.addEventListener('mouseover', onElementHover)
  document.addEventListener('click', onContentClick)
  document.addEventListener('keydown', onKeyDown)
  window.addEventListener('scroll', () => { if (!els.elemBtn.hidden) els.elemBtn.hidden = true }, { passive: true })
}

function onKeyDown(event) {
  const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)
  if (event.key === 'Escape') {
    if (!els.modal.hidden) closeEditor()
    else els.drawer.classList.remove('is-open')
    return
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && !els.modal.hidden) {
    event.preventDefault(); saveEditor(); return
  }
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !els.modal.hidden) {
    event.preventDefault(); saveEditor(); return
  }
  if (inField || !els.modal.hidden) return
  if (event.key === '/' && els.drawer.classList.contains('is-open')) {
    event.preventDefault(); state.view = 'list'; renderView(); els.search.focus()
  } else if (event.key.toLowerCase() === 'n' && !event.ctrlKey && !event.metaKey) {
    event.preventDefault()
    els.drawer.classList.add('is-open')
    state.view = 'list'; renderView()
    openEditor({ type: 'page', anchor: null, quote: '' })
  }
}

function onContentClick(event) {
  const root = anchors.getRoot()
  if (!root || !root.contains(event.target) || els.root.contains(event.target)) return
  if (event.target.closest('a, button, input, textarea')) return
  const selection = window.getSelection()
  if (selection && !selection.isCollapsed) return
  const note = anchors.findNoteAtPoint(event.clientX, event.clientY, state.notes, state.currentDoc)
  if (!note) return
  event.preventDefault()
  els.drawer.classList.add('is-open')
  state.view = 'list'
  state.filter = 'doc'
  state.query = ''
  els.search.value = ''
  state.tagFilter = 'all'
  els.filters.querySelectorAll('button').forEach((item) =>
    item.classList.toggle('is-active', item.dataset.tag === 'all'))
  renderView()
  const card = els.list.querySelector(`.wn-card[data-id="${note.id}"]`)
  if (card) {
    card.scrollIntoView({ behavior: 'smooth', block: 'center' })
    card.classList.add('wn-flash')
    window.setTimeout(() => card.classList.remove('wn-flash'), 2000)
  }
}

function onSelectionEnd() {
  window.setTimeout(() => {
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) { hideSelectionBar(); return }
    const range = selection.getRangeAt(0)
    const root = anchors.getRoot()
    if (!root || !root.contains(range.commonAncestorContainer)) { hideSelectionBar(); return }
    const quote = range.toString().replace(/\s+/g, ' ').trim()
    if (quote.length < 2) { hideSelectionBar(); return }
    const anchor = anchors.serializeSelection(range)
    if (!anchor) { hideSelectionBar(); return }
    state.pendingSelection = { anchor, quote, section: nearestHeading() }
    const rect = range.getBoundingClientRect()
    els.selbar.hidden = false
    const width = 330
    const left = Math.max(12, Math.min(window.innerWidth - width - 12, rect.left + rect.width / 2 - width / 2))
    els.selbar.style.left = `${left}px`
    els.selbar.style.top = `${Math.max(12, rect.top - 48)}px`
  }, 10)
}
function hideSelectionBar() { if (els.selbar) els.selbar.hidden = true }

function onElementHover(event) {
  const root = anchors.getRoot()
  if (!root || els.root.contains(event.target)) return
  const element = event.target.closest && event.target.closest(anchors.ELEMENT_TAGS.join(','))
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

/* ---------- 编辑与草稿 ---------- */

function setEditorTag(tag) {
  state.editorTag = tag
  els.tagPicker.querySelectorAll('button').forEach((button) =>
    button.classList.toggle('is-active', button.dataset.tag === tag))
}

function createQuickNote(tag, pending) {
  const quote = pending.quote.slice(0, 160)
  const content = `> ${quote}\n\n${TEMPLATES[tag] || ''}`.trim()
  const now = new Date().toISOString()
  state.notes.unshift(normalizeNote({
    id: uid(), doc: state.currentDoc, docTitle: docTitle(state.currentDoc),
    section: pending.section || nearestHeading(), type: 'selection',
    anchor: pending.anchor, quote: pending.quote, content, tag,
    createdAt: now, updatedAt: now
  }))
  afterChange(`已标记为「${tagLabel(tag)}」，可在笔记里补充内容`)
}

function openEditor(options) {
  const note = options.note
  state.editor = {
    id: note ? note.id : null,
    type: note ? note.type : options.type,
    anchor: note ? note.anchor : options.anchor,
    quote: note ? note.quote : options.quote,
    doc: note ? note.doc : state.currentDoc,
    section: note ? note.section : (options.section || nearestHeading()),
    createdAt: note ? note.createdAt : new Date().toISOString()
  }
  els.modalTitle.textContent = note ? '编辑笔记' : '新建笔记'
  els.modalSub.textContent = `${docTitle(state.editor.doc)}${state.editor.section ? ` · ${state.editor.section}` : ''}`
  els.textarea.value = note ? note.content || '' : (TEMPLATES.plain || '')
  els.delete.hidden = !note
  setEditorTag(note ? note.tag : 'plain')
  if (state.editor.quote) {
    els.quote.hidden = false
    els.quoteText.textContent = state.editor.type === 'selection'
      ? `“${state.editor.quote.slice(0, 180)}”`
      : anchors.elementLabel(state.editor.anchor)
  } else els.quote.hidden = true
  checkDraft(note)
  switchMode(window.innerWidth > 900 ? 'split' : 'edit')
  els.modal.hidden = false
  document.body.classList.add('wn-no-scroll')
  window.setTimeout(() => els.textarea.focus(), 30)
}

function switchMode(mode) {
  state.mode = mode
  els.mode.querySelectorAll('button').forEach((button) =>
    button.classList.toggle('is-active', button.dataset.mode === mode))
  els.textarea.hidden = mode === 'preview'
  els.preview.hidden = mode === 'edit'
  els.editorWrap.classList.toggle('is-split', mode === 'split')
  els.toolbar.style.opacity = mode === 'preview' ? '0.45' : '1'
  els.toolbar.style.pointerEvents = mode === 'preview' ? 'none' : 'auto'
  updatePreview()
}
function updatePreview() {
  if (els.preview) els.preview.innerHTML = renderMarkdown(els.textarea.value)
  if (els.count) els.count.textContent = `${els.textarea.value.length} 字`
}

function scheduleDraft() {
  window.clearTimeout(draftTimer)
  draftTimer = window.setTimeout(() => {
    if (!state.editor || !els.textarea.value.trim()) return
    try {
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify({
        content: els.textarea.value, tag: state.editorTag,
        quote: state.editor.quote, doc: state.editor.doc, ts: Date.now()
      }))
    } catch { /* ignore */ }
  }, 400)
}
function checkDraft(note) {
  let draft = null
  try { draft = JSON.parse(sessionStorage.getItem(DRAFT_KEY) || 'null') } catch { /* ignore */ }
  state.draftAvailable = !!(draft && draft.content && draft.content !== (note && note.content))
  els.restore.hidden = !state.draftAvailable
  els.restore.dataset.draft = state.draftAvailable ? draft.content : ''
}
function restoreDraft() {
  const content = els.restore.dataset.draft
  if (!content) return
  els.textarea.value = content
  els.textarea.dispatchEvent(new Event('input', { bubbles: true }))
  els.restore.hidden = true
  toast('已恢复上次未保存的内容', 'ok')
}
function clearDraft() { try { sessionStorage.removeItem(DRAFT_KEY) } catch { /* ignore */ } }

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
  const record = normalizeNote({
    id: editor.id || uid(), doc: editor.doc, docTitle: docTitle(editor.doc),
    section: editor.section, type: editor.type, anchor: editor.anchor,
    quote: editor.quote || '', content, tag: state.editorTag,
    mastered: existing ? existing.mastered : false,
    createdAt: editor.createdAt, updatedAt: now
  })
  if (existing) Object.assign(existing, record)
  else state.notes.unshift(record)
  clearDraft()
  closeEditor()
  afterChange(existing ? '笔记已更新' : '笔记已保存')
}
function deleteFromEditor() {
  const editor = state.editor
  if (!editor || !editor.id) return
  if (!window.confirm('确定删除这条笔记？')) return
  state.notes = state.notes.filter((note) => note.id !== editor.id)
  clearDraft()
  closeEditor()
  afterChange('已删除笔记')
}

/* ---------- 同步与导出 ---------- */

function afterChange(message) {
  saveLocal()
  state.dirty = true
  refresh()
  toast(message, 'ok')
  scheduleSync()
}
function scheduleSync() {
  window.clearTimeout(syncTimer)
  if (!state.token || !state.user) { setStatus('local', '仅本机保存'); return }
  setStatus('dirty', '有改动待同步')
  syncTimer = window.setTimeout(() => pushAll(), 1800)
}
async function pushAll() {
  if (!state.token || !state.user || state.syncing) return
  state.syncing = true
  setStatus('syncing', '正在同步…')
  try {
    const data = { version: 1, owner: state.user.login, updatedAt: new Date().toISOString(), notes: state.notes }
    if (!state.gistId) {
      state.gistId = await gh.createGist(state.token, data)
      gh.setGistId(state.user.login, state.gistId)
    } else await gh.updateGist(state.token, state.gistId, data)
    state.dirty = false
    setStatus('synced', `已同步 · ${state.user.login}`)
  } catch (error) {
    if (error.status === 404) {
      state.gistId = ''
      gh.setGistId(state.user.login, '')
      setStatus('error', 'Gist 不存在，下次同步将重建')
    } else setStatus('error', error.message)
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
    if (remote.notFound) { state.gistId = ''; gh.setGistId(user.login, '') }
    state.notes = gh.mergeData(
      { owner: user.login, notes: [...state.notes, ...localDraft] },
      remote.data || { owner: user.login, notes: [] }
    ).notes.map(normalizeNote)
    saveLocal()
    if (localDraft.length) { try { localStorage.removeItem(LOCAL_KEY) } catch { /* ignore */ } }
    if (els.avatar) {
      els.avatar.hidden = false
      els.avatar.innerHTML = user.avatar ? `<img src="${escapeText(user.avatar)}" alt="">` : ''
    }
    if (els.logout) els.logout.hidden = false
    els.tokenBox.hidden = true
    els.tokenInput.value = ''
    refresh()
    await pushAll()
  } catch (error) {
    if (error.status === 401 || error.status === 403) gh.clearToken()
    state.token = ''
    state.user = null
    state.gistId = ''
    saveLocal()
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
  els.tokenBox.hidden = true
  setStatus('local', '仅本机保存')
  refresh()
  toast('已退出，笔记仍保留在本浏览器', 'info')
}

function download(content, filename, type) {
  const blob = new Blob([content], { type })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
function exportNotes() {
  download(JSON.stringify({
    version: 1, owner: state.user ? state.user.login : 'local',
    exportedAt: new Date().toISOString(), notes: state.notes
  }, null, 2), 'whistle-study-notes.json', 'application/json')
}
function exportMarkdown() {
  const groups = new Map()
  state.notes.forEach((note) => {
    const key = note.docTitle || docTitle(note.doc)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(note)
  })
  const lines = ['# Whistle 源码研读 · 学习笔记', '',
    `> 导出时间：${timeText(new Date().toISOString())}　共 ${state.notes.length} 条`, '']
  groups.forEach((notes, title) => {
    lines.push(`## ${title}`, '')
    notes.forEach((note) => {
      lines.push(`### [${tagLabel(note.tag)}] ${typeLabel(note.type)} · ${timeText(note.updatedAt)}`, '')
      if (note.section) lines.push(`章节：${note.section}`, '')
      if (note.quote) lines.push(`> ${note.quote.replace(/\n/g, ' ').slice(0, 400)}`, '')
      lines.push(note.content, '', '---', '')
    })
  })
  download(lines.join('\n'), 'whistle-study-notes.md', 'text/markdown;charset=utf-8')
  toast('已导出 Markdown', 'ok')
}
function restoreSession() {
  const token = gh.getToken()
  if (!token) { setStatus('local', '仅本机保存'); return }
  connectWithToken(token, { remember: false })
}

/* ---------- 生命周期 ---------- */

function watchPath() {
  if (anchors.docPath() !== state.currentDoc) onNotesRouteChange()
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
  state.expanded.clear()
  hideSelectionBar()
  refresh()
}
