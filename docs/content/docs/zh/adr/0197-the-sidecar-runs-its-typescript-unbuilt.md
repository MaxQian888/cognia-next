---
title: "0197 — sidecar 直接运行未经构建的 TypeScript"
description: "Claude sidecar 有约 5 万行无类型 `.mjs`，分散在扁平 `dispatch/` 和部分分目录的 `builtin-tools/` 中。存在循环依赖、2000 行闭包，以及最多重复七遍的工具函数。迁入分层 `sidecar/src/`，改为由 Node 26 类型剥离直接运行的严格 TypeScript。原进程入口保留为 `.mjs` 启动器，以分层门禁、独立类型检查、统一测试运行器和失败即拒绝（fail-closed）的打包守卫保持结构。"
---

# ADR 0197 — sidecar 直接运行未经构建的 TypeScript

**状态：** 已接受 — 实施中（基础设施已落地；逐层迁移进度见下表）**日期：** 2026-09-26 **相关：** [ADR-0090](./0090-unified-agent-execution-and-gateway-compatibility)（sidecar 的运行时契约）、[ADR-0063](./0063-optical-context-compaction)（光学压缩文件）、[ADR-0119](./0119-pi-native-rpc-integration)（SHA 锁定的 Pi 扩展）、[ADR-0059](./0059-cloud-deployment-headless-brain)（brain 目录布局）、[ADR-0196](./0196-a-library-crate-links-tauri-only-when-asked)（本 ADR 所仿照的 Rust 分层门禁）

## 背景

`sidecar/` 是桌面应用、headless 服务端和 CLI 为每个 agent 会话启动的 Node 宿主。到 2026 年 9 月，它有约 5 万行 `.mjs`，没有任何类型：

- `dispatch/` 是一个约 60 个模块的扁平目录，混杂了宿主线协议、两条 agent 通道（Claude Agent SDK 的 `anthropic.mjs` 与 AI SDK 的 `ai-sdk.mjs`）、权限策略、hooks、MCP、上下文压缩，以及一个测试夹具。
- `builtin-tools/` 的工具类别一半在子目录、一半是顶层文件，旁边还有中间件、隔离（confinement）策略和一个独立的 MCP 服务端（`plugin-tools.mjs`），外加一个与就近测试重复的 `__tests__/` 目录。
- 目录之间循环依赖：`dispatch ⇄ builtin-tools`、`dispatch → lsp → builtin-tools → dispatch`，并且 `dispatch` 把一个进程入口文件（`mcp-oauth-helper.mjs`）当作库来导入。
- `ai-sdk.mjs` 是一个 1700 行的闭包；`agent-host.mjs`（1399 行）混合了 stdin 协议、会话注册表、control、smoke 模式和命令路由。
- 同样的逻辑写了多遍：两套权限决策阶梯、五个带定时器的待回复等待器、四份会话级工具初始化、两个手写的 MCP stdio 服务端、七个 JSON 行写入器。
- 没有任何类型检查，ESLint 忽略该目录，根目录与包内的测试脚本列出的目录还不一致：五个 `run-code` 测试文件从未被任何脚本执行。

以前改用 TypeScript 意味着要加构建步骤，现在不需要了：Node ≥ 22.18 原生剥离可擦除的 TypeScript，桌面应用自带 Node 26.3.1（`scripts/build/prepare-plugin-node.mjs`），CI 和 Docker 都跑 Node 26，sidecar 本来就以这种方式加载 `@cognia/redact` 的 `.ts` 源码。

这条路有一个陷阱，是在规划本次迁移时发现的：Tauri 的 `copy_resources` 在暂存 `../sidecar/node_modules/**` 时会解引用符号链接，于是 `link:` 引入的工作区包以真实 `.ts` 文件的形式落在**`node_modules` 之下**，而 Node 拒绝对那里的文件做类型剥离（`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`）。暂存后的 sidecar 在第一次导入时就崩溃；只在仓库根声明的 `unbash` 也没有进入打包产物。

## 决策

### 1. 使用 `.ts`，不经构建直接运行

sidecar 源码使用 `.ts`（而不是 `.mts`）：`sidecar/package.json` 是 `"type": "module"`，对 Node 而言两者等价；而 Next 的 webpack 规则、Jest 的 SWC 转换、lint-staged、router-fusion 扫描器和镜像的路径过滤器只识别 `.ts`，不识别 `.mts`。渲染层和 `packages/provider-core` 会直接导入少数 sidecar 模块，所以这一点很重要。

