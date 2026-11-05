import { defineConfig } from 'vitepress'
// @ts-ignore - markdown-it-container 没有内置类型声明
import container from 'markdown-it-container'

const BASE = '/whistle/'

const guide = [
  { text: '站点导览与代码地图', link: '/guide/orientation' }
]

const domain = [
  { text: '1. 代理的形态与 CONNECT 隧道', link: '/domain/proxy-basics' },
  { text: '2. HTTPS、证书链与中间人', link: '/domain/tls-mitm' },
  { text: '3. HTTP/2、WebSocket 与流量形态', link: '/domain/web-protocols' },
  { text: '4. 抓包调试的能力模型', link: '/domain/debugging-workflow' }
]

const architecture = [
  { text: '5. 一张图看懂全局架构', link: '/architecture/overview' },
  { text: '6. 从 w2 start 到端口监听', link: '/architecture/startup' },
  { text: '7. 进程模型与配置系统', link: '/architecture/process-config' }
]

const core = [
  { text: '8. 一次 HTTP 代理请求的旅程', link: '/core/http-request' },
  { text: '9. CONNECT 判定与 TLS 解密', link: '/core/connect-mitm' },
  { text: '10. 隧道、WebSocket 与帧拦截', link: '/core/tunnel-websocket' },
  { text: '11. 抓包数据的采集与上报', link: '/core/capture-data' }
]

const modules = [
  { text: '12. 规则引擎：解析与匹配', link: '/modules/rules-engine' },
  { text: '13. 指令体系与分发链路', link: '/modules/protocol-catalog' },
  { text: '14. 证书体系的实现细节', link: '/modules/certificates' },
  { text: '15. 插件系统', link: '/modules/plugins' },
  { text: '16. Web 管理界面', link: '/modules/webui' }
]

// 横向专题：从工程问题出发，向上追溯设计思想、向下追溯到源码细节
const scenarios = [
  { text: '专题总览：场景、设计思想与源码追溯', link: '/scenarios/index' },
  { text: '本地联调与环境切换', link: '/scenarios/local-env' },
  { text: '接口未就绪：Mock 与契约先行', link: '/scenarios/mock-contract' },
  { text: '复现、保存与重放', link: '/scenarios/reproduce-replay' },
  { text: '弱网与异常注入', link: '/scenarios/fault-injection' },
  { text: 'HTTPS、证书与鉴权排障', link: '/scenarios/https-trust' },
  { text: '真机、移动端与远程调试', link: '/scenarios/mobile-remote' },
  { text: '团队协作与配置即代码', link: '/scenarios/collab-config' },
  { text: 'CI、嵌入式集成与自动化', link: '/scenarios/automation' },
  { text: '能力边界、风险与合规', link: '/scenarios/boundaries' }
]

const advanced = [
  { text: '17. 三个动手实验', link: '/advanced/hands-on' },
  { text: '18. 源码阅读与调试路线', link: '/advanced/source-reading' },
  { text: '19. 术语、路径与配置速查', link: '/advanced/reference' }
]

export default defineConfig({
  lang: 'zh-CN',
  title: 'Whistle 源码研读',
  description: '基于 guide 分支的 Whistle 实现原理、源码细节与网络代理领域知识',
  base: BASE,
  lastUpdated: true,
  cleanUrls: false,
  metaChunk: true,
  srcExclude: ['README.md'],
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: `${BASE}favicon.svg` }],
    ['meta', { name: 'theme-color', content: '#1d7f6e' }],
    ['meta', { name: 'og:title', content: 'Whistle 源码研读' }],
    ['meta', { name: 'og:description', content: '从代理原理到源码实现，逐级吃透 Whistle' }]
  ],
  markdown: {
    lineNumbers: true,
    config(md) {
      // 自定义容器：用 ::: cols 20|30|50 精确控制表格列宽，避免宽表列宽失衡
      md.use(container, 'cols', {
        validate: (params: string) => /^cols\s+[\d|.]+$/.test(params.trim()),
        render(tokens: any[], idx: number) {
          if (tokens[idx].nesting === 1) {
            const raw = tokens[idx].info.trim().replace(/^cols\s+/, '')
            const widths = raw.split('|').map((w: string) => parseFloat(w))
            const vars = widths
              .map((w: number, i: number) => `--c${i + 1}:${w}%`)
              .join(';')
            return `<div class="tbl-cols" style="${vars}">\n`
          }
          return '</div>\n'
        }
      })
    }
  },
  themeConfig: {
    outlineTitle: '本页目录',
    outline: [2, 3],
    docFooter: { prev: '上一篇', next: '下一篇' },
    lastUpdatedText: '最后更新',
    returnToTopLabel: '回到顶部',
    darkModeSwitchLabel: '主题',
    lightModeSwitchTitle: '切换到浅色模式',
    darkModeSwitchTitle: '切换到深色模式',
    sidebarMenuLabel: '目录',
    nav: [
      { text: '导览', link: '/guide/orientation' },
      { text: '领域基础', link: '/domain/proxy-basics' },
      { text: '架构与链路', link: '/architecture/overview' },
      { text: '模块深潜', link: '/modules/rules-engine' },
      { text: '工程场景', link: '/scenarios/index' },
      { text: '实战速查', link: '/advanced/hands-on' }
    ],
    sidebar: [
      { text: '开始之前', items: guide },
      { text: '第一层 · 领域基础', items: domain },
      { text: '第二层 · 全局架构', items: architecture },
      { text: '第三层 · 核心链路', items: core },
      { text: '第四层 · 模块深潜', items: modules },
      { text: '专题 · 工程场景', items: scenarios },
      { text: '第五层 · 进阶实践', items: advanced }
    ],
    search: {
      provider: 'local',
      options: {
        translations: {
          button: { buttonText: '搜索文档', buttonAriaLabel: '搜索文档' },
          modal: {
            noResultsText: '没有找到结果',
            resetButtonTitle: '清除查询',
            footer: { selectText: '选择', navigateText: '切换', closeText: '关闭' }
          }
        }
      }
    },
    editLink: {
      pattern: 'https://github.com/lfire/whistle/edit/guide/learn/:path',
      text: '在 GitHub 上编辑本页'
    },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/lfire/whistle' }
    ],
    footer: {
      message: '基于 guide 分支 · whistle v2.10.13 源码撰写 · 非官方文档',
      copyright: '站点内容遵循 MIT 许可'
    }
  }
})
