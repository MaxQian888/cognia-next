# Phase 2 — i18n + Theme + E2E + CI 增强 Design Spec

- **Date**: 2026-04-26
- **Repo**: `AstroAir/react-quick-starter`
- **Phase**: 2（在 Phase 1「中间偏轻」之上的 opinionated 扩展）
- **Tooling**: next-intl + next-themes + Playwright + Codecov / CodeQL / Release-Please

## Goals

将模板从「最小底座」升级为「opinionated 完整脚手架」：内置主流 i18n、主题切换、E2E 测试，以及对开源项目最有价值的 4 项 CI 能力。所有选择遵循"业界默认 + Tauri 兼容 + 静态导出友好"原则。

## Non-Goals

- 不引入 Cypress / WebDriver / tauri-driver / Percy / Chromatic / axe-playwright
- 不接入 Crowdin / POEditor / 翻译 CI
- 不引入额外 i18n locale（只 en + zh-CN）
- 不引入 multi-theme palettes（只 light/dark/system）
- 不接入 Lighthouse CI / bundle-size action / Dependabot auto-merge
- 不开 CodeQL Rust（仍 beta）
- 不预置桌面端 E2E（tauri-driver 复杂度成本高 5x）
- 不动现有 6 个 workflow 的整体结构（仅扩展 test.yml + ci.yml + 新增 3 个独立 workflow）
- 不与现有 `release.yml` 双轨竞争（保留它作为应急通道）

## Phase 1 已完成的相关基础（不重复）

- Conventional Commits 已通过 commitlint 强制（Release-Please 直接受益）
- Jest 30 + 覆盖率门槛 + jest-junit（Codecov 直接受益）
- 静态导出 (`output: "export"`) 已配置（next-intl 必须按"无 routing"模式 + Playwright 测 build 产物的策略基于此）
- shadcn/ui Button + lucide-react 已装（ThemeToggle 直接复用）
- 双语 README（en + zh-CN locale 选择对齐）

---

## 段落 1 — i18n（next-intl，"无 URL routing"模式）

### Locale 与 Routing 策略

| 项            | 选择                                                                   | 理由                                                                           |
| ------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Locales       | `en`（默认）+ `zh-CN`                                                  | 与 README/README_zh 对齐                                                       |
| Routing       | **无 URL routing**（next-intl 官方支持的 "without i18n routing" 模式） | Tauri webview 没有公开 URL；与 `output: "export"` 兼容                         |
| Locale 持久化 | `localStorage` + cookie（cookie 作为 RSC `getRequestConfig` 的输入）   | 静态导出场景下 RSC 在 build 时执行，runtime locale 切换由 client provider 处理 |
| 首次访问      | `navigator.language` 推断（fallback `en`）                             | 标准做法                                                                       |

### 新增依赖

`next-intl` (dependencies)

### 新增文件

```
i18n/
  ├── messages/en.json        # 默认语言
  ├── messages/zh-CN.json     # 简中
  ├── config.ts               # locales 列表 + 默认 + Locale 类型
  └── request.ts              # getRequestConfig hook（读 cookie）
components/locale-switcher.tsx     # 客户端切换器
components/locale-switcher.test.tsx
hooks/use-locale.ts                # 读/写 locale 偏好（localStorage + cookie）
```

### 修改文件

- `app/layout.tsx`：包 `<NextIntlClientProvider>`，messages 通过 RSC 层 `getMessages()` 读
- `next.config.ts`：用 `createNextIntlPlugin()` 包装现有 config
- `app/page.tsx`：把硬编码英文文案抽到 `messages/{en,zh-CN}.json`，组件用 `useTranslations()` 读取
- `package.json`：`dependencies` 加 `next-intl`

### 翻译范围

仅 `app/page.tsx` 当前的 ~10-15 个 UI 字符串（"By editing"、"Save and see your changes"、"Deploy now"、"Read our docs" 等）。Header/footer 留给使用者按需扩展。

### 测试

- `LocaleSwitcher` 单测：点击切换、cookie 写入（`document.cookie` 模拟）
- i18n 整合测试通过 E2E（段落 3）

### 显式不动

- 不引入 namespace 拆分（项目体量不需要）
- 不本地化 `SECURITY.md` / `CODE_OF_CONDUCT.md` 等治理文档（惯例保持英文）
- 不示范 ICU plural/select（page.tsx 用不到）

---

## 段落 2 — Theme Switcher（next-themes）

### 接线

- `app/layout.tsx`：`<html lang="en" suppressHydrationWarning>` + 用 `<ThemeProvider>` 包 `{children}`
- `defaultTheme="system"` / `attribute="class"` / `enableSystem` —— 与 `globals.css` 既有 `@custom-variant dark (&:is(.dark *))` 无缝对接

### 新增依赖

`next-themes` (dependencies, ~5KB)

### 新增文件

```
components/theme-provider.tsx   # 包装 next-themes ThemeProvider，封装默认配置
components/theme-toggle.tsx     # 客户端组件：Sun/Moon 图标切换按钮
components/theme-toggle.test.tsx
```

