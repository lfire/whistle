/**
 * 笔记用的轻量 Markdown 渲染与格式工具栏。
 * 先整体 HTML 转义，再生成标签，因此用户输入的 HTML 不会被当作节点执行。
 */

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function safeUrl(url) {
  const raw = url.trim()
  return /^(https?:\/\/|mailto:|\/|#)/i.test(raw) ? raw : '#'
}

function inline(source) {
  let text = source
  const codes = []
  text = text.replace(/`([^`]+)`/g, (_, code) => {
    codes.push(code)
    return `\u0000C${codes.length - 1}\u0000`
  })

  text = text
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, url) =>
      `<img src="${escapeHtml(safeUrl(url))}" alt="${escapeHtml(alt)}" loading="lazy">`)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) =>
      `<a href="${escapeHtml(safeUrl(url))}" target="_blank" rel="noopener noreferrer">${label}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/(^|[^_])_([^_]+)_/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')

  return text.replace(/\u0000C(\d+)\u0000/g, (_, index) => `<code>${codes[Number(index)]}</code>`)
}

function isTableDivider(line) {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line)
}

function splitRow(line) {
  return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((cell) => cell.trim())
}

/** 返回安全的 HTML 字符串 */
export function renderMarkdown(source) {
  const lines = escapeHtml(source || '').replace(/\r/g, '').split('\n')
  const out = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index]

    if (/^```/.test(line.trim())) {
      const language = line.trim().slice(3).trim()
      const body = []
      index += 1
      while (index < lines.length && !/^```/.test(lines[index].trim())) {
        body.push(lines[index])
        index += 1
      }
      index += 1
      out.push(`<pre class="wn-md-pre"><code${language ? ` class="language-${language.replace(/[^\w-]/g, '')}"` : ''}>${body.join('\n')}</code></pre>`)
      continue
    }

    if (!line.trim()) { index += 1; continue }

    const heading = line.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      const level = heading[1].length
      out.push(`<h${level + 2}>${inline(heading[2])}</h${level + 2}>`)
      index += 1
      continue
    }

    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
      out.push('<hr>')
      index += 1
      continue
    }

    if (index + 1 < lines.length && line.includes('|') && isTableDivider(lines[index + 1])) {
      const head = splitRow(line)
      index += 2
      const rows = []
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        rows.push(splitRow(lines[index]))
        index += 1
      }
      out.push(`<table><thead><tr>${head.map((cell) => `<th>${inline(cell)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>`)
      continue
    }

    if (/^\s*>\s?/.test(line)) {
      const quote = []
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quote.push(lines[index].replace(/^\s*>\s?/, ''))
        index += 1
      }
      out.push(`<blockquote>${inline(quote.join(' '))}</blockquote>`)
      continue
    }

    const unordered = /^\s*[-*+]\s+/
    const ordered = /^\s*\d+[.)]\s+/
    if (unordered.test(line) || ordered.test(line)) {
      const isOrdered = ordered.test(line)
      const items = []
      while (index < lines.length && (unordered.test(lines[index]) || ordered.test(lines[index]))) {
        let content = lines[index].replace(isOrdered ? ordered : unordered, '')
        const task = content.match(/^\[([ xX])\]\s*(.*)$/)
        if (task) {
          const checked = task[1].toLowerCase() === 'x' ? ' checked' : ''
          content = `<input type="checkbox" disabled${checked}> ${inline(task[2])}`
        } else {
          content = inline(content)
        }
        items.push(`<li>${content}</li>`)
        index += 1
      }
      out.push(`<${isOrdered ? 'ol' : 'ul'}>${items.join('')}</${isOrdered ? 'ol' : 'ul'}>`)
      continue
    }

    const paragraph = []
    while (index < lines.length && lines[index].trim() &&
      !/^(#{1,6}\s|```|\s*>|\s*[-*+]\s|\s*\d+[.)]\s)/.test(lines[index]) &&
      !/^\s*(---+|\*\*\*+)\s*$/.test(lines[index])) {
      paragraph.push(lines[index].trim())
      index += 1
    }
    if (paragraph.length) out.push(`<p>${paragraph.map(inline).join('<br>')}</p>`)
    else index += 1
  }

  return out.join('\n') || '<p class="wn-md-empty">暂无内容</p>'
}

export const TOOLBAR = [
  { id: 'bold', label: 'B', title: '粗体', before: '**', after: '**', sample: '粗体文字' },
  { id: 'italic', label: 'I', title: '斜体', before: '*', after: '*', sample: '斜体文字' },
  { id: 'code', label: '</>', title: '行内代码', before: '`', after: '`', sample: 'code' },
  { id: 'link', label: '链接', title: '插入链接', before: '[', after: '](https://)', sample: '链接文字' },
  { id: 'h3', label: 'H3', title: '小标题', linePrefix: '### ', sample: '小标题' },
  { id: 'ul', label: '列表', title: '无序列表', linePrefix: '- ', sample: '列表项' },
  { id: 'task', label: '待办', title: '待办项', linePrefix: '- [ ] ', sample: '待办事项' },
  { id: 'quote', label: '引用', title: '引用', linePrefix: '> ', sample: '引用内容' },
  { id: 'hr', label: '分隔线', title: '分隔线', insert: '\n---\n' }
]

/** 在 textarea 上套用格式，保持光标位置与撤销体验 */
export function applyToolbar(textarea, action) {
  if (!textarea || !action) return
  const start = textarea.selectionStart
  const end = textarea.selectionEnd
  const value = textarea.value

  if (action.insert) {
    textarea.setRangeText(action.insert, start, end, 'end')
  } else if (action.linePrefix) {
    const lineStart = value.lastIndexOf('\n', start - 1) + 1
    const current = value.slice(lineStart, end)
    if (current.startsWith(action.linePrefix)) {
      textarea.setRangeText(current.slice(action.linePrefix.length), lineStart, end, 'end')
    } else {
      const selected = value.slice(start, end) || action.sample
      textarea.setRangeText(action.linePrefix + selected, lineStart, end, 'end')
      const pos = lineStart + action.linePrefix.length
      textarea.setSelectionRange(pos, pos + selected.length)
    }
  } else if (action.before) {
    const selected = value.slice(start, end) || action.sample
    const replacement = `${action.before}${selected}${action.after}`
    textarea.setRangeText(replacement, start, end, 'end')
    textarea.setSelectionRange(start + action.before.length, start + action.before.length + selected.length)
  }

  textarea.focus()
  textarea.dispatchEvent(new Event('input', { bubbles: true }))
}
