# Starter Template Hardening — Design Spec

- **Date**: 2026-04-26
- **Repo**: `AstroAir/react-quick-starter`
- **Scope position**: 公开开源模板（primary） + 个人 starter（secondary）
- **Density**: 中间偏轻 — 补"底座"+ 只示范 Tauri 一端的最佳实践，不替消费者预设 React 业务 pattern
- **Tooling family**: Prettier + 现有 ESLint（不替换为 Biome）

## Goals

将该 starter 提升至开源模板的"标准规范"水位线：补齐 DX 底座、消除内部文档不一致、加固 Tauri 安全与元数据，并示范一组类型化的 IPC 桥。**不**预先示范 store/provider/i18n/theme switcher 等业务相关 pattern——保持模板对未来项目方向的开放性。

## Non-Goals

- 不替换 ESLint / Jest 等现有工具栈
- 不引入 Storybook、Playwright、Cypress、Codecov、Release Please、semantic-release
- 不预置 Zustand store / ThemeProvider / 全局 context / i18n / 错误边界 / loading 页面
- 不启用任何 Tauri 业务 plugin（filesystem / clipboard / dialog / notification 等）
- 不实际启用 updater（只占位 + 文档）
- 不引入 mobile 平台支持
- 不重构现有 6 个 GitHub Actions workflow 的结构

## 当前状态盘点（已确认，避免重复建议）

**已就绪不动**：Next.js 16.2 / React 19.2 / Tauri 2.9 / Tailwind v4 / shadcn (new-york) / Zustand 5；Jest 30 + RTL + jest-junit + 60/70% 覆盖率门槛；6 个 CI workflow（ci/quality/test/build-tauri/release/deploy）；双语 README；CONTRIBUTING/TESTING/CI_CD/CHANGELOG/PR 模板/Issue 模板；Dependabot 分组配置；静态导出（`output: "export"`）。

**待补缺口**（按 4 个段落组织实施）：见下文。

---

## 段落 1 — Developer Experience 底座

### 新增配置文件

| 文件                    | 内容要点                                                                                                                                                             |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.prettierrc.json`      | `semi: false`、`singleQuote: false`、`printWidth: 100`、`tabWidth: 2`、`trailingComma: "es5"`（与 `components/ui/button.tsx` 现有风格一致，不会触发大规模 reformat） |
| `.prettierignore`       | 同 `.gitignore` 主体 + `pnpm-lock.yaml`                                                                                                                              |
| `.husky/pre-commit`     | 执行 `pnpm exec lint-staged`                                                                                                                                         |
| `.husky/commit-msg`     | 执行 `pnpm exec commitlint --edit "$1"`                                                                                                                              |
| `commitlint.config.cjs` | `extends: ['@commitlint/config-conventional']`（与 CONTRIBUTING.md 已声明的规则一致）                                                                                |
| `.lintstagedrc.json`    | `*.{ts,tsx,js,mjs,cjs}` → `eslint --fix` + `prettier --write`；`*.{json,md,yml,yaml,css}` → `prettier --write`                                                       |
| `.nvmrc`                | `20`（与 README "Node 20.x or later" 对齐，CI 复用）                                                                                                                 |
| `.env.example`          | 列出 `NEXT_PUBLIC_APP_NAME`、`NEXT_PUBLIC_API_URL` 占位                                                                                                              |
| `lib/env.ts`            | 最小运行时校验（不引入 zod）：导出 `getPublicEnv()`，缺失变量时抛错；导出类型 `PublicEnv`                                                                            |
| `env.d.ts`              | 扩展 `ProcessEnv`，给 `NEXT_PUBLIC_*` 变量加类型提示                                                                                                                 |

### `package.json` 修订

新增字段：

```json
{
  "packageManager": "pnpm@<本地实际版本，例如 10.10.0>",
  "engines": { "node": ">=20.0.0" }
}
```

**注**：`packageManager` 必须是精确版本（`pnpm@major.minor.patch`），不接受 semver range。实施时跑 `pnpm --version` 取实际值并写入。

新增 devDependencies：`prettier`、`eslint-config-prettier`、`husky`、`lint-staged`、`@commitlint/cli`、`@commitlint/config-conventional`。

新增/修订 scripts：

| script         | 命令                                               |
| -------------- | -------------------------------------------------- |
| `format`       | `prettier --write .`                               |
| `format:check` | `prettier --check .`                               |
| `typecheck`    | `tsc --noEmit`                                     |
| `lint:fix`     | `eslint --fix`                                     |
| `lint`         | `eslint .`（修复当前 `"eslint"` 无显式路径，更稳） |
| `prepare`      | `husky`                                            |

### `eslint.config.mjs` 修订

末尾追加 `eslint-config-prettier` 关闭格式相关规则，避免 ESLint 与 Prettier 互打架。

### CI 改动 — `.github/workflows/quality.yml`

- 新增一步 `pnpm format:check`（lint 之后），失败即阻断
- 新增一步 `pnpm typecheck`（替代原本依赖 ESLint 间接做类型检查的方式）

---

## 段落 2 — 治理 & 文档一致性修订

### 新增治理文件

| 文件                 | 内容                                                                                                                        |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `SECURITY.md`        | 简洁漏洞披露策略：报告渠道（GitHub Security Advisories 私有报告 + 备用邮箱占位）、支持的版本、披露时间窗（90 天）。约 30 行 |
| `.github/CODEOWNERS` | `* @AstroAir @MaxQian888`；`src-tauri/` 留示范注释行 `# @rust-team`                                                         |
| `CODE_OF_CONDUCT.md` | Contributor Covenant 2.1 全文（CONTRIBUTING.md 已引用但文件缺失）                                                           |

