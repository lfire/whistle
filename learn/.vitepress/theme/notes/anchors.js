/**
 * 笔记锚定：选区按「字符偏移 + 引用文本 + 前后文指纹」还原，
 * 元素按「标签 + 同类序号 + 文本指纹」还原；刷新与 SPA 路由切换后都可重建。
 */

const BASE = '/whistle/'
const ACTIVE_NAME = 'wn-note-active'
export const TAG_HIGHLIGHTS = {
  plain: 'wn-hl-plain',
  focus: 'wn-hl-focus',
  question: 'wn-hl-question',
  todo: 'wn-hl-todo',
  insight: 'wn-hl-insight'
}
export const ELEMENT_TAGS = ['H2', 'H3', 'H4', 'P', 'LI', 'PRE', 'TABLE', 'BLOCKQUOTE']

export function getRoot() {
  return document.querySelector('.vp-doc') || document.querySelector('main')
}

export function docPath() {
  let path = window.location.pathname || '/'
  if (path.startsWith(BASE)) path = '/' + path.slice(BASE.length)
  path = path.replace(/\.html$/, '').replace(/\/+$/, '')
  return path || '/'
}

function isIgnored(node) {
  const parent = node.parentElement
  if (!parent) return true
  if (/^(SCRIPT|STYLE|TEXTAREA|INPUT|BUTTON)$/.test(parent.tagName)) return true
  if (parent.closest('.wn-ignore')) return true
  return false
}

function textNodes(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT
      return isIgnored(node) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
    }
  })
  const result = []
  let node
  while ((node = walker.nextNode())) result.push(node)
  return result
}

function fullText(root) {
  return textNodes(root).map((node) => node.nodeValue).join('')
}

function offsetOf(root, node, offset) {
  let total = 0
  for (const item of textNodes(root)) {
    if (item === node) return total + offset
    total += item.nodeValue.length
  }
  return -1
}

function pointAt(root, position) {
  let total = 0
  const nodes = textNodes(root)
  for (const node of nodes) {
    const length = node.nodeValue.length
    if (position <= total + length) {
      return { node, offset: Math.max(0, Math.min(length, position - total)) }
    }
    total += length
  }
  const last = nodes[nodes.length - 1]
  return last ? { node: last, offset: last.nodeValue.length } : null
}

function hashText(value) {
  let hash = 5381
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(i)) >>> 0
  }
  return hash.toString(36)
}

function firstText(node) {
  if (!node) return null
  if (node.nodeType === Node.TEXT_NODE) return node
  if (node.nodeType !== Node.ELEMENT_NODE) return null
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
  return walker.nextNode()
}

function lastText(node) {
  if (!node) return null
  if (node.nodeType === Node.TEXT_NODE) return node
  if (node.nodeType !== Node.ELEMENT_NODE) return null
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
  let last = null
  let current
  while ((current = walker.nextNode())) last = current
  return last
}

/** 浏览器可能把选区端点给成元素节点（整段/整块选中），统一映射成文本节点 */
function normalizeBoundary(node, offset, isStart) {
  if (!node) return null
  if (node.nodeType === Node.TEXT_NODE) return { node, offset }
  if (node.nodeType !== Node.ELEMENT_NODE) return null
  const children = [...node.childNodes]
  if (isStart) {
    for (let i = Math.max(0, offset); i < children.length; i += 1) {
      const text = firstText(children[i])
      if (text) return { node: text, offset: 0 }
    }
    const text = lastText(node)
    return text ? { node: text, offset: text.nodeValue.length } : null
  }
  for (let i = Math.min(offset, children.length) - 1; i >= 0; i -= 1) {
    const text = lastText(children[i])
    if (text) return { node: text, offset: text.nodeValue.length }
  }
  const text = firstText(node)
  return text ? { node: text, offset: 0 } : null
}

/** 把当前选区序列化成可持久化的锚点 */
export function serializeSelection(range) {
  const root = getRoot()
  if (!root || !range || range.collapsed) return null
  const quote = range.toString().replace(/\s+/g, ' ').trim()
  if (!quote) return null
  const startPoint = normalizeBoundary(range.startContainer, range.startOffset, true)
  const endPoint = normalizeBoundary(range.endContainer, range.endOffset, false)
  if (!startPoint || !endPoint) return null
  const start = offsetOf(root, startPoint.node, startPoint.offset)
  const end = offsetOf(root, endPoint.node, endPoint.offset)
  if (start < 0 || end < 0 || end <= start) return null
  const text = fullText(root)
  return {
    start,
    end,
    quote: quote.slice(0, 500),
    prefix: text.slice(Math.max(0, start - 24), start),
    suffix: text.slice(end, end + 24)
  }
}

/** 还原选区；文档改动后按引用文本 + 前后文重新定位 */
export function restoreRange(anchor) {
  const root = getRoot()
  if (!root || !anchor) return null
  const text = fullText(root)
  let start = anchor.start
  let end = anchor.end

  const matchesQuote = text.slice(start, end).replace(/\s+/g, ' ').trim() === anchor.quote
  if (!matchesQuote) {
    const quote = anchor.quote
    let found = -1
    let from = 0
    let best = Infinity
    while ((from = text.indexOf(quote, from)) !== -1) {
      const distance = Math.abs(from - anchor.start)
      if (distance < best) { best = distance; found = from }
      from += 1
    }
    if (found === -1 && anchor.prefix) {
      const near = text.indexOf(anchor.prefix)
      if (near !== -1) found = text.indexOf(quote, near)
    }
    if (found === -1) return null
    start = found
    end = found + quote.length
  }

  const a = pointAt(root, start)
  const b = pointAt(root, end)
  if (!a || !b) return null
  try {
    const range = document.createRange()
    range.setStart(a.node, a.offset)
    range.setEnd(b.node, b.offset)
    return range
  } catch {
    return null
  }
}

