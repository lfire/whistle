/**
 * GitHub 账号身份 + 私有 Gist 存储。
 * 令牌只保存在当前站点的 localStorage，请求只发往 api.github.com。
 */

const API = 'https://api.github.com'
const TOKEN_KEY = 'wn:token'
const FILE_NAME = 'whistle-study-notes.json'
const GIST_DESC = 'Whistle 源码研读站 · 学习笔记'

export const TOKEN_HELP_URL =
  'https://github.com/settings/tokens/new?scopes=gist&description=Whistle%20Study%20Notes'

export function getToken() {
  try { return localStorage.getItem(TOKEN_KEY) || '' } catch { return '' }
}
export function setToken(value) {
  try {
    if (value) localStorage.setItem(TOKEN_KEY, value)
    else localStorage.removeItem(TOKEN_KEY)
  } catch { /* 隐私模式下忽略 */ }
}
export function clearToken() { setToken('') }

function gistKey(login) { return `wn:gist:${login}` }
export function getGistId(login) {
  try { return localStorage.getItem(gistKey(login)) || '' } catch { return '' }
}
export function setGistId(login, id) {
  try {
    if (id) localStorage.setItem(gistKey(login), id)
    else localStorage.removeItem(gistKey(login))
  } catch { /* ignore */ }
}

function friendly(status, message) {
  if (status === 401) return '令牌无效或已过期，请重新输入 GitHub Token'
  if (status === 403) {
    return /rate limit/i.test(message || '')
      ? 'GitHub API 调用过于频繁，请稍后再试'
      : '令牌权限不足：创建时请勾选 gist 权限'
  }
  if (status === 404) return '笔记 Gist 不存在（可能已被删除）'
  if (status === 422) return message || 'GitHub 拒绝了这次请求'
  return message || `GitHub API 请求失败（${status}）`
}

async function request(path, token, options = {}) {
  let res
  try {
    res = await fetch(`${API}${path}`, {
      ...options,
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(options.headers || {})
      }
    })
  } catch {
    throw new Error('网络不可用，请检查连接后重试')
  }
  if (!res.ok) {
    let message = ''
    try { message = (await res.json()).message || '' } catch { /* ignore */ }
    const error = new Error(friendly(res.status, message))
    error.status = res.status
    throw error
  }
  if (res.status === 204) return null
  return res.json()
}

/** 用 /user 把令牌解析成 GitHub 账号，账号即笔记数据的隔离单元 */
export async function fetchUser(token) {
  const user = await request('/user', token)
  return {
    login: user.login,
    name: user.name || user.login,
    avatar: user.avatar_url || ''
  }
}

export function emptyData(owner) {
  return { version: 1, owner, updatedAt: new Date().toISOString(), notes: [], images: {} }
}

/** 读取 Gist；返回 { notFound } / { data } */
export async function loadGist(token, gistId) {
  if (!gistId) return { data: null }
  try {
    const gist = await request(`/gists/${gistId}`, token)
    const file = gist.files && gist.files[FILE_NAME]
    if (!file) return { data: null }
    let content = file.content
    if (file.truncated || typeof content !== 'string') {
      const raw = await fetch(file.raw_url, {
        headers: { Authorization: `Bearer ${token}` }
      })
      if (!raw.ok) throw new Error('读取笔记正文失败')
      content = await raw.text()
    }
    return { data: JSON.parse(content) }
  } catch (error) {
    if (error.status === 404) return { notFound: true }
    throw error
  }
}

export async function createGist(token, data) {
  const gist = await request('/gists', token, {
    method: 'POST',
    body: JSON.stringify({
      description: GIST_DESC,
      public: false,
      files: { [FILE_NAME]: { content: JSON.stringify(data, null, 2) } }
    })
  })
  return gist.id
}

export async function updateGist(token, gistId, data) {
  await request(`/gists/${gistId}`, token, {
    method: 'PATCH',
    body: JSON.stringify({
      description: GIST_DESC,
      files: { [FILE_NAME]: { content: JSON.stringify(data, null, 2) } }
    })
  })
}

/** 以笔记 id 为单位合并，updatedAt 较新者胜；返回合并后数据 */
export function mergeData(local, remote) {
  const map = new Map()
  for (const note of (remote && remote.notes) || []) map.set(note.id, note)
  for (const note of (local && local.notes) || []) {
    const old = map.get(note.id)
    if (!old || new Date(note.updatedAt || 0) > new Date(old.updatedAt || 0)) {
      map.set(note.id, note)
    }
  }
  const notes = [...map.values()].sort(
    (a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0)
  )
  // 图片按 id 合并，本地新增的（尚未同步）优先保留
  const images = {
    ...((remote && remote.images) || {}),
    ...((local && local.images) || {})
  }
  return {
    version: 1,
    owner: (remote && remote.owner) || (local && local.owner) || '',
    notes,
    images
  }
}