### 修订现有文档（消除内部矛盾）

**`README.md`**:

- 删除 "Project Structure" 中虚构的 `tailwind.config.ts`（Tailwind v4 不需要，文件实际不存在）
- "Available Scripts > Frontend Scripts" 表格补全 `test`、`test:watch`、`test:coverage`、`format`、`format:check`、`typecheck`
- "Best Practices > Commits" 一句话指向 commitlint 现已强制（避免文档说"约定"但工具不验证）
- "Configuration > Environment Variables" 改为指向新建的 `.env.example`

**`README_zh.md`**: 同步上述四处修订。

**`CLAUDE.md`**:

- "Architecture > Frontend Structure" 删除 `__tests__/` 一行（仓库实际用 collocated `*.test.tsx`）
- "Development Commands" 把 `pnpm exec tsc --noEmit` 替换为 `pnpm typecheck`，加上 `pnpm format` / `pnpm format:check`
- "Code Patterns" 加一段 1-2 行的 IPC 调用示例（指向段落 4 新增的 `lib/tauri.ts`）

**`AGENTS.md`**: 与 CLAUDE.md 同步上述命令清单。

**`CONTRIBUTING.md`**:

- "Coding Standards" 明示已有 Prettier + Husky + commitlint，附 `pnpm prepare` 指引（首次 clone 必须跑一次激活 hooks）
- "Code of Conduct" 段落改为指向新建的 `CODE_OF_CONDUCT.md`

**`TESTING.md`**: 在"测试组织"段说明 collocated 模式（`*.test.tsx` 与源文件同目录）是约定。

### 显式不动

- 不新增 `ARCHITECTURE.md` / `DECISIONS.md`
- 不替换现有 6 个 workflow 的命名/结构
- 不动 `__mocks__/`、`jest.config.ts`

---

## 段落 3 — Tauri 安全 & 元数据

### `src-tauri/Cargo.toml` 元数据

| 字段          | 当前值          | 改为                                                                                                                      |
| ------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `name`        | `"app"`         | `"react-quick-starter"`（与 `package.json` / `tauri.conf.json` 的 `productName` 一致；`[lib].name = "app_lib"` 保留不变） |
| `description` | `"A Tauri App"` | `"React + Tauri 16/2.9 quick-starter desktop application"`                                                                |
| `authors`     | `["you"]`       | `["AstroAir <astro_air@126.com>"]`                                                                                        |
| `license`     | `""`            | `"MIT"`（与根 LICENSE 一致）                                                                                              |
| `repository`  | `""`            | `"https://github.com/AstroAir/react-quick-starter"`                                                                       |

新增依赖（用于段落 4 的错误派生）：`thiserror = "2"`，`tauri-plugin-updater = "2"`。

### `src-tauri/tauri.conf.json` 安全加固

`app.security.csp` 从 `null` 改为：

```
default-src 'self';
script-src 'self';
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:;
font-src 'self';
connect-src 'self' ipc: http://ipc.localhost;
object-src 'none';
frame-src 'none';
base-uri 'self';
form-action 'self'
```

理由：

