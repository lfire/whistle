/**
 * 笔记应用：状态、界面、选区/要素/文档三种笔记、标签与复习、GitHub 账号同步。
 * 本地优先（离线可写），登录后与账号私有 Gist 合并同步。
 */
import * as gh from './github.js'
import * as anchors from './anchors.js'
import { renderMarkdown, TOOLBAR, applyToolbar } from './markdown.js'

const LOCAL_KEY = 'wn:notes:local'
const DRAFT_KEY = 'wn:draft'
const USER_CACHE_KEY = 'wn:user'
const MAX_IMAGE_CHARS = 1200000 // 图片 base64 总量上限，避免 Gist 过大
const IMAGE_RE = /wn-image:([\w-]+)/g
const SYNC_DEBOUNCE = 4000         // 连续改动合并成一次请求
const MIN_SYNC_INTERVAL = 30000    // 两次成功同步之间的最小间隔
const DEFAULT_COOLDOWN = 15 * 60 * 1000 // 拿不到重置时间时的兜底冷却

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
  notes: [], images: {}, currentDoc: '/',
  filter: 'doc', view: 'list',
  status: 'local', statusText: '仅本机保存',
  dirty: false, syncing: false,
  cooldownUntil: 0, lastSyncAt: 0, rateLimit: null,
  query: '', tagFilter: 'all', sort: 'newest',
  editor: null, mode: 'edit', editorTag: 'plain',
  pendingSelection: null, activeElement: null,
  expanded: new Set(),
  review: { index: 0, revealed: false, masteredOnly: false },
  draftAvailable: false
}

let els = {}
let syncTimer = null
let cooldownTimer = null
let hideElemTimer = null
let draftTimer = null
let emphasizeTimer = null

/* ---------- 基础工具 ---------- */

function notesKey() { return state.user ? `wn:notes:${state.user.login}` : LOCAL_KEY }
function imagesKey() { return state.user ? `wn:images:${state.user.login}` : 'wn:images:local' }