Node 原样运行这些文件，因此代码只使用可擦除的子集：不用 `enum`、`namespace`、构造函数参数属性；相对导入写明 `.ts`；类型用 `import type`（`verbatimModuleSyntax`）；不使用路径别名。任何 TypeScript 都不得从 `node_modules` 目录之下加载。

### 2. 目录布局

```
sidecar/
  agent-host.mjs claude-host.mjs cognia-tool-bridge.mjs
  mcp-stdio-relay.mjs mcp-oauth-helper.mjs      启动器（路径是契约）
  a2ui-mcp.mjs                                  生成的自包含产物
  codex-app-control/                            自包含 CLI（有自己的启动器）
  pi-extension/                                 SHA 锁定，由 Pi 加载
  test-support/                                 测试夹具与数据，不随应用发布
  src/
    shared/  platform/  policy/  services/  context/  providers/
    tools/   hooks/     mcp/     runtimes/  host/     entry/
```

- **启动器。** 每个进程入口都保留现有路径——Rust（`src-tauri/src/claude/sidecar.rs`）、CLI 角色存根、Docker、`COGNIA_SIDECAR_SCRIPT` 以及用户已保存的 MCP 配置都按路径引用它们——改为几行的 `.mjs` 文件，导入 `src/entry/*` 并保留原有的入口判断（argv 或 `COGNIA_ROLE`），这样 CLI 导入启动器时不会把它启动两次。
- **`a2ui-mcp.mjs`** 由外部 agent 用用户 `PATH` 上的 `node` 启动，那个版本可能早于类型剥离，因此它改为同路径下的自包含 esbuild 产物。
- **分层。** `src/` 有十二层，每层只能导入自身以及门禁配置允许的层：`shared` → `platform` → 并列的 `policy`、`services`、`context`、`providers` 四层 → `tools` → `hooks` → `mcp` → `runtimes` → `host` → `entry`。内置工具类别之间互不导入；两条运行时通道只通过 `runtimes/common` 共享代码。

### 3. 用门禁守住结构

`pnpm audit:sidecar-architecture`（`scripts/gates/check-sidecar-architecture.mjs`，配置 `sidecar-architecture.json`）检查：分层规则；`src/` 不导入尚未迁移的代码（遗留代码可以导入 `src/`，这正是自底向上迁移得以进行的原因）；生产代码不导入启动器、测试或 test-support；相对导入写明扩展名；导入离开 sidecar 目录时只能指向三个 `lib/*.json` 数据文件；自包含目录；同构模块（被渲染层打包的代码不使用 Node 内置模块、第三方包或 `import.meta`）；sidecar 之外的代码只能导入 `public` 列表中的模块；以及不存在目录级导入循环。遗留违规记录在基线中，基线只允许缩减。

### 4. 独立的类型契约

`pnpm sidecar:typecheck`（check-all 的 `types` 组）用仓库根的 TypeScript 检查 `sidecar/tsconfig.json`——`sidecar/node_modules` 会随应用发布，所以不放任何开发依赖：

- `tsconfig.base.json`：`es2025`、无 DOM、`strict`、`erasableSyntaxOnly`、`verbatimModuleSyntax`、`allowImportingTsExtensions`、`noEmit`；使用 `moduleResolution: bundler`，因为被链接的包在自身源码里使用无扩展名导入（sidecar 自己的扩展名由门禁检查）。
- `tsconfig.json` 额外开启 `noUncheckedIndexedAccess` 与 `noUnusedLocals`；文件从迁移的第一个提交起就是严格模式，不先宽松再收紧。
- `tsconfig.pi-extension.json` 在不开 `noUncheckedIndexedAccess` 的情况下检查 SHA 锁定的扩展，直到下一次重新锁定。

`@cognia/agent-config-types` 的汇总入口（`SendOptions`、`ClaudeEvent`）通过 `@/` 别名依赖应用代码，独立程序无法导入。sidecar 自己持有线协议类型（`src/shared/wire/`），并由一个根侧契约测试保证应用的类型可以赋值给它们。该包中闭包干净的叶子模块可以导入。

根 `tsconfig.json` 允许 `.ts` 导入路径（`noEmit`），因此这些 public 模块改成 `.ts` 后应用仍可导入。它们也会被根 `tsc`、Jest 和 webpack 编译，所以必须符合根配置（ES2018 目标），不使用 `import.meta`、顶层 `await` 或 JSON 导入属性。

### 5. 被链接的工作区包以编译产物发布

