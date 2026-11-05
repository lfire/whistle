# Whistle 源码研读站

一套面向开发者的 Whistle 源码学习站点，基于 VitePress 构建，通过 GitHub Actions 自动发布到 GitHub Pages。

- 源码基线：分支 `guide`，提交 `3b85cebc4`，`whistle v2.10.13`
- 站点地址：`https://<owner>.github.io/whistle/`（`base` 固定为 `/whistle/`）
- 内容：29 篇正文 + 15 张自绘 SVG 架构图，五层逐级递进，外加一层横向「工程场景」专题
- 定位：讲「实现原理 + 源码细节 + 领域知识 + 工程场景」，与仓库根目录 `docs/` 的官方使用文档互补
- 工程场景专题：`scenarios/` 下 10 篇，从真实工程问题出发，向上追溯整体业务设计思想、向下定位到源码路径与行号；场景与规则均取自官方使用文档、集成测试与 CGI 实现

## 本地开发

```bash
cd learn
npm ci           # 首次或 lock 文件变化后
npm run dev      # 本地预览，默认 http://localhost:5173/whistle/
npm run build    # 产出到 learn/.vitepress/dist
npm run preview  # 预览构建产物
```

Node.js 20 及以上（VitePress 1.6 要求 Node 18+，CI 固定使用 20）。

## 目录结构

```text
learn/
├── .vitepress/
│   ├── config.mts           # 站点配置：base、导航、侧栏、cols 容器
│   └── theme/
│       ├── index.ts         # 继承默认主题，客户端挂载图片查看器
│       ├── custom.css       # 主题色、表格列宽、首页卡片、查看器样式
│       └── lightbox.ts      # 图片放大：缩放 / 拖拽 / 1:1 / ESC
├── public/
│   ├── diagrams/*.svg       # 15 张架构图与时序图
│   └── favicon.svg
├── guide/  domain/  architecture/  core/  modules/  scenarios/  advanced/
├── index.md                 # 首页（VitePress home layout）
├── package.json
└── package-lock.json
```

## 写作约定

**表格列宽**：普通表格限制在 4 列以内、单元格文字尽量短。需要精确控制列宽时，用自定义容器包裹 markdown 表格：

```markdown
::: cols 18|32|34|16
| 类别 | 代表指令 | 作用 | 实现文件 |
|---|---|---|---|
| 请求改写 | `reqHeaders` | 改请求头 | `inspectors/req.js` |
:::
```

容器会把百分比写成 CSS 变量（`--c1` … `--c6`），由 `custom.css` 中的 `.tbl-cols table` 规则应用为固定列宽；窄屏自动退回横向滚动。

**图片**：全部放在 `public/diagrams/`，正文用 `![图注](/diagrams/xxx.svg)` 引用（VitePress 构建时自动补 base）。图片点击会打开查看器，支持滚轮缩放、按住拖拽、双击切换 1:1、`0` 键回到原始尺寸、`f` 适应窗口、`Esc` 关闭。SVG 必须显式声明 `width` / `height` / `viewBox`，否则查看器无法取得固有尺寸。

**源码引用**：一律使用仓库相对路径加行号，例如 `lib/tunnel.js:168-213`，不要写本机绝对路径。

**工程场景文档模板**：`scenarios/` 下每篇（总览页除外）固定使用「场景与痛点 → 可复制的配置 → 背后的设计思想 → 源码链路 → 边界与坑 → 小结 → 下一步」七段结构。其中「设计思想」必须链接回前面的架构/领域章节，「源码链路」必须链接到核心链路/模块章节并给出 `路径:行号`，以此保证每个场景都双向可追溯。配置与命令需注明来源（`docs/docs/` 文档、`test/` 用例或源码），不得凭常识编造。

**新增文档**：把 markdown 放入对应目录后，在 `.vitepress/config.mts` 的侧栏数组里补一条；如需使用 `::: cols`，无需额外配置。

## 部署

工作流：`.github/workflows/deploy-learn.yml`。

触发条件：向 `guide` / `master` / `main` 推送且改动包含 `learn/**` 或工作流文件本身；也可在 Actions 页面手动 `Run workflow`。

流程：`actions/checkout` → `setup-node`（缓存 `learn/package-lock.json`）→ `npm ci --prefix learn` → `npm run build --prefix learn` → `configure-pages` → `upload-pages-artifact`（`learn/.vitepress/dist`）→ `deploy-pages`。使用官方 Pages 部署通道，无需 `gh-pages` 分支，也无需在仓库里存 token。

**首次启用只需一次设置**：仓库 → Settings → Pages → Build and deployment → Source 选择 **GitHub Actions**。之后每次推送会自动构建发布。

> 若把站点发布到个人主页仓库（`*.github.io`）或使用自定义域名，需同步修改 `config.mts` 里的 `BASE`，并视情况调整工作流中的 `path` 与 Pages 设置。

## 注意事项

- 站点内容与源码版本绑定；升级 Whistle 后请核对文档中的路径、行号与默认值。
- HTTPS 中间人相关内容仅用于调试自己有权调试的流量，请勿在生产环境或他人设备上滥用。
