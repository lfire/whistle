import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'
import './custom.css'
import { initLightbox } from './lightbox'

export default {
  extends: DefaultTheme,
  enhanceApp({ router }) {
    if (typeof window === 'undefined') return
    initLightbox()
    // VitePress 是 SPA：路由切换后正文被整体替换，需要重新标记图片
    const r = router as any
    if (typeof r.onAfterRouteChange === 'function') {
      const prev = r.onAfterRouteChange
      r.onAfterRouteChange = (...args: any[]) => {
        prev?.(...args)
        window.setTimeout(initLightbox, 80)
      }
    }
  }
} satisfies Theme