### ThemeToggle 行为

- 2-状态切换：light ⇄ dark（system 模式作为默认初始值，不在 UI 上单独暴露 system 模式选项）
- 图标：当前 dark 时显示 `<Sun />`（点击切到 light），反之显示 `<Moon />`
- ARIA：`aria-label={t("themeToggle.label")}` —— i18n 文本
- 防 hydration 闪烁：`useEffect` + `mounted` flag 控制图标渲染（next-themes 文档推荐做法）

### Demo controls 位置

- `app/page.tsx` 右上角 `fixed` 定位的小 dock，含 `<LocaleSwitcher />` + `<ThemeToggle />`
- 已有的 `<TauriDemo />` 留在原 location（页面底部）

### 修改文件

- `app/layout.tsx`：suppressHydrationWarning + ThemeProvider 包裹
- `app/page.tsx`：右上角 dock 接入 LocaleSwitcher + ThemeToggle
- `package.json`：`dependencies` 加 `next-themes`

### 显式不动

- 不加 shadcn `dropdown-menu`（不引入 radix-ui dropdown 一套依赖）
- 不动 globals.css 的 OKlch theme 变量
- 不做 multi-theme palettes

---

## 段落 3 — E2E（Playwright）

### 测试目标范围

- 测**已构建的 web 静态导出**（`pnpm build` → `out/`），用 `serve` 起 `localhost:3001`
- **不**测 Tauri 桌面 app 自身（需要 tauri-driver 复杂度成本高 5x）
- 理由：UI 代码 100% 共享，static export 测过 = Tauri webview 也过；模板使用者要桌面 E2E 自己接 tauri-driver

### 新增依赖

`@playwright/test` + `serve` (devDependencies)

### 目录与配置

```
e2e/
  ├── smoke.spec.ts           # 2 用例
  ├── theme-toggle.spec.ts    # 1 用例
  └── locale-switcher.spec.ts # 1 用例
playwright.config.ts          # 根目录
```

`playwright.config.ts` 关键配置：

- `testDir: "./e2e"`
- 浏览器：仅 Chromium
- `webServer.command: "pnpm build && pnpm exec serve out -p 3001"` —— 自动构建 + 起服务
- `webServer.reuseExistingServer: !process.env.CI`
- `baseURL: "http://localhost:3001"`
- `fullyParallel: true`
- CI 模式：`retries: 2, workers: 1`；本地默认

### .gitignore 追加

```
playwright-report/
test-results/
blob-report/
```

### 新增 scripts

| script             | 命令                                      |
| ------------------ | ----------------------------------------- |
| `test:e2e`         | `playwright test`                         |
| `test:e2e:ui`      | `playwright test --ui`                    |
| `test:e2e:install` | `playwright install --with-deps chromium` |

### 4 个 smoke 用例

1. `smoke.spec.ts > page loads with main heading` —— 验证页面渲染正常
2. `smoke.spec.ts > tauri demo is hidden in web mode` —— 验证 isTauri() 守卫工作
3. `theme-toggle.spec.ts > toggling theme adds/removes .dark class` —— 验证 next-themes class 写入
4. `locale-switcher.spec.ts > switching locale updates page text` —— 验证 next-intl 切换文案

### 测试规模约束

总 LoC < 200，运行时间 < 30s。**示范模式**而不是覆盖率。

### 显式不动

- 不引入 Cypress / WebDriver / tauri-driver
- 不接入 Percy / Chromatic 视觉回归
- 不接入 axe-playwright 可访问性专测
- 不在多浏览器 matrix 上跑

---

## 段落 4 — CI 增强（A + B + C + E）

### A. Codecov 覆盖率上报

**修改** `.github/workflows/test.yml`：在 `pnpm test:coverage` 步骤之后追加 `codecov/codecov-action@v5` 步骤，上传 `coverage/lcov.info`。

**新增** 根目录 `codecov.yml`：

- 忽略 `e2e/`、`docs/`、`__mocks__/`、`src-tauri/`
- 目标覆盖率与 `jest.config.ts` 一致（70% lines）

**Token**：公开仓库 tokenless；私有仓库需 `CODECOV_TOKEN` secret（README 注明）。

### B. CodeQL 安全扫描

**新增** `.github/workflows/codeql.yml`：

- `github/codeql-action`
- Languages: `javascript-typescript`
- Triggers: `push` 到 master + `pull_request` 到 master + `schedule: cron "0 6 * * 1"`（每周一 06:00 UTC）
- Query suite: `security-and-quality`
- 完全免费、无 secret

### C. Release-Please 自动化

**新增** `.github/workflows/release-please.yml`：

- 触发 `push` 到 master
- 用 `googleapis/release-please-action@v4`
- 引用 manifest 配置

**新增配置文件**：

- `.release-please-manifest.json`：`{ ".": "0.1.0" }`
- `.release-please-config.json`：定义 release-type=node + extra-files 同步 Cargo.toml + tauri.conf.json

