/**
 * 图片放大查看器
 * ------------------------------------------------------------
 * 站点里的架构图 / 时序图信息密度高，缩在正文宽度里看不清文字。
 * 这里为 .vp-doc 内所有图片提供点击放大：滚轮/按钮缩放、拖拽平移、
 * 双击切换 1:1、ESC 关闭。零依赖，纯 DOM 实现。
 */

let overlay: HTMLElement | null = null
let stage: HTMLElement | null = null
let largeImage: HTMLImageElement | null = null
let scaleLabel: HTMLElement | null = null
let captionEl: HTMLElement | null = null

let scale = 1
let translateX = 0
let translateY = 0
let naturalWidth = 0
let naturalHeight = 0
let dragging = false
let dragOriginX = 0
let dragOriginY = 0
let translateOriginX = 0
let translateOriginY = 0
let observer: MutationObserver | null = null
let markTimer = 0

const MIN_SCALE = 0.1
const MAX_SCALE = 8

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function applyTransform() {
  if (!stage) return
  stage.style.transform = `translate3d(${translateX}px, ${translateY}px, 0) scale(${scale})`
  if (scaleLabel) scaleLabel.textContent = `${Math.round(scale * 100)}%`
}

function fitToViewport() {
  if (!naturalWidth || !naturalHeight) return
  const availableW = Math.max(200, window.innerWidth - 96)
  const availableH = Math.max(200, window.innerHeight - 180)
  scale = clamp(Math.min(availableW / naturalWidth, availableH / naturalHeight), MIN_SCALE, 1)
  translateX = 0
  translateY = 0
  applyTransform()
}

function showOriginalSize() {
  scale = 1
  applyTransform()
}

function zoomBy(factor: number) {
  const next = clamp(scale * factor, MIN_SCALE, MAX_SCALE)
  if (next === scale) return
  // 放大时把已平移的偏移按比例收敛，避免图片跑出视野
  const ratio = next / scale
  translateX *= ratio
  translateY *= ratio
  scale = next
  applyTransform()
}

function close() {
  if (!overlay) return
  overlay.classList.remove('is-open')
  document.body.classList.remove('wlb-no-scroll')
  largeImage?.removeAttribute('src')
}

function open(image: HTMLImageElement) {
  if (!overlay || !largeImage || !captionEl) return
  const src = image.getAttribute('data-zoom-src') || image.currentSrc || image.src
  const alt = image.getAttribute('alt') || ''
  largeImage.src = src
  largeImage.alt = alt
  captionEl.textContent = alt || '架构图 / 示意图'
  overlay.classList.add('is-open')
  document.body.classList.add('wlb-no-scroll')

  const probe = new Image()
  probe.onload = () => {
    naturalWidth = probe.naturalWidth || image.naturalWidth || 1600
    naturalHeight = probe.naturalHeight || image.naturalHeight || 900
    fitToViewport()
  }
  probe.onerror = () => {
    naturalWidth = image.naturalWidth || 1600
    naturalHeight = image.naturalHeight || 900
    fitToViewport()
  }
  probe.src = src
}

function buildOverlay(): HTMLElement {
  const root = document.createElement('div')
  root.className = 'wlb'
  root.setAttribute('role', 'dialog')
  root.setAttribute('aria-modal', 'true')
  root.setAttribute('aria-label', '图片放大查看')
  root.innerHTML = `
    <div class="wlb__backdrop" data-act="close"></div>
    <div class="wlb__bar">
      <div class="wlb__brand"><span class="wlb__dot"></span> 图片查看器</div>
      <div class="wlb__actions">
        <button type="button" data-act="zoom-out" title="缩小 ( - )" aria-label="缩小">−</button>
        <span class="wlb__scale" aria-live="polite">100%</span>
        <button type="button" data-act="zoom-in" title="放大 ( + )" aria-label="放大">+</button>
        <button type="button" data-act="original" title="1:1 原始尺寸 ( 0 )">1:1 原始尺寸</button>
        <button type="button" data-act="fit" title="适应窗口">适应窗口</button>
        <button type="button" class="wlb__close" data-act="close" title="关闭 ( Esc )" aria-label="关闭">✕</button>
      </div>
    </div>
    <div class="wlb__viewport">
      <div class="wlb__stage"><img class="wlb__img" alt="" draggable="false" /></div>
    </div>
    <div class="wlb__foot">
      <div class="wlb__caption"></div>
      <div class="wlb__hint">滚轮缩放 · 按住拖拽 · 双击切换 1:1 · ESC 关闭</div>
    </div>
  `
  return root
}