/** 可标注元素的稳定锚点 */
export function serializeElement(element) {
  const root = getRoot()
  if (!root || !element) return null
  const tag = element.tagName
  const list = [...root.querySelectorAll(tag)]
  const index = list.indexOf(element)
  if (index < 0) return null
  const text = (element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120)
  return { tag, index, text, hash: hashText(text) }
}

export function restoreElement(anchor) {
  const root = getRoot()
  if (!root || !anchor || !anchor.tag) return null
  const list = [...root.querySelectorAll(anchor.tag)]
  const exact = list[anchor.index]
  if (exact && hashText((exact.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120)) === anchor.hash) {
    return exact
  }
  const key = (anchor.text || '').slice(0, 30)
  if (!key) return null
  return list.find((element) =>
    (element.textContent || '').replace(/\s+/g, ' ').trim().startsWith(key)
  ) || null
}

export function elementLabel(anchor) {
  if (!anchor) return ''
  const names = {
    H2: '二级标题', H3: '三级标题', H4: '四级标题', P: '段落',
    LI: '列表项', PRE: '代码块', TABLE: '表格', BLOCKQUOTE: '引用块'
  }
  const text = (anchor.text || '').slice(0, 46)
  return `${names[anchor.tag] || anchor.tag} · ${text}${(anchor.text || '').length > 46 ? '…' : ''}`
}

function setHighlight(name, ranges) {
  if (!ranges.length) return
  if (typeof CSS === 'undefined' || !CSS.highlights || typeof Highlight === 'undefined') {
    ranges.forEach((range) => {
      const element = range.startContainer.parentElement
      if (element) element.classList.add('wn-anchored')
    })
    return
  }
  try { CSS.highlights.set(name, new Highlight(...ranges)) } catch { /* ignore */ }
}

export function clearHighlights() {
  try {
    if (typeof CSS !== 'undefined' && CSS.highlights) {
      Object.values(TAG_HIGHLIGHTS).forEach((name) => CSS.highlights.delete(name))
      CSS.highlights.delete(ACTIVE_NAME)
    }
  } catch { /* ignore */ }
  document.querySelectorAll('.wn-anchored').forEach((el) => el.classList.remove('wn-anchored'))
}

/** 应用当前文档所有笔记的高亮；选区按标签分色，要素加左侧标记 */
export function applyHighlights(notes, doc) {
  clearHighlights()
  const groups = {}
  notes.forEach((note) => {
    if (note.doc !== doc) return
    if (note.type === 'selection') {
      const range = restoreRange(note.anchor)
      if (!range) return
      const name = TAG_HIGHLIGHTS[note.tag] || TAG_HIGHLIGHTS.plain
      if (!groups[name]) groups[name] = []
      groups[name].push(range)
    } else if (note.type === 'element') {
      const element = restoreElement(note.anchor)
      if (element) {
        element.classList.add('wn-anchored')
        element.dataset.wnTag = note.tag || 'plain'
      }
    }
  })
  Object.entries(groups).forEach(([name, ranges]) => setHighlight(name, ranges.filter(Boolean)))
}

/** 当前文档所有可命中的选区范围，供点击高亮定位笔记 */
export function rangesForDoc(notes, doc) {
  return notes
    .filter((note) => note.doc === doc && note.type === 'selection')
    .map((note) => ({ note, range: restoreRange(note.anchor) }))
    .filter((item) => item.range)
}

/** 点击正文时判断是否落在某条选区笔记的高亮里 */
export function findNoteAtPoint(x, y, notes, doc) {
  let node = null
  let offset = 0
  if (document.caretRangeFromPoint) {
    const range = document.caretRangeFromPoint(x, y)
    if (range) { node = range.startContainer; offset = range.startOffset }
  } else if (document.caretPositionFromPoint) {
    const position = document.caretPositionFromPoint(x, y)
    if (position) { node = position.offsetNode; offset = position.offset }
  }
  if (!node) return null
  for (const item of rangesForDoc(notes, doc)) {
    try { if (item.range.isPointInRange(node, offset)) return item.note } catch { /* ignore */ }
  }
  return null
}

/**  hover 笔记卡片时临时强调对应原文 */
export function emphasize(note) {
  if (!note || note.type !== 'selection') return
  const range = restoreRange(note.anchor)
  if (!range) return
  setHighlight(ACTIVE_NAME, [range])
  window.setTimeout(() => {
    try { CSS.highlights && CSS.highlights.delete(ACTIVE_NAME) } catch { /* ignore */ }
  }, 1800)
}

/** 点击笔记时滚动定位并临时强调 */
export function focusNote(note) {
  if (!note) return
  if (note.type === 'selection') {
    const range = restoreRange(note.anchor)
    if (!range) return false
    const rect = range.getBoundingClientRect()
    window.scrollTo({ top: window.scrollY + rect.top - 120, behavior: 'smooth' })
    setHighlight(ACTIVE_NAME, [range])
    window.setTimeout(() => {
      try { CSS.highlights && CSS.highlights.delete(ACTIVE_NAME) } catch { /* ignore */ }
    }, 2600)
    return true
  }
  if (note.type === 'element') {
    const element = restoreElement(note.anchor)
    if (!element) return false
    element.scrollIntoView({ behavior: 'smooth', block: 'center' })
    element.classList.add('wn-flash')
    window.setTimeout(() => element.classList.remove('wn-flash'), 2600)
    return true
  }
  return false
}