/** 只保存令牌指纹（不存明文）与账号信息，避免每次加载都请求 /user */
function tokenFingerprint(token) {
  return `${token.length}:${token.slice(0, 6)}:${token.slice(-4)}`
}
function readUserCache(token) {
  try {
    const cache = JSON.parse(localStorage.getItem(USER_CACHE_KEY) || 'null')
    return cache && cache.fingerprint === tokenFingerprint(token) ? cache.user : null
  } catch { return null }
}
function saveUserCache(token, user) {
  try {
    localStorage.setItem(USER_CACHE_KEY, JSON.stringify({ fingerprint: tokenFingerprint(token), user }))
  } catch { /* ignore */ }
}
function readImages(key) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch { return {} }
}
function saveImages() {
  try { localStorage.setItem(imagesKey(), JSON.stringify(state.images)) } catch {
    toast('图片占用超出浏览器本地存储，请删除部分图片', 'warn')
  }
}
function imagesSize() {
  return Object.values(state.images).reduce((total, value) => total + (value ? value.length : 0), 0)
}
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
          <h3>API 配额</h3>
          <p>GitHub 账号每小时有 REST API 调用上限。若提示「限额恢复中」，笔记仍可离线记录，到期后自动同步；也可查看配额或手动重试。</p>
          <div class="wn-quota"><span class="wn-quota-text">未检查</span></div>
          <div class="wn-export-row">
            <button class="wn-ghost wn-check-quota" type="button">检查配额</button>
            <button class="wn-ghost wn-retry-sync" type="button" hidden>立即重试同步</button>
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
    <input class="wn-file" type="file" accept="image/*" multiple hidden>
    <div class="wn-viewer" hidden><img alt="笔记图片"><button class="wn-viewer-close" type="button" title="关闭">×</button></div>
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
    quotaText: q('.wn-quota-text'), checkQuota: q('.wn-check-quota'),
    retrySync: q('.wn-retry-sync'),
    modal: q('.wn-modal'), modalTitle: q('.wn-modal-title'), modalSub: q('.wn-modal-sub'),
    tagPicker: q('.wn-tag-picker'), quote: q('.wn-quote'), quoteText: q('.wn-quote-text'),
    insertQuote: q('.wn-insert-quote'),
    toolbar: q('.wn-toolbar'), editorWrap: q('.wn-editor-wrap'),
    textarea: q('.wn-textarea'), preview: q('.wn-preview'),
    count: q('.wn-count'), restore: q('.wn-restore'),
    mode: q('.wn-mode'), save: q('.wn-save'), cancel: q('.wn-cancel'),
    delete: q('.wn-delete'), modalClose: q('.wn-modal-close'), toast: q('.wn-toast'),
    file: q('.wn-file'), viewer: q('.wn-viewer'), viewerImg: q('.wn-viewer img'),
    viewerClose: q('.wn-viewer-close')
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
  if (els.retrySync) els.retrySync.hidden = Date.now() >= state.cooldownUntil
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
  hydrateImages(els.list)
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
  hydrateImages(els.review)
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
  els.checkQuota.addEventListener('click', async () => {
    if (!state.token) { toast('请先连接 GitHub 账号', 'warn'); return }
    els.quotaText.textContent = '正在查询…'
    try {
      const quota = await gh.fetchRateLimit(state.token)
      if (!quota) { els.quotaText.textContent = '查询失败'; return }
      const reset = quota.resetAt
        ? new Date(quota.resetAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
        : ''
      els.quotaText.textContent = `剩余 ${quota.remaining} / ${quota.limit} 次${reset ? ` · ${reset} 重置` : ''}`
      if (quota.remaining === 0 && quota.resetAt) {
        state.cooldownUntil = quota.resetAt + 1000
        state.rateLimit = { remaining: 0, resetAt: quota.resetAt }
        scheduleCooldownCheck()
      }
      refreshStatus()
    } catch (error) {
      els.quotaText.textContent = error.message
    }
  })
  els.retrySync.addEventListener('click', () => {
    state.cooldownUntil = 0
    window.clearTimeout(cooldownTimer)
    pushAll(true)
  })

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
    const action = TOOLBAR.find((item) => item.id === button.dataset.action)
    if (!action) return
    if (action.custom) {
      if (action.id === 'image') els.file.click()
      else if (action.id === 'imageUrl') insertImageUrl()
      return
    }
    if (state.mode === 'preview') switchMode('edit')
    applyToolbar(els.textarea, action)
  })
  els.file.addEventListener('change', () => {
    handleImageFiles([...els.file.files])
    els.file.value = ''
  })
  els.textarea.addEventListener('paste', (event) => {
    const files = [...((event.clipboardData && event.clipboardData.files) || [])]
      .filter((file) => file.type.startsWith('image/'))
    if (files.length) { event.preventDefault(); handleImageFiles(files) }
  })
  // 只在弹层上绑定，避免 editorWrap 与 modal 冒泡导致一张图被处理两次
  els.modal.addEventListener('dragover', (event) => {
    if (event.dataTransfer && [...event.dataTransfer.types].includes('Files')) {
      event.preventDefault()
      els.editorWrap.classList.add('is-dragover')
    }
  })
  els.modal.addEventListener('dragleave', () => els.editorWrap.classList.remove('is-dragover'))
  els.modal.addEventListener('drop', (event) => {
    event.preventDefault()
    event.stopPropagation()
    els.editorWrap.classList.remove('is-dragover')
    const files = [...((event.dataTransfer && event.dataTransfer.files) || [])]
      .filter((file) => file.type.startsWith('image/'))
    if (files.length) handleImageFiles(files)
  })
  ;[els.list, els.review, els.preview].forEach((target) => {
    target.addEventListener('click', (event) => {
      const image = event.target.closest('img.wn-md-image')
      if (!image || !image.src) return
      els.viewerImg.src = image.src
      els.viewer.hidden = false
    })
  })
  els.viewerClose.addEventListener('click', () => { els.viewer.hidden = true })
  els.viewer.addEventListener('click', (event) => {
    if (event.target === els.viewer) els.viewer.hidden = true
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

/* ---------- 图片：压缩内嵌、随笔记同步、点击放大 ---------- */

function hydrateImages(container) {
  if (!container) return
  container.querySelectorAll('img[data-wn-image]').forEach((image) => {
    const id = image.dataset.wnImage
    const source = state.images[id]
    if (source) {
      image.src = source
      image.title = '点击放大查看'
      image.classList.remove('is-missing')
    } else {
      image.classList.add('is-missing')
      image.alt = '图片数据缺失'
      image.removeAttribute('src')
    }
  })
}

function imageUsageText() {
  const count = Object.keys(state.images).length
  return count ? ` · 图片 ${count} 张 / ${Math.round(imagesSize() / 1024)} KB` : ''
}

async function compressImage(file) {
  const original = await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(new Error('读取图片失败'))
    reader.readAsDataURL(file)
  })
  const image = await new Promise((resolve, reject) => {
    const element = new Image()
    element.onload = () => resolve(element)
    element.onerror = () => reject(new Error('图片格式无法识别'))
    element.src = original
  })
  const maxSide = 1280
  const scale = Math.min(1, maxSide / Math.max(image.width, image.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(image.width * scale))
  canvas.height = Math.max(1, Math.round(image.height * scale))
  const context = canvas.getContext('2d')
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.drawImage(image, 0, 0, canvas.width, canvas.height)
  let quality = 0.8
  let result = canvas.toDataURL('image/jpeg', quality)
  while (result.length > 320000 && quality > 0.4) {
    quality -= 0.12
    result = canvas.toDataURL('image/jpeg', quality)
  }
  return result
}

async function handleImageFiles(files) {
  if (!state.editor || els.modal.hidden) {
    openEditor({ type: 'page', anchor: null, quote: '' })
  }
  for (const file of files) {
    if (!file.type || !file.type.startsWith('image/')) continue
    if (imagesSize() >= MAX_IMAGE_CHARS) {
      toast('图片空间已满，请删除含图笔记或改用网络图', 'warn')
      break
    }
    toast('正在压缩图片…')
    let dataUrl
    try { dataUrl = await compressImage(file) } catch (error) {
      toast(error.message, 'error')
      continue
    }
    if (imagesSize() + dataUrl.length > MAX_IMAGE_CHARS) {
      toast('剩余空间不足，这张图片未插入', 'warn')
      continue
    }
    const id = `img_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
    state.images[id] = dataUrl
    saveImages()
    const alt = (file.name || '图片').replace(/\.[^.]+$/, '').slice(0, 40) || '图片'
    const markdown = `\n![${alt}](wn-image:${id})\n`
    els.textarea.setRangeText(markdown, els.textarea.selectionStart, els.textarea.selectionEnd, 'end')
    els.textarea.dispatchEvent(new Event('input', { bubbles: true }))
  }
  toast('图片已插入，保存笔记后同步到你的 Gist', 'ok')
}

function insertImageUrl() {
  const url = window.prompt('输入图片链接（https://…）：', 'https://')
  if (!url || !/^https?:\/\//i.test(url.trim())) return
  const markdown = `\n![图片](${url.trim()})\n`
  els.textarea.setRangeText(markdown, els.textarea.selectionStart, els.textarea.selectionEnd, 'end')
  els.textarea.dispatchEvent(new Event('input', { bubbles: true }))
  els.textarea.focus()
}

function cleanupImages() {
  const used = new Set()
  const collect = (text) => {
    const regex = /wn-image:([\w-]+)/g
    let match
    while ((match = regex.exec(text || ''))) used.add(match[1])
  }
  state.notes.forEach((note) => collect(note.content))
  if (state.editor && !els.modal.hidden) collect(els.textarea.value)
  let removed = 0
  Object.keys(state.images).forEach((id) => {
    if (!used.has(id)) { delete state.images[id]; removed += 1 }
  })
  if (removed) saveImages()
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
  if (els.preview) {
    els.preview.innerHTML = renderMarkdown(els.textarea.value)
    hydrateImages(els.preview)
  }
  if (els.count) els.count.textContent = `${els.textarea.value.length} 字${imageUsageText()}`
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
  cleanupImages() // 删除已不被任何笔记引用的图片，控制 Gist 体积
  saveLocal()
  saveImages()
  state.dirty = true
  refresh()
  toast(message, 'ok')
  scheduleSync()
}
function cooldownText() {
  const minutes = Math.max(1, Math.ceil((state.cooldownUntil - Date.now()) / 60000))
  return `API 限额恢复中 · 约 ${minutes} 分钟后自动重试（笔记保存在本机）`
}

function scheduleCooldownCheck() {
  window.clearTimeout(cooldownTimer)
  const delay = Math.max(2000, Math.min(state.cooldownUntil - Date.now() + 1000, 60 * 60 * 1000))
  cooldownTimer = window.setTimeout(() => {
    if (Date.now() >= state.cooldownUntil) {
      state.cooldownUntil = 0
      setStatus('dirty', '限额已恢复，正在同步…')
      pushAll()
    } else {
      setStatus('error', cooldownText())
      scheduleCooldownCheck()
    }
  }, delay)
}

/** 限流不清令牌、不重复轰炸，进入冷却并给出恢复时间；笔记继续本地可用 */
function handleSyncError(error) {
  if (error.isRateLimit) {
    const reset = error.rateLimit && error.rateLimit.resetAt
    state.cooldownUntil = reset && reset > Date.now()
      ? reset + 1000
      : Date.now() + DEFAULT_COOLDOWN
    state.rateLimit = error.rateLimit
    state.dirty = true
    window.clearTimeout(syncTimer)
    setStatus('error', cooldownText())
    scheduleCooldownCheck()
    toast(error.message, 'warn')
    refreshStatus()
    return
  }
  if (error.status === 401) {
    gh.clearToken()
    try { localStorage.removeItem(USER_CACHE_KEY) } catch { /* ignore */ }
    state.token = ''
    state.user = null
    state.gistId = ''
    saveLocal()
  }
  setStatus('error', error.message)
  toast(error.message, 'error')
  refreshStatus()
}

function scheduleSync() {
  window.clearTimeout(syncTimer)
  if (!state.token || !state.user) { setStatus('local', '仅本机保存'); return }
  if (Date.now() < state.cooldownUntil) { setStatus('error', cooldownText()); return }
  setStatus('dirty', '有改动待同步')
  syncTimer = window.setTimeout(() => pushAll(), SYNC_DEBOUNCE)
}

async function pushAll(force = false) {
  if (!state.token || !state.user || state.syncing) return
  if (!force && Date.now() < state.cooldownUntil) {
    setStatus('error', cooldownText())
    return
  }
  if (!force && state.lastSyncAt && Date.now() - state.lastSyncAt < MIN_SYNC_INTERVAL) {
    setStatus('dirty', '改动已暂存，稍后合并同步')
    window.clearTimeout(syncTimer)
    syncTimer = window.setTimeout(
      () => pushAll(),
      MIN_SYNC_INTERVAL - (Date.now() - state.lastSyncAt) + 500
    )
    return
  }
  state.syncing = true
  setStatus('syncing', '正在同步…')
  try {
    const data = {
      version: 1, owner: state.user.login,
      updatedAt: new Date().toISOString(),
      notes: state.notes, images: state.images
    }
    if (!state.gistId) {
      state.gistId = await gh.createGist(state.token, data)
      gh.setGistId(state.user.login, state.gistId)
    } else await gh.updateGist(state.token, state.gistId, data)
    state.dirty = false
    state.lastSyncAt = Date.now()
    state.cooldownUntil = 0
    window.clearTimeout(cooldownTimer)
    setStatus('synced', `已同步 · ${state.user.login}`)
  } catch (error) {
    if (error.status === 404) {
      state.gistId = ''
      gh.setGistId(state.user.login, '')
      setStatus('error', 'Gist 不存在，下次同步将重建')
      toast(error.message, 'error')
    } else {
      handleSyncError(error)
    }
  } finally {
    state.syncing = false
    refreshStatus()
  }
}
async function connectWithToken(token, { remember = true, auto = false } = {}) {
  if (!token) { toast('请先填写 GitHub Token', 'warn'); return }
  // 冷却期内完全不发网络请求，直接用缓存身份进入离线可用状态
  if (auto && Date.now() < state.cooldownUntil) {
    const cached = readUserCache(token)
    state.token = token
    state.user = cached || { login: '', name: 'GitHub 账号', avatar: '' }
    state.gistId = state.user.login ? gh.getGistId(state.user.login) : ''
    state.notes = readNotes(state.user.login ? `wn:notes:${state.user.login}` : LOCAL_KEY)
    state.images = readImages(state.user.login ? `wn:images:${state.user.login}` : 'wn:images:local')
    setStatus('error', cooldownText())
    refresh()
    return
  }
  setStatus('syncing', auto ? '正在连接 GitHub…' : '正在校验令牌…')
  try {
    // 同一令牌复用账号信息，省掉每次加载的 /user 请求
    const cached = readUserCache(token)
    const user = cached || await gh.fetchUser(token)
    if (!cached) saveUserCache(token, user)
    const localDraft = readNotes(LOCAL_KEY)
    state.token = token
    state.user = user
    if (remember) gh.setToken(token)
    state.gistId = gh.getGistId(user.login)
    state.notes = readNotes(notesKey())
    state.images = {
      ...readImages('wn:images:local'),
      ...readImages(imagesKey())
    }
    const remote = await gh.loadGist(token, state.gistId)
    if (remote.notFound) { state.gistId = ''; gh.setGistId(user.login, '') }
    const merged = gh.mergeData(
      { owner: user.login, notes: [...state.notes, ...localDraft], images: state.images },
      remote.data || { owner: user.login, notes: [], images: {} }
    )
    state.notes = merged.notes.map(normalizeNote)
    state.images = merged.images || {}
    saveLocal()
    saveImages()
    if (localDraft.length) { try { localStorage.removeItem(LOCAL_KEY) } catch { /* ignore */ } }
    if (els.avatar) {
      els.avatar.hidden = false
      els.avatar.innerHTML = user.avatar ? `<img src="${escapeText(user.avatar)}" alt="">` : ''
    }
    if (els.logout) els.logout.hidden = false
    els.tokenBox.hidden = true
    els.tokenInput.value = ''
    refresh()
    // 自动恢复只读取；主动登录或确实有改动时才写回，避免每次刷新都 PATCH
    const needPush = !state.gistId || state.dirty || !auto || localDraft.length || remote.notFound
    if (needPush) await pushAll()
    else setStatus('synced', `已同步 · ${user.login}`)
  } catch (error) {
    handleSyncError(error)
    refresh()
  }
}
function signIn(token) { return connectWithToken(token) }
function signOut() {
  gh.clearToken()
  try { localStorage.removeItem(USER_CACHE_KEY) } catch { /* ignore */ }
  state.cooldownUntil = 0
  window.clearTimeout(cooldownTimer)
  window.clearTimeout(syncTimer)
  state.token = ''
  state.user = null
  state.gistId = ''
  state.notes = readNotes(LOCAL_KEY)
  state.images = readImages('wn:images:local')
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
    exportedAt: new Date().toISOString(), notes: state.notes, images: state.images
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
      // 导出的 Markdown 自包含图片：把占位换成 data URL
      lines.push((note.content || '').replace(/wn-image:([\w-]+)/g, (_, id) =>
        state.images[id] || `（图片 ${id} 数据缺失）`), '', '---', '')
    })
  })
  download(lines.join('\n'), 'whistle-study-notes.md', 'text/markdown;charset=utf-8')
  toast('已导出 Markdown', 'ok')
}
function restoreSession() {
  const token = gh.getToken()
  if (!token) { setStatus('local', '仅本机保存'); return }
  connectWithToken(token, { remember: false, auto: true })
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
  state.images = readImages('wn:images:local')
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
