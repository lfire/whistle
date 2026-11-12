/**
 * 页面交互增强：表格与代码块
 * ------------------------------------------------------------
 * 参考 go 教程站的实现，按本站类名（wl-*）与品牌色适配。
 *  - 表格：短列不换行、宽表包横向滚动容器、按列理想宽度算 min-width、
 *    可滚动时固定首列、右侧渐隐与滚动提示。
 *  - 代码块：语言标签 + 复制 + 整体折叠，长代码按结构行内折叠。
 * 所有增强都不改动源码文本，复制仍拿到完整代码。
 */

const BRACE_LANGS = new Set([
  'go', 'golang', 'proto', 'protobuf', 'json', 'js', 'javascript', 'ts',
  'typescript', 'jsx', 'tsx', 'rust', 'c', 'cpp', 'java', 'css', 'scss',
])
const INDENT_LANGS = new Set(['yaml', 'yml', 'py', 'python'])

interface FoldRange { start: number; end: number; count: number }

const COPY_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="5.5" y="5.5" width="8.5" height="8.5" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M10.5 3.5H3.6A1.6 1.6 0 0 0 2 5.1v6.6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>'
const CHECK_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3 8.5l3.2 3.2L13 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
const FOLD_ICON = '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M3.5 10 8 5.8 12.5 10" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>'
const UNFOLD_ICON = '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M3.5 6 8 10.2 12.5 6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>'

/** shiki 把每行包在 .line 里，直接取 textContent 会丢掉换行符 */
function sourceOf(code: HTMLElement): string {
  const lines = code.querySelectorAll<HTMLElement>('.line')
  const text = lines.length
    ? Array.from(lines).map((line) => line.textContent || '').join('\n')
    : code.textContent || ''
  return text.replace(/\u200b/g, '').trim()
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch { /* 走降级路径 */ }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    area.remove()
    return ok
  } catch { return false }
}

/** 去掉字符串与注释里的括号，避免把字符串内容算进层级 */
function stripCodeNoise(line: string): string {
  return line
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, '``')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/\/\*.*?\*\//g, '')
    .replace(/\/\/.*$/, '')
}

function braceRanges(texts: string[]): FoldRange[] {
  const stack: { ch: string; line: number }[] = []
  const ranges: FoldRange[] = []
  const pairs: Record<string, string> = { '}': '{', ')': '(', ']': '[' }
  texts.forEach((raw, i) => {
    for (const ch of stripCodeNoise(raw)) {
      if (ch === '{' || ch === '(' || ch === '[') {
        stack.push({ ch, line: i })
      } else if (ch === '}' || ch === ')' || ch === ']') {
        const top = stack[stack.length - 1]
        if (top && top.ch === pairs[ch]) {
          stack.pop()
          if (i - top.line >= 3) ranges.push({ start: top.line, end: i, count: i - top.line - 1 })
        }
      }
    }
  })
  const byStart = new Map<number, FoldRange>()
  for (const range of ranges) {
    const prev = byStart.get(range.start)
    if (!prev || range.end > prev.end) byStart.set(range.start, range)
  }
  return [...byStart.values()].sort((a, b) => a.start - b.start)
}