**三处版本号同步**（关键设计）：

- `package.json`（主）—— release-please 直接管
- `src-tauri/tauri.conf.json` —— 通过 `extra-files` + JSONPath `$.version`
- `src-tauri/Cargo.toml` —— 通过 `extra-files` + 行级注释。需要在 `version = "0.1.0"` 行末尾加 `# x-release-please-version` 标记

**首次启用注意**：Release-Please 不回溯历史，第一次 release 从 manifest 当前版本起算（不是 v0.0.1 全部历史）。README 注明。

**与 `release.yml` 关系**：`release.yml` 是 manual workflow_dispatch，保留作为应急通道；新流程是 master push 自动触发。两者并存不冲突。

### E. E2E 跑在 CI 上

**新增** `.github/workflows/e2e.yml`：

- 触发 `workflow_call` + `workflow_dispatch`
- 步骤：
  1. checkout
  2. setup pnpm + node 20
  3. `pnpm install --frozen-lockfile`
  4. **缓存 Playwright 浏览器**：`actions/cache@v4` 键 `playwright-${{ hashFiles('pnpm-lock.yaml') }}`
  5. 缓存未命中时：`pnpm test:e2e:install`
  6. `pnpm test:e2e`
  7. 失败时上传 `playwright-report/` artifact（保留 30 天）
- 仅 Ubuntu / Chromium

**修改** `.github/workflows/ci.yml`：在现有 quality+test 之后增加 e2e job 调用。

### 文档更新

- README + README_zh 在 "CI/CD" 段落新增一节，列出 4 项新增 + 必要 secret 表格
- `CI_CD.md` 同步 4 项新能力 + secret 配置说明

### 显式不动

- 不开 Codecov 的 PR comment / status check（外部噪音）
- 不加 CodeQL autobuild
- 不加 Lighthouse / Bundle-size action
- 不改 `release.yml`（保留双轨）

---

## 验收标准

- `pnpm install` 后所有依赖 OK；`pnpm dev` 启动后页面右上角能看到 LocaleSwitcher + ThemeToggle
- 切换 locale → 页面文案在 en/zh-CN 之间切换；reload 后保持选择
- 切换 theme → `<html>` 上 `.dark` class 切换；reload 后保持选择
- `pnpm format:check` / `pnpm lint` / `pnpm typecheck` / `pnpm test` 全过
- `pnpm test:e2e` 本地 4 用例全过（运行时间 < 30s）
- `pnpm tauri build` 出包成功（i18n + theme 在 webview 里运行正常）
- CI 上的 e2e workflow 在 PR 上跑通；CodeQL workflow 在 push 上跑通
- 提交 conventional commit 到 master 后，release-please workflow 自动开/更新一个 release PR

## 实施顺序建议

按段落 1 → 2 → 3 → 4 实施（依赖关系单向：theme 用 i18n 的 t() 函数；E2E 测 i18n + theme；CI 包含 E2E job）。

## 风险与缓解

| 风险                                                                                                          | 缓解                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| next-intl 在 static export 模式下 RSC `getMessages()` 读 cookie 行为不直观                                    | 段落 1 的 `i18n/request.ts` 用文档化的 "without i18n routing" 模式 + 注释说明                                                        |
| next-themes 与 Tauri webview 的 prefers-color-scheme 不一致                                                   | 提供 system + manual override；用户切换后 localStorage 持久化                                                                        |
| Playwright 在 `pnpm tauri build` 静态导出后的 `out/` 上跑，可能缺 `_next` 路径处理                            | webServer 用 `serve out -p 3001`，serve 自动处理 SPA fallback                                                                        |
| Release-Please 三文件同步如果 Cargo.toml 注释格式漂移                                                         | 在 Cargo.toml 注释处用 release-please 官方推荐的标记 `# x-release-please-version`                                                    |
| CodeQL 在 fork 后默认开但 fork 仓库可能没启用 Actions                                                         | README 注明：fork 后需要在 Settings → Actions 启用                                                                                   |
| Codecov tokenless 公开仓库支持，但私有仓库静默失败                                                            | codecov-action 步骤加 `continue-on-error: true`，避免阻塞 CI                                                                         |
| 新增 4 个 workflow 增加 CI 时间                                                                               | E2E + Codecov 占主要时间；CodeQL 异步，Release-Please 极快；总增量 < 5 分钟                                                          |
| 模板使用者 fork 后命名（仓库名/包名）不同                                                                     | release-please-config 的 GitHub repo URL 在 .release-please-config.json 里硬编码——README 注明改这里                                  |
| 现有 `app/page.test.tsx`（8 用例）渲染 page，page 加了 `useTranslations()` 后没有 NextIntlClientProvider 会抛 | 在 `jest.setup.ts` 注入 mock provider，或在每个相关 test 用 `<NextIntlClientProvider locale="en" messages={...}>` 包裹（实施时择优） |