- `style-src 'unsafe-inline'` 是必需的（Tailwind v4 注入 inline style；Next.js critical CSS）
- `connect-src` 包含 `ipc: http://ipc.localhost` 以允许 Tauri 2 的 IPC 通道
- 其余按最小权限

`app/layout.tsx` 文件首部加注释：如果接入外部 API，需要在 CSP 的 `connect-src` 显式加入域名。

### Capabilities 拆分骨架

- 保持 `capabilities/default.json` 不动（仍只授 `core:default`）
- 新增 `capabilities/desktop.json` 作为示范文件，**所有权限注释掉**：

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "desktop-extras",
  "description": "Desktop-only permissions (uncomment as needed when adopting plugins)",
  "platforms": ["linux", "macOS", "windows"],
  "windows": ["main"],
  "permissions": [
    // "core:window:allow-set-size",
    // "core:window:allow-minimize",
    // "core:clipboard-manager:allow-write-text"
  ]
}
```

设计意图：给后续添加 plugin 时一个明确的归属位置，避免 capability 都堆在 `default.json`。

### Updater 占位（不引入真实密钥）

- `Cargo.toml` 新增 `tauri-plugin-updater = "2"`
- `lib.rs` 在 `setup` 闭包条件性 register（仅 `#[cfg(desktop)]`）
- `tauri.conf.json` 新增 `plugins.updater` 段，默认禁用：

```json
"plugins": {
  "updater": {
    "active": false,
    "endpoints": [],
    "pubkey": ""
  }
}
```

`active: false` 默认禁用，避免 fork 后忘记配密钥导致启动报错。

新增 `src-tauri/UPDATER.md`（≤50 行）：

1. `pnpm tauri signer generate` 生成密钥对（私钥放 `~/.tauri/`，绝不入仓）
2. 公钥粘贴到 `tauri.conf.json` 的 `plugins.updater.pubkey`
3. `endpoints` 写 GitHub Releases 的 `latest.json` URL（给出模板）
4. CI 用 `TAURI_PRIVATE_KEY` / `TAURI_KEY_PASSWORD` 环境变量签名（指向 `release.yml` 已有注释行）
5. 把 `active` 改为 `true`

### 显式不动

- 不实际启用任何 plugin（filesystem / clipboard / dialog / notification 等）
- 不动 icons、不动现有 `bundle.windows.timestampUrl`（已有，留给签名时填充）
- 不引入 mobile 平台支持

---

## 段落 4 — Tauri IPC 类型化桥

### Rust 端

**新增 `src-tauri/src/commands.rs`**：

```rust
#[derive(Debug, thiserror::Error, serde::Serialize)]
pub enum AppError {
  #[error("name cannot be empty")]
  EmptyName,
}

#[tauri::command]
pub fn greet(name: &str) -> Result<String, AppError> {
  if name.trim().is_empty() { return Err(AppError::EmptyName); }
  Ok(format!("Hello, {name}! Welcome to Tauri 2."))
}

#[cfg(test)]
mod tests {
  use super::*;
  #[test]
  fn greet_with_name() { assert_eq!(greet("World").unwrap(), "Hello, World! Welcome to Tauri 2."); }
  #[test]
  fn greet_empty_errors() { assert!(matches!(greet("").unwrap_err(), AppError::EmptyName)); }
  #[test]
  fn greet_whitespace_errors() { assert!(matches!(greet("   ").unwrap_err(), AppError::EmptyName)); }
}
```

选 `greet(name) -> Result<String, AppError>` 是因为它一次性示范三件最常踩坑的事：参数序列化、Result 错误传播、自定义错误类型 serialize 到 JS。

**`lib.rs` 修订**：在 `Builder::default()` 链上加：

```rust
.invoke_handler(tauri::generate_handler![commands::greet])
```

并在文件首部加 `mod commands;`。

### TypeScript 端

新增 dependency（**dependencies 不是 dev**，运行时使用）：`@tauri-apps/api`。

**新增 `lib/tauri.ts`**：

```ts
import { invoke } from "@tauri-apps/api/core"

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
}

// 类型化桥：每个 Rust command 在这里有一个对应的 wrapper
export async function greet(name: string): Promise<string> {
  return invoke<string>("greet", { name })
}
```

`isTauri()` 用 `__TAURI_INTERNALS__` 这个 Tauri 2 在 webview 注入的 marker（**不是** v1 的 `__TAURI__`，避免误判）。

**约定**：`lib/tauri.ts` 是**唯一**调用 `invoke` 的地方，业务代码只通过这里命名导出函数 → 防止 magic string、保留单点重构能力。