function onOverlayClick(event: MouseEvent) {
  const target = event.target as HTMLElement
  const action = target.closest<HTMLElement>('[data-act]')?.dataset.act
  if (!action) return
  if (action === 'close') close()
  else if (action === 'zoom-in') zoomBy(1.25)
  else if (action === 'zoom-out') zoomBy(1 / 1.25)
  else if (action === 'fit') fitToViewport()
  else if (action === 'original') showOriginalSize()
}

function onWheel(event: WheelEvent) {
  if (!overlay?.classList.contains('is-open')) return
  event.preventDefault()
  zoomBy(event.deltaY < 0 ? 1.14 : 1 / 1.14)
}

function onDocumentClick(event: MouseEvent) {
  if (!overlay?.classList.contains('is-open')) return
  const target = event.target as HTMLElement
  if (target.tagName === 'IMG' && target.closest('.wlb')) return
  // overlay 内部的空白点击不关闭，交给 backdrop 处理
}

function onKeyDown(event: KeyboardEvent) {
  if (!overlay?.classList.contains('is-open')) return
  if (event.key === 'Escape') { event.preventDefault(); close() }
  else if (event.key === '+' || event.key === '=') { event.preventDefault(); zoomBy(1.25) }
  else if (event.key === '-' || event.key === '_') { event.preventDefault(); zoomBy(1 / 1.25) }
  else if (event.key === '0') { event.preventDefault(); showOriginalSize() }
  else if (event.key === 'f' || event.key === 'F') { event.preventDefault(); fitToViewport() }
}

function onPointerDown(event: PointerEvent) {
  if (!overlay?.classList.contains('is-open')) return
  const target = event.target as HTMLElement
  if (target.closest('.wlb__bar') || target.closest('.wlb__foot')) return
  dragging = true
  dragOriginX = event.clientX
  dragOriginY = event.clientY
  translateOriginX = translateX
  translateOriginY = translateY
  overlay.classList.add('is-dragging')
  ;(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId)
}

function onPointerMove(event: PointerEvent) {
  if (!dragging) return
  translateX = translateOriginX + event.clientX - dragOriginX
  translateY = translateOriginY + event.clientY - dragOriginY
  applyTransform()
}

function onPointerUp() {
  dragging = false
  overlay?.classList.remove('is-dragging')
}

function markImages() {
  document.querySelectorAll<HTMLImageElement>('.vp-doc img').forEach((img) => {
    if (img.classList.contains('no-zoom') || img.dataset.zoomBound === '1') return
    img.dataset.zoomBound = '1'
    img.classList.add('wlb-zoomable')
    img.title = '点击放大查看'
  })
}

function scheduleMark() {
  window.clearTimeout(markTimer)
  markTimer = window.setTimeout(markImages, 60)
}

function onBodyClick(event: MouseEvent) {
  const target = event.target as HTMLElement
  if (target.tagName !== 'IMG') return
  if (target.classList.contains('no-zoom')) return
  if (!target.closest('.vp-doc')) return
  event.preventDefault()
  event.stopPropagation()
  open(target as HTMLImageElement)
}

export function initLightbox() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return
  if (!overlay) {
    overlay = buildOverlay()
    document.body.appendChild(overlay)
    stage = overlay.querySelector('.wlb__stage')
    largeImage = overlay.querySelector('.wlb__img')
    scaleLabel = overlay.querySelector('.wlb__scale')
    captionEl = overlay.querySelector('.wlb__caption')

    overlay.addEventListener('click', onOverlayClick)
    overlay.addEventListener('wheel', onWheel, { passive: false })
    overlay.addEventListener('pointerdown', onPointerDown)
    overlay.addEventListener('pointermove', onPointerMove)
    overlay.addEventListener('pointerup', onPointerUp)
    overlay.addEventListener('pointercancel', onPointerUp)
    overlay.addEventListener('dblclick', (e) => {
      const target = e.target as HTMLElement
      if (target.closest('.wlb__bar') || target.closest('.wlb__foot')) return
      if (scale >= 0.99 && scale <= 1.01) fitToViewport()
      else showOriginalSize()
    })
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('click', onBodyClick, true)
    document.addEventListener('click', onDocumentClick)
    window.addEventListener('resize', () => {
      if (overlay?.classList.contains('is-open')) fitToViewport()
    })
  }
  if (!observer) {
    observer = new MutationObserver(scheduleMark)
    observer.observe(document.body, { childList: true, subtree: true })
  }
  markImages()
}
