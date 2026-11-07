import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'
import './custom.css'
import './notes/notes.css'
import { initLightbox } from './lightbox'
// @ts-ignore - 笔记模块为纯 JS ESM，无内置类型声明
import { initNotes, onNotesRouteChange } from './notes/app.js'

export default {
  extends: DefaultTheme,
  enhanceApp({ router }) {
    if (typeof window === 'undefined') return
    initLightbox()
    initNotes()
    // VitePress 是 SPA：路由切换后正文被整体替换，需要重新标记图片与笔记锚点
    const r = router as any
    if (typeof r.onAfterRouteChange === 'function') {
      const prev = r.onAfterRouteChange
      r.onAfterRouteChange = (...args: any[]) => {
        prev?.(...args)
        window.setTimeout(() => {
          initLightbox()
          onNotesRouteChange()
        }, 80)
      }
    }
  }
} satisfies Theme
