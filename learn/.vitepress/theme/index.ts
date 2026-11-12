import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'
import './custom.css'
import './enhance.css'
import './notes/notes.css'
import { initLightbox } from './lightbox'
import { enhancePage } from './enhance'
// @ts-ignore - 笔记模块为纯 JS ESM，无内置类型声明
import { initNotes, onNotesRouteChange } from './notes/app.js'

// 通用交互组件（同步自 go 教程站）：新增 .vue 文件即自动注册
const components = import.meta.glob('./components/*.vue', { eager: true }) as
  Record<string, { default: any }>

export default {
  extends: DefaultTheme,
  enhanceApp({ app, router }) {
    for (const path in components) {
      const name = path.split('/').pop()!.replace(/\.vue$/, '')
      app.component(name, components[path].default)
    }
    if (typeof window === 'undefined') return

    initLightbox()
    initNotes()
    enhancePage()

    // VitePress 是 SPA：路由切换后正文被整体替换，需重做图片、笔记锚点与表格/代码增强
    const r = router as any
    const prev = typeof r.onAfterRouteChange === 'function' ? r.onAfterRouteChange : null
    r.onAfterRouteChange = (...args: any[]) => {
      prev?.(...args)
      window.setTimeout(() => {
        initLightbox()
        onNotesRouteChange()
        enhancePage()
      }, 80)
    }
  }
} satisfies Theme