**新增 `lib/tauri.test.ts`**：mock `@tauri-apps/api/core` 的 `invoke`，验证 `greet` 转发了正确的参数。

### 前端 demo（最小侵入）

**新增 `components/tauri-demo.tsx`**（client component）：一个 `<button>` 调 `greet()` 并显示结果，渲染前用 `isTauri()` 早返回 `null`。

**`app/page.tsx` 修订**：在末尾加 `<TauriDemo />`，并加注释 `// Remove this and lib/tauri.ts when not using Tauri IPC`。

**`app/page.test.tsx` 适配**：`<TauriDemo />` 在 Jest 的 jsdom 里因 `isTauri()` 返回 false 渲染 `null`，**无需额外 mock**；但需检查现有 8 个 test case 是否仍稳定（理论上无变化，因 demo 在测试环境不渲染）。

### `jest.config.ts` 微调

`moduleNameMapper` 加：

```ts
"^@tauri-apps/api/core$": "<rootDir>/__mocks__/tauri-api.js"
```

新增 `__mocks__/tauri-api.js`（≤6 行），导出 `invoke = jest.fn()`，保证非 Tauri 环境下的单测不会真的去 import 浏览器专用模块。

### 文档

- README.md "Desktop Application Development" 加一节 "**Calling Rust from JavaScript**"：3 步示意（在 `commands.rs` 加命令 → 在 `lib.rs` 注册 → 在 `lib/tauri.ts` 加 wrapper），≤25 行
- README_zh.md 同步
- CLAUDE.md "Code Patterns" 加 IPC 调用一行示例（已在段落 2 预告）

### 显式不动

- 不引入 `tauri-plugin-shell` / `tauri-plugin-opener`（外链点击当前 `<a target="_blank">` 在 Tauri 2 默认会打开系统浏览器，没问题）
- 不加 Tauri 全局 state（`tauri::State` 模式）—— 业务相关，留给消费者
- 不加 Playwright / E2E

---

## 验收标准

- `pnpm install` 后 `pnpm prepare` 自动激活 git hooks
- `pnpm format:check` / `pnpm lint` / `pnpm typecheck` / `pnpm test` 全部通过
- 提交一个不符合 Conventional Commits 的 message 应被 `commit-msg` hook 拒绝
- 提交时未格式化的 ts/tsx 文件应被 `pre-commit` hook 自动 `prettier --write`
- `pnpm tauri dev` 启动后，页面显示 demo 按钮，点击后显示 "Hello, World! Welcome to Tauri 2."
- `pnpm dev`（纯 web 模式）启动后，demo 按钮**不渲染**（`isTauri()` 返回 false）
- `cargo test --manifest-path src-tauri/Cargo.toml` 通过 3 个 greet 用例
- CI 的 `quality.yml` 在 PR 上跑通新增的 `format:check` 和 `typecheck` 步骤
- `pnpm tauri build` 产出的安装包启动后，打开 webview devtools（Tauri 2 默认 `Ctrl+Shift+I` 启用），Console 中**不应**出现 `Refused to ... because it violates the following Content Security Policy directive` 报错；首屏 demo 按钮可点击并返回结果

## 实施顺序建议

按段落 1 → 2 → 3 → 4 实施（依赖关系单向）。每段落形成一个独立 commit/PR，便于 review。

## 风险与缓解

| 风险                                                                              | 缓解                                                                                                                                       |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 改 `Cargo.toml` 的 `[package].name` 后第一次 `cargo build` 会重新生成 target 目录 | 文档说明这是预期，建议先 `cargo clean`                                                                                                     |
| Husky hook 在 fork 后未自动激活                                                   | `prepare` script 会在 `pnpm install` 时跑；CONTRIBUTING.md 明示                                                                            |
| CSP 太严会破坏未来引入的第三方脚本                                                | 注释中明示扩展位置；任何新增外部资源需要同步修改 CSP                                                                                       |
| `@tauri-apps/api` 加入 dependencies 在纯 web 模式下被打包                         | `isTauri()` 早返回避免运行时调用；`@tauri-apps/api/core` 的 `invoke` 是 ESM 函数，未调用不会真正执行 IPC，对 bundle size 影响 ~3KB gzipped |
| commitlint 拒绝既有非规范 commit message 的 amend 操作                            | hooks 仅校验新 commit，不影响 git history                                                                                                  |