sidecar 的每个 `link:` 依赖都把 Node 的 `node` 导出条件指向 tsup 构建的 `dist/`；应用、Jest 和 `tsc` 仍解析源码。`scripts/build/build-sidecar-linked-packages.mjs` 只在源码变化时重建这些产物，并在 sidecar 的任何 `@cognia/*` 导入仍会解析到 TypeScript 时报错。它在 postinstall、`predev`、`prebuild` 和 `sidecar:test` 中运行。`sidecar/tsconfig.base.json` 的 `paths` 让打包器（CLI 的 esbuild 与 Bun 构建、Pi 暂存）与根 tsconfig 一样使用源码。

`scripts/build/sidecar-bundle-resources.mjs` 守护 `bundle.resources`，现在是失败即拒绝：跟随 `.ts`，从 TypeScript AST 读取导入，报告无法解析的相对导入、未知文件类型、所属 `package.json` 未声明的裸导入，并检查 Rust 的 `REQUIRED_SIDECAR_ENTRIES` 都被暂存。

### 6. 统一测试运行器

`scripts/test/run-sidecar-tests.mjs` 发现 `sidecar/**/*.test.{mjs,ts}`（排除嵌套包）。`pnpm sidecar:test` 运行单元测试；`pnpm sidecar:test:live` 运行 `*.live.test.*`——它们会针对模拟服务启动真实宿主和 Agent SDK 子进程——在 CI 中是独立步骤。测试就近放置；`builtin-tools/__tests__/` 随其被测对象迁移而解散。

### 7. 自底向上迁移，每批一层

每一批迁移一层的文件：改名为 `.ts`、写严格类型，并在同一变更中完成拆分或去重，同时在同一提交中更新所有引用这些路径的位置（Rust、`tauri.conf.json`、Docker、CLI 解析器与打包器、门禁基线、`lib/` 中的导入方）。任何去重之前先用特征化测试锁定行为，尤其是两套权限阶梯——它们今天的行为有差异，合并后的阶梯必须逐一复现。

| 阶段 | 范围 | 状态 |
| --- | --- | --- |
| −1 | 链接包使用编译产物，声明 `unbash` | 已完成 |
| 0 | tsconfig 与 `sidecar:typecheck`、测试运行器、失败即拒绝的守卫、分层门禁、本 ADR | 已完成 |
| 1 | `shared/`、`test-support/`、同构的 provider 表（试点） | 计划中 |
| 2 | 原地迁移 `codex-app-control` | 计划中 |
| 3 | `platform/`（进程、文件系统、网络、遥测、host-rpc） | 计划中 |
| 4 | `policy/`（统一权限阶梯、隔离、shell 规则） | 计划中 |
| 5 | `context/`、`providers/` | 计划中 |
| 6 | `services/`（LSP、代码图） | 计划中 |
| 7–8 | `tools/` 内核与适配器，然后是每个内置工具类别 | 计划中 |
| 9 | `hooks/`、`mcp/` 库 | 计划中 |
| 10 | `runtimes/`（拆分两条通道） | 计划中 |
| 11 | MCP 进程入口及其启动器 | 计划中 |
| 12 | `host/`、宿主启动器、删除 `dispatch/`、门禁进入最终模式 | 计划中 |

## 影响

- sidecar 第一次有了类型检查，没有构建步骤，任何外壳启动它的方式都不变。
- 冷启动要承担类型剥离的开销（约 25 ms 的剥离器初始化，外加每 1.5 MiB 源码约 40 ms）。预算是 `agent-host.mjs --smoke` 的中位数回退不超过 75 ms 且不超过 12 %；超出时首选在启动器里调用 `module.enableCompileCache()`。
- 从源码目录运行 sidecar 需要被链接包的 `dist/`，由 postinstall 构建，并在 `predev`、`prebuild` 和 `sidecar:test` 中刷新。
- 最大的风险是在其他会话并发编辑的工作树里移动文件；每批都很短，在私有 worktree 中准备，并只提交明确列出的路径。

## 备选方案

- **`.mts`。** 在 `"type": "module"` 下语义相同，但所有读取渲染层可见 sidecar 模块的工具都需要新增规则。
- **用 `tsc` 编译到 `dist/`。** 给每个使用方增加构建步骤，并把所有启动路径改到 `dist/`；在 Node 已能剥离类型的今天，这没有运行时收益。
- **把入口改名为 `.ts` 并更新调用方。** 这些路径存在于用户保存的 MCP 配置和外部 agent 的配置中，不只在本仓库；启动器可以零成本地保持它们稳定。
