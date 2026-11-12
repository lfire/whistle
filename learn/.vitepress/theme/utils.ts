/**
 * 交互组件共用的本地存储工具（进度 / 勾选项按 id 隔离）。
 */
export function normPath(path: string): string {
  const p = (path || '').replace(/\.html$/, '').replace(/\/+$/, '')
  return p || '/'
}

function readList(key: string): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '[]')
    return Array.isArray(value) ? value.map(String) : []
  } catch { return [] }
}
function writeList(key: string, list: string[]) {
  try { localStorage.setItem(key, JSON.stringify(list)) } catch { /* ignore */ }
}

export function readDone(): string[] { return readList('wl:done') }
export function isDone(path: string) { return readDone().includes(normPath(path)) }
export function setDone(path: string, done: boolean) {
  const key = normPath(path)
  const list = readDone().filter((item) => item !== key)
  if (done) list.push(key)
  writeList('wl:done', list)
}

export function readChecks(id: string): boolean[] {
  try {
    const value = JSON.parse(localStorage.getItem(`wl:checks:${id}`) || '[]')
    return Array.isArray(value) ? value.map(Boolean) : []
  } catch { return [] }
}
export function setChecks(id: string, arr: boolean[]) {
  try { localStorage.setItem(`wl:checks:${id}`, JSON.stringify(arr)) } catch { /* ignore */ }
}