function indentRanges(texts: string[]): FoldRange[] {
  const ranges: FoldRange[] = []
  const stack: { indent: number; line: number }[] = []
  texts.forEach((raw, i) => {
    const t = raw.replace(/\s+$/, '')
    if (!t.trim() || /^\s*#/.test(t)) return
    const indent = t.match(/^\s*/)?.[0].length ?? 0
    while (stack.length && stack[stack.length - 1].indent >= indent) {
      const top = stack.pop()!
      const end = i - 1
      if (end - top.line >= 2) ranges.push({ start: top.line, end, count: end - top.line - 1 })
    }
    if (/:\s*$/.test(t)) stack.push({ indent, line: i })
  })
  return ranges
}

function applyInlineFolds(block: HTMLElement, code: HTMLElement, lang: string) {
  const lines = Array.from(code.querySelectorAll<HTMLElement>(':scope > .line'))
  if (lines.length < 8) return
  const texts = lines.map((line) => (line.textContent || '').replace(/\u200b/g, ''))
  let ranges: FoldRange[] = []
  if (BRACE_LANGS.has(lang)) ranges = braceRanges(texts)
  else if (INDENT_LANGS.has(lang)) ranges = indentRanges(texts)
  if (!ranges.length) return

  const nums = Array.from(block.querySelectorAll<HTMLElement>('.line-numbers-wrapper .line-number'))
  // shiki 靠 .line 后的换行文本节点换行；隐藏行时同步清空，避免留下等高空白
  const tails = lines.map((line) => {
    const node = line.nextSibling
    return node && node.nodeType === Node.TEXT_NODE ? (node as Text) : null
  })
  const tailText = tails.map((tail) => tail?.nodeValue ?? null)
  const HIDDEN = 'wl-hidden-line'
  const setHidden = (i: number, hidden: boolean) => {
    lines[i]?.classList.toggle(HIDDEN, hidden)
    if (tails[i]) tails[i]!.nodeValue = hidden ? '' : (tailText[i] ?? '')
    const num = nums[i]
    if (num) {
      num.classList.toggle(HIDDEN, hidden)
      const br = num.nextElementSibling
      if (br && br.tagName === 'BR') br.classList.toggle(HIDDEN, hidden)
    }
  }

  const states = ranges.map(() => false)
  const buttons: HTMLButtonElement[] = []
  const sync = () => {
    for (let i = 0; i < lines.length; i++) {
      setHidden(i, ranges.some((r, k) => states[k] && i > r.start && i < r.end))
    }
    ranges.forEach((r, k) => {
      lines[r.start]?.classList.toggle('wl-line-folded', states[k])
      buttons[k]?.classList.toggle('is-folded', states[k])
      buttons[k]?.setAttribute('aria-expanded', String(!states[k]))
    })
  }

  ranges.forEach((r, k) => {
    const head = lines[r.start]
    if (!head) return
    const btn = document.createElement('button')
    btn.className = 'wl-line-fold'
    btn.type = 'button'
    btn.title = `折叠这 ${r.count} 行（第 ${r.start + 1}–${r.end + 1} 行）`
    btn.setAttribute('aria-label', `折叠第 ${r.start + 1} 至 ${r.end + 1} 行`)
    btn.setAttribute('aria-expanded', 'true')
    head.insertBefore(btn, head.firstChild)
    head.dataset.foldedLines = String(r.count)
    buttons.push(btn)
    btn.addEventListener('click', (event) => {
      event.stopPropagation()
      states[k] = !states[k]
      sync()
    })
  })
  block.classList.add('wl-inline-foldable')
}

function enhanceCodeBlocks() {
  const blocks = document.querySelectorAll<HTMLElement>('.vp-doc div[class*="language-"]')
  blocks.forEach((block) => {
    if (block.classList.contains('wl-enhanced')) return
    const pre = block.querySelector('pre')
    const code = block.querySelector('code')
    if (!pre || !code) return
    block.classList.add('wl-enhanced')

    const match = block.className.match(/language-([a-z0-9+#-]+)/i)
    const lang = (match?.[1] || 'text').toLowerCase()

    const bar = document.createElement('div')
    bar.className = 'wl-codebar'
    const tag = document.createElement('span')
    tag.className = 'wl-codebar-lang'
    tag.textContent = lang.toUpperCase()
    const actions = document.createElement('div')
    actions.className = 'wl-codebar-actions'

    const copy = document.createElement('button')
    copy.className = 'wl-copy'
    copy.type = 'button'
    copy.innerHTML = COPY_ICON
    copy.title = '复制代码'
    copy.setAttribute('aria-label', '复制代码')
    let copyTimer: ReturnType<typeof setTimeout> | undefined
    copy.addEventListener('click', async () => {
      const ok = await copyText(sourceOf(code))
      if (ok) {
        copy.classList.add('done')
        copy.innerHTML = CHECK_ICON
        copy.title = '已复制'
      }
      if (copyTimer) clearTimeout(copyTimer)
      copyTimer = setTimeout(() => {
        copy.classList.remove('done')
        copy.innerHTML = COPY_ICON
        copy.title = '复制代码'
      }, 1600)
    })
    actions.append(copy)

    const lineCount = sourceOf(code).split('\n').length
    if (lineCount >= 8) {
      block.classList.add('wl-foldable')
      const fold = document.createElement('button')
      fold.className = 'wl-fold'
      fold.type = 'button'
      fold.innerHTML = FOLD_ICON + '<span>折叠</span>'
      fold.title = '折叠代码'
      fold.setAttribute('aria-label', '折叠代码')
      fold.setAttribute('aria-expanded', 'true')
      actions.insertBefore(fold, actions.firstChild)

      const expandBar = document.createElement('button')
      expandBar.className = 'wl-fold-bar'
      expandBar.type = 'button'
      expandBar.innerHTML = `${UNFOLD_ICON}<span>展开全部 · 共 ${lineCount} 行</span>`
      expandBar.setAttribute('aria-label', `展开全部代码，共 ${lineCount} 行`)
      block.appendChild(expandBar)

      const setCollapsed = (collapsed: boolean) => {
        block.classList.toggle('is-collapsed', collapsed)
        fold.innerHTML = collapsed
          ? UNFOLD_ICON + '<span>展开</span>'
          : FOLD_ICON + '<span>折叠</span>'
        fold.title = collapsed ? '展开代码' : '折叠代码'
        fold.setAttribute('aria-label', collapsed ? '展开代码' : '折叠代码')
        fold.setAttribute('aria-expanded', String(!collapsed))
      }
      fold.addEventListener('click', () => setCollapsed(!block.classList.contains('is-collapsed')))
      expandBar.addEventListener('click', () => setCollapsed(false))
      setCollapsed(false)
    }

    applyInlineFolds(block, code, lang)
    bar.append(tag, actions)
    block.insertBefore(bar, block.firstChild)
  })
}

/** 按视觉宽度估算单元格文本长度：中文/全角算 2 */
function visualWidth(text: string): number {
  let width = 0
  for (const ch of text) width += /[\u2e80-\uffef]/u.test(ch) ? 2 : 1
  return width
}

function optimizeTables() {
  const tables = document.querySelectorAll<HTMLTableElement>('.vp-doc table')
  tables.forEach((table) => {
    if (table.dataset.wlTableOptimized) return
    table.dataset.wlTableOptimized = '1'

    const fixed = getComputedStyle(table).tableLayout === 'fixed'
    const rows = Array.from(table.querySelectorAll('tr'))
    const colCount = rows.reduce((n, row) => Math.max(n, row.children.length), 0)

    // 1) 短内容列保持不换行（编号、标签、状态等）；::: cols 的 fixed 表格同样适用
    if (colCount >= 2) {
      const widths = new Array<number>(colCount).fill(0)
      for (const row of rows) {
        for (let i = 0; i < row.children.length; i++) {
          const text = (row.children[i].textContent || '').trim()
          widths[i] = Math.max(widths[i], visualWidth(text))
        }
      }
      const longest = Math.max(...widths)
      const short = widths.map((w) => w <= 20 && w < longest)
      if (short.some(Boolean)) {
        for (const row of rows) {
          for (let i = 0; i < row.children.length; i++) {
            if (short[i]) (row.children[i] as HTMLElement).classList.add('wl-nowrap')
          }
        }
      }
    }

    // 2) 包两层容器：frame 放提示，scroll 负责滚动
    let scrollEl: HTMLElement | null = table.parentElement
    if (!scrollEl || !scrollEl.classList.contains('wl-table-scroll')) {
      scrollEl = document.createElement('div')
      scrollEl.className = 'wl-table-scroll'
      table.parentNode?.insertBefore(scrollEl, table)
      scrollEl.appendChild(table)
    }
    let frameEl: HTMLElement | null = scrollEl.parentElement
    if (!frameEl || !frameEl.classList.contains('wl-table-frame')) {
      frameEl = document.createElement('div')
      frameEl.className = 'wl-table-frame'
      scrollEl.parentNode?.insertBefore(frameEl, scrollEl)
      frameEl.appendChild(scrollEl)
      const tip = document.createElement('div')
      tip.className = 'wl-table-tip'
      tip.innerHTML = '<span>⇆</span> 表格较宽，可左右滚动查看（Shift + 滚轮 / 触控板横滑）'
      frameEl.appendChild(tip)
    }

    // 3) 用离屏副本量出各列理想宽度，得出表格 min-width
    if (!fixed && colCount >= 3) {
      const probe = table.cloneNode(true) as HTMLTableElement
      probe.className = (table.className + ' vp-doc').trim()
      probe.removeAttribute('data-wl-table-optimized')
      probe.style.cssText =
        'position:fixed;left:-99999px;top:0;visibility:hidden;width:auto;' +
        'max-width:none;min-width:0;table-layout:auto;margin:0;border:0;'
      probe.querySelectorAll<HTMLElement>('th,td').forEach((cell) => {
        cell.classList.remove('wl-nowrap')
        cell.style.whiteSpace = 'nowrap'
        cell.style.width = 'auto'
      })
      document.body.appendChild(probe)
      const colWidths = new Array<number>(colCount).fill(0)
      probe.querySelectorAll('tr').forEach((row) => {
        Array.from(row.children).forEach((cell, i) => {
          if (i < colCount) {
            colWidths[i] = Math.max(colWidths[i], (cell as HTMLElement).getBoundingClientRect().width)
          }
        })
      })
      probe.remove()
      const MIN_COL = 96
      const MAX_COL = 300
      const total = colWidths.reduce((n, w) => n + Math.min(MAX_COL, Math.max(MIN_COL, Math.ceil(w))), 0)
      const minWidth = Math.min(1600, total)
      if (minWidth > 520) table.style.minWidth = `${minWidth}px`
    } else if (colCount >= 3 && fixed) {
      // ::: cols 已手工指定百分比列宽，这里只给一个窄屏下限，
      // 避免 4 列在手机宽度下被挤成竖排中文；桌面宽度下不生效。
      const floor = Math.min(1000, colCount * 132)
      if (floor > 520) table.style.minWidth = `${floor}px`
    }

    // 4) 滚动状态：是否需要滚动条 / 是否已到最右
    const scroll = scrollEl as HTMLElement
    const frame = frameEl as HTMLElement
    const sync = () => {
      const canScroll = scroll.scrollWidth - scroll.clientWidth > 4
      frame.classList.toggle('is-scrollable', canScroll)
      frame.classList.toggle(
        'at-end',
        !canScroll || scroll.scrollLeft + scroll.clientWidth >= scroll.scrollWidth - 6,
      )
    }
    scroll.addEventListener('scroll', sync, { passive: true })
    requestAnimationFrame(sync)
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(sync)
      observer.observe(scroll)
      observer.observe(table)
    }
  })
}

let timer: ReturnType<typeof setTimeout> | undefined

export function enhancePage() {
  if (typeof document === 'undefined') return
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    enhanceCodeBlocks()
    optimizeTables()
  }, 120)
}
