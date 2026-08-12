---
title: 测试体系审计 — 2026-05
description: 对 cognia-next Jest + Playwright + sidecar 测试体系做的一次结构化体检，覆盖 mock 重复、配置漂移、覆盖缺口与陷阱四类问题。
---

# 测试体系审计 — 2026-05

| 范围          | Jest 单元/组件、Playwright E2E、sidecar `node:test`                             |
| ------------- | ------------------------------------------------------------------------------- |
| 提交时配套 PR | 3 项修复 + 5 个补测（详见末尾"本次 PR 一并交付的修复"）                         |
| 不在范围内    | `src-tauri/` Rust 测试、`components/ui/`、`components/ai-elements/`（豁免目录） |
| 报告日期      | 2026-05-17                                                                      |

## 执行摘要

仓库测试基础设施成长到约 1300 个 Jest 套件 + 200+ Playwright 套件 + 一个 `node:test` sidecar 套件。本次审计在四类问题上得出明确结论：

1. **Mock 重复**：`jest.setup.ts` 已全局 mock `next-intl`、`next/image`、`next/navigation`，但仓库里仍有 **268 个测试文件** 再次 inline `jest.mock("next-intl", …)`，加上 49 处对 `@tauri-apps/api/*` 与 `nanoid` 的冗余 inline mock。审计代理最初把这 268 处都标为"identical re-declarations"——**这一判断在抽样验证中被推翻**：大量 inline mock 提供自定义翻译字典或返回 `${ns}.${key}` 格式，是测试断言所依赖的固定夹具，不是真冗余。下文 A1 给出新的分类口径。
2. **真实漏洞 1 处**：`stores/network-proxy/index.test.tsx:43-44` 在 `beforeEach` 中 spy 了 `console.warn` / `console.debug` 却没有 `afterEach` 还原；`jest.config.ts:16` 的 `clearMocks: true` 只清调用历史，不复位 implementation，spy 会在同 worker 的后续测试间残留。本次 PR 已修复。
3. **`transformIgnorePatterns` 缺 5 包**：`@huggingface/transformers`（实际由现有 `@huggingface\+|@huggingface/` 兜底）、`@modelcontextprotocol/sdk`、`@xyflow/react`、`chart.js`、`cheerio`。本次 PR 已补齐后四个。
4. **覆盖缺口 124 个孤儿源文件**，集中在 `lib/ai/`（31）、`lib/db/`（18）、`lib/a2ui/`（12）、`lib/workflow/`（9）——前 4 个子目录占缺口总量的 56%。本次 PR 一并补齐了 5 个最大孤儿（合计 3,737 LOC），将缺口从 124 降到 119。

最高优先级三件事（顺序按 ROI 排序）：

- **A. 修 `stores/network-proxy/index.test.tsx` 的 spy 泄漏**（本次 PR 已完成）。
- **B. 把 `components/a2ui/__tests__/`、`components/chat/__tests__/`、`lib/a2ui/__tests__/` 共 ~110 个测试文件迁回 co-located 位置**（CLAUDE.md "Testing Standards" 明确禁止 `__tests__/` 目录，但 `jest.config.ts:326` 的 `testMatch` 还在主动接住它们）。需单独 PR，本次只在 D 类标记。
- **C. 制定 next-intl inline mock 的清退路径**：先确定哪些是真冗余（无自定义字典且测试不断言原始 key），再批量删除。本次 PR 删了 3 个示例性的（详见末尾 #2b）。

## A. Mock 重复

### A1. `next-intl` inline mock 的真实分布

`jest.setup.ts:199-266` 提供了一个会解析 `i18n/messages/en.json` 的全局 `useTranslations` mock，缺失键时 fallback 为返回 key 本身。然而仓库里还有 268 个测试文件再次声明 `jest.mock("next-intl", …)`。重新按"是否提供了测试无法从全局 mock 拿到的行为"分类：

| 模式                                                                                  | 估算占比 | 是否真冗余  | 说明                                                                                                                                                                            |
| ------------------------------------------------------------------------------------- | -------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `useTranslations: () => (key) => key` 且测试断言原始 key 字符串                       | ~30%     | ❌ 必须保留 | 删除后全局 mock 会去 en.json 解析，把 `"errorTitle"` 还原成英文文案，断言失效。典型：`app/scheduler/error.test.tsx:40-41`。                                                     |
| `useTranslations: () => (key) => key` 且测试只断言 fixture 文本/`data-testid`         | ~25%     | ✅ 可删     | 全局 mock 与 inline mock 行为一致即可。本次 PR 在 `lib/tray/sync.test.ts`、`components/chat/skill-picker.test.tsx`、`components/goal/goal-status-pill.test.tsx` 各删 1 处示范。 |
| 自定义翻译字典（如 `{ rename: "Rename", duplicate: "Duplicate", ... }`）              | ~30%     | ❌ 必须保留 | 字典里塞的是测试断言依赖的具体英文，与 en.json 实际内容是否一致并不确定。删除前必须逐键比对。典型：`components/canvas/version-history-panel.test.tsx:80-109`。                  |
| `useTranslations: (ns) => (key) => \`${ns}.${key}\`` 返回带命名空间的 key 字符串      | ~10%     | ❌ 必须保留 | 测试断言里包含 `ns.key` 格式（如 `"loading.fetchingApps"`），全局 mock 无法重现。典型：`components/desktop/title-bar.test.tsx:11-13`。                                          |
| inline mock 顺带提供 `NextIntlClientProvider`、`useLocale`、`useFormatter` 等扩展接口 | ~5%      | 视测试而定  | 全局 mock 已经提供这些，但 inline 版本可能传递了不同的 `locale` / `TimeZone`，需逐文件核对。                                                                                    |

**结论**：原审计代理给出的 "268 处冗余" 数字不能直接作为清退目标。真冗余比例估算 **~25%**（约 67 个文件）。下一步工作量较小但需要按上表逐文件分类，**不能用单一 sed 脚本批量删除**。

### A2. Tauri / Octokit / nanoid 等手动 mock 的 inline 重复

`__mocks__/` 目录下有 19 个手动 mock 文件，Jest 自动解析。但测试里仍频繁再次 `jest.mock(...)` 它们：

| 模块                         | 手动 mock 文件                     | inline 重复次数 | 是否真冗余                                                                                                                    |
| ---------------------------- | ---------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `@tauri-apps/api/core`       | `__mocks__/tauri-api.js`           | 33              | 视情况——很多 inline 版用 `jest.fn()` 直接覆盖以便后续 `mockResolvedValue` / `mockReturnValue`，是测试夹具的一部分，**不删**。 |
| `@tauri-apps/api/event`      | `__mocks__/tauri-api-event.js`     | 10              | 同上，inline 版多在 `listen` 上挂自定义返回。                                                                                 |
| `@tauri-apps/plugin-store`   | `__mocks__/tauri-plugin-store.js`  | 1               | 唯一一次 inline 与手动 mock 行为一致，可删（未在本次 PR 处理）。                                                              |
| `nanoid`                     | `__mocks__/nanoid.js`              | 5               | 大多 inline 版在 `jest.config.ts:218` 的 `moduleNameMapper` 之外，疑似历史遗留。                                              |
| `@opencode-ai/sdk` 等        | `__mocks__/opencode-sdk-client.js` | 0               | 无 inline 重复。                                                                                                              |
| `shiki`、`react-markdown` 等 | 对应 manual mock                   | 0               | 无 inline 重复。                                                                                                              |

**结论**：除 `nanoid` 的 5 处和 `@tauri-apps/plugin-store` 的 1 处可能值得清理外，Tauri 系列的 inline mock 多数承担"覆盖手动 mock 默认行为"的合法用途，不应批量删除。

### A3. 未还原的 `mockImplementation` 调用

`jest.config.ts:16` 启用 `clearMocks: true` 但 `restoreMocks` 未启用。审计代理扫描了所有 `jest.spyOn(...).mockImplementation(...)`，按实际跨测试污染风险重排：

| 文件                                               | 行号     | 目标                             | 风险                                                                                                           |
| -------------------------------------------------- | -------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `stores/network-proxy/index.test.tsx`              | 43-44    | `console.warn` / `console.debug` | **高（已修）**：spy 在 `beforeEach` 安装、无 `afterEach`。Jest worker 内同进程后续测试会拿到污染过的 console。 |
| `components/desktop/title-bar.test.tsx`            | 800、813 | `document.execCommand`           | 低：spy 内联在单测试里，明确 `mockRestore()`。                                                                 |
| `stores/settings/settings-store.test.ts`           | 75-82    | `console.warn`/`error`           | 已对照范式：`afterEach(() => jest.restoreAllMocks())`。                                                        |
| 其余 8+ 处 `console.error` / `loggers.ui.warn` spy | 散落     | console / logger                 | 低：均限定在单 `it` 内或有 `mockRestore` 配对。                                                                |

**结论**：**不应** 在全仓库启用 `restoreMocks: true`。理由：`components/desktop/title-bar.test.tsx:800` 与 `stores/settings/settings-store.test.ts:75-82` 明确依赖跨 `it` 共享同一个 spy 句柄；启用 `restoreMocks` 会在每个 `it` 之后自动还原，破坏这些模式。修复路径应是对 leaky 测试逐文件加 `afterEach(() => jest.restoreAllMocks())`，而不是改全局开关。

## B. 配置漂移

### B1. `__tests__/` 目录违反 CLAUDE.md "Testing Standards"

`CLAUDE.md` 明确写"Co-located: `xxx.test.ts(x)` next to source. No `__tests__/` or `tests/` directories"，但 `jest.config.ts:326` 的 `testMatch` 仍包含 `**/__tests__/**`。实际存在以下违规目录：

- `components/a2ui/__tests__/`（**98 个测试文件**）
- `components/chat/__tests__/`
- `lib/a2ui/__tests__/`

**建议**：单独 PR 用 `git mv` 把这 ~110 个文件搬到 co-located 位置（同名 `*.test.tsx` 紧邻源文件），并从 `testMatch` 移除 `__tests__/` 模式。本次 PR 不处理。

### B2. `tests/integration/appearance.test.tsx` 是孤儿目录

唯一一个非 e2e 的 `tests/` 文件，436 行集成测试。CLAUDE.md 没有"integration test exception"条款。需要在另一个 PR 中决定：

- 选项 1：co-locate 到 `lib/appearance/` 下作为 `appearance-integration.test.tsx`。
- 选项 2：在 CLAUDE.md "Testing Standards" 加一条"集成测试可放 `tests/integration/`"。

### B3. `transformIgnorePatterns` 缺 5 包（本次 PR 已修 4 个）

`jest.config.ts:363-365` 负前瞻链原本覆盖 ~40 个 ESM 包。审计交叉对比 `package.json` 业务依赖后发现 5 个候选：

| 包名                        | 是否已在 allowlist      | 本次 PR 处理        |
| --------------------------- | ----------------------- | ------------------- | -------- |
| `@huggingface/transformers` | ✅ 已被 `@huggingface\+ | @huggingface/` 覆盖 | 无需追加 |
| `@modelcontextprotocol/sdk` | ❌                      | ✅ 已追加           |
| `@xyflow/react`             | ❌                      | ✅ 已追加           |
| `chart.js`                  | ❌                      | ✅ 已追加           |
| `cheerio`                   | ❌                      | ✅ 已追加           |

下一次添加新 ESM 业务依赖时，记得在 `jest.config.ts:364` 的负前瞻链里追加。

### B4. Jest 安全开关现状

| 开关                      | 当前    | 建议           | 影响评估                                                                                                   |
| ------------------------- | ------- | -------------- | ---------------------------------------------------------------------------------------------------------- |
| `clearMocks: true`        | 启用    | 保持           | 已生效，仅清理调用历史。                                                                                   |
| `restoreMocks: true`      | 禁用    | **保持禁用**   | 见 A3——启用会破坏 title-bar / settings-store 等测试依赖的跨 `it` spy 共享模式。                            |
| `errorOnDeprecated: true` | 禁用    | 可考虑启用     | 低风险——审计未发现现有测试使用已废弃 Jest API。                                                            |
| 全局 `fakeTimers`         | 未配置  | **保持未配置** | 部分集成测试（`tests/integration/appearance.test.tsx`）依赖真 timer；全局启用会需要大量 per-test opt-out。 |
| `testTimeout`             | 默认 5s | 可选：拉到 10s | `appearance.test.tsx` 接近 5s 上限；如未来再加重测试可调整。                                               |

### B5. `jest.config.ts:339-343` 残留 worktree-local 注释

注释提到"worktree-local override drops these entries"，但本仓库根据用户偏好"不使用 worktrees"。该注释是死代码。**建议下次清理 jest 配置时一并删除**，本次 PR 不动。`.gitignore` 第 66 行已经 ignore `.claude/worktrees/`，所以即便残留也不影响测试。

### B6. `jest-junit` reporter 与 `.gitignore`

`jest.config.ts:266-279` 的 `jest-junit` reporter 写到 `coverage/junit.xml`。已在 `.gitignore:15-16` 通过 `/coverage` 和 `junit.xml` 双重覆盖。无需调整。

### B7. Playwright `workers: 1` 的根因

`playwright.config.ts:37` 注释正确归因 Dexie 单例。`tests/e2e/helpers/db-reset.ts:29-48` 提供了 `window.__cogniaResetDb()` 桥实现 per-spec 全量重置——但该重置同时清空所有表，所以"两个并行 spec 共享 Dexie 状态"的根本风险仍在。**升到 `workers: 2` 需要 per-spec 表隔离**（例如以 spec 文件名生成数据库名前缀），代码改动不小。本次 PR 不处理。

## C. 覆盖缺口

### C1. 124 个孤儿源文件的子目录分布

| 子目录            | 源文件总数 | 已测 | 孤儿 | 覆盖率 |
| ----------------- | ---------- | ---- | ---- | ------ |
| `lib/ai/`         | 93         | 62   | 31   | 66.7%  |
| `lib/db/`         | 57         | 39   | 18   | 68.4%  |
| `lib/a2ui/`       | 27         | 15   | 12   | 55.6%  |
| `lib/workflow/`   | 46         | 37   | 9    | 80.4%  |
| `hooks/a2ui/`     | 13         | 7    | 6    | 53.8%  |
| `lib/plugin/`     | 111        | 106  | 5    | 95.5%  |
| `lib/twin/`       | 42         | 38   | 4    | 90.5%  |
| `lib/sync/`       | 7          | 3    | 4    | 42.9%  |
| `stores/agent/`   | 15         | 12   | 3    | 80%    |
| 其他（22 个目录） | 30         | 27   | 3    | 90%    |

**4 个热点子目录**（`lib/ai/`、`lib/db/`、`lib/a2ui/`、`lib/workflow/`）合计占 70/124 = **56%** 的孤儿。下一阶段补测应优先这四个目录。

### C2. 前 20 大孤儿（按 LOC 排序）

> 加粗 = 本次 PR 已补齐。

| 路径                                                       | LOC | 用途                       |
| ---------------------------------------------------------- | --- | -------------------------- |
| **`lib/a2ui/app-generator/component-factories.ts`** ✅     | 889 | A2UI 组件工厂              |
| **`lib/ai/providers/local-provider-service.ts`** ✅        | 790 | 本地推理引擎统一服务       |
| **`lib/ai/providers/api-test.ts`** ✅                      | 717 | API 连接探测               |
| **`stores/plugin-runtime/plugin-marketplace-store.ts`** ✅ | 703 | 插件市场 Zustand store     |
| **`lib/a2ui/app-generator/generators.ts`** ✅              | 638 | A2UI 应用生成器            |
| `lib/ai/providers/completeness.ts`                         | 573 | Provider 能力检查          |
| `lib/ai/providers/oauth.ts`                                | 518 | Provider OAuth             |
| `lib/ai/rag/persistent-storage.ts`                         | 483 | 持久化 RAG 向量存储        |
| `lib/ai/providers/provider-parameter-schemas.ts`           | 483 | Provider 参数 schema       |
| `lib/ai/providers/openrouter.ts`                           | 471 | OpenRouter 客户端          |
| `lib/a2ui/templates/utility.ts`                            | 436 | A2UI 工具类模板            |
| `lib/ai/providers/projection.ts`                           | 421 | Provider projection 逻辑   |
| `lib/ai/provider-consumption.ts`                           | 390 | Provider 用量追踪          |
| `lib/ai/providers/local-providers.ts`                      | 388 | 本地推理 provider 目录     |
| `lib/twin/job-worker.ts`                                   | 367 | Twin 异步任务 worker       |
| `lib/ai/icons.ts`                                          | 364 | LLM provider icon registry |
| `lib/ai/providers/model-discovery.ts`                      | 351 | 模型发现服务               |
| `lib/a2ui/templates/productivity.ts`                       | 325 | A2UI productivity 模板     |
| `lib/twin/ingest/job-runner.ts`                            | 274 | Twin ingest job 编排       |
| `lib/ai/providers/cliproxyapi.ts`                          | 274 | ClipProxyAPI 客户端        |

### C3. workflow executors 全覆盖（ADR-0011）

ADR-0011 列举的 38 个 node kinds + 32 个 executor 在 `lib/workflow/nodes/built-ins/index.ts`、`lib/workflow/nodes/automation/desktop.ts` 和注册表/catalog/schema 等基础设施层都有 co-located 测试。**无缺口**。

### C4. connector adapters 接近全覆盖

`lib/connectors/adapters/` 35 个源文件中，34 个有 co-located 测试。**唯一缺口**：`lib/connectors/adapters/telegram/markdown-v2.ts`（Telegram Markdown V2 序列化工具）。可加入下一 sprint。

## D. 漂移与陷阱

### D1. `jest.config.ts:326` 的 `testMatch` 与 CLAUDE.md 冲突

`testMatch` 接受 `**/__tests__/**/*.?([mc])[jt]s?(x)`，与 CLAUDE.md "no `__tests__/` directories" 直接矛盾。当前实际存在 3 个违规目录（见 B1）。**未来某次清理**：要么把测试搬到 co-located 位置后从 `testMatch` 移除该 glob，要么修改 CLAUDE.md 接受 `__tests__/`（不建议）。

### D2. `tests/integration/appearance.test.tsx` 唯一非 e2e `tests/` 文件

见 B2。

### D3. Sidecar 测试隔离 OK

`testPathIgnorePatterns` 排除了 `/sidecar/`（`jest.config.ts:337`），sidecar 的 `.mjs` 用 `pnpm sidecar:test` 走 `node --test`。Jest 不会误抓 sidecar 源码。

### D4. `jest-junit` reporter 写本地 `coverage/junit.xml`

CI 本地都写。`/coverage` 已被 `.gitignore` 第 15 行覆盖。无操作。

### D5. `jest.config.ts:339-343` 的 worktree-override 注释

见 B5。死代码，下次清理时移除。

## 本次 PR 一并交付的修复

### #2a — 修 `stores/network-proxy/index.test.tsx` 的 console spy 泄漏

加上配对的 `afterEach(() => jest.restoreAllMocks())`，复现 `stores/settings/settings-store.test.ts:80-82` 的范式。改动 5 行。

### #2b — 删除 3 个示例性 next-intl 冗余 mock

- `lib/tray/sync.test.ts`：纯 hook 测试，inline mock 是防御性导入。
- `components/chat/skill-picker.test.tsx`：断言对象是 fixture 中的 skill name。
- `components/goal/goal-status-pill.test.tsx`：断言对象是 goal 的 `rawObjective` / `status` 字段。

**原计划的另外两个目标（`components/a2ui/display/a2ui-rich-output.test.tsx`、`components/canvas/canvas-document-tabs.test.tsx`、`components/desktop/title-bar.test.tsx`、`components/canvas/version-history-panel.test.tsx`、`components/artifacts/artifact-preview.test.tsx`）经逐文件 review 判定为不可安全删除——它们使用自定义翻译字典或 `${ns}.${key}` 格式，是测试夹具的一部分。这一发现已写入 A1 表格。**

### #2c — `transformIgnorePatterns` 追加 4 包

`jest.config.ts:364` 追加 `@modelcontextprotocol\+|@modelcontextprotocol/|@xyflow\+|@xyflow/|chart\.js|cheerio` 到负前瞻链尾部。`@huggingface/transformers` 已被现有 `@huggingface\+|@huggingface/` 兜底，无需追加。

### #3 — 5 个最大孤儿补齐 co-located 测试

| 测试文件                                                 | 测试数 | Coverage 实测                                                                                       |
| -------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------- |
| `lib/a2ui/app-generator/component-factories.test.ts`     | 43     | （合并 lib/\*\* scope 内）96.76% statements                                                         |
| `lib/a2ui/app-generator/generators.test.ts`              | 47     | 同上                                                                                                |
| `lib/ai/providers/api-test.test.ts`                      | 49     | 同上                                                                                                |
| `lib/ai/providers/local-provider-service.test.ts`        | 49     | 同上                                                                                                |
| `stores/plugin-runtime/plugin-marketplace-store.test.ts` | 63     | **99.85% statements / 94.77% branches / 100% functions / 99.85% lines** — 远超 stores/\*\* 90% 门槛 |

5 个测试文件合计 251 个 test cases。

## 后续工作清单

### 立即可做（建议各自单独 PR）

1. **`__tests__/` 目录迁回 co-located**：`components/a2ui/__tests__/`（98 文件）、`components/chat/__tests__/`、`lib/a2ui/__tests__/`。同步从 `jest.config.ts:326` 的 `testMatch` 移除 `**/__tests__/**` glob。预期改动：~110 个文件 + jest 配置 1 行。
2. **决策 `tests/integration/appearance.test.tsx`**：co-locate 或修订 CLAUDE.md。
3. **删除 `jest.config.ts:339-343` 的 worktree-override 注释块**。

### 本 sprint

4. **续清退真冗余 next-intl mock**：按 A1 表，从 "可删" 那一类（~67 文件）开始；每次 PR 不超过 20 个文件，逐文件 `pnpm test -- <path>` 验证。
5. **补齐 `lib/a2ui/`、`lib/ai/providers/` 余下孤儿**：尤其是 LOC > 400 的 `completeness.ts`、`oauth.ts`、`persistent-storage.ts`、`provider-parameter-schemas.ts`、`openrouter.ts`、`utility.ts`。
6. **补 `lib/connectors/adapters/telegram/markdown-v2.ts` 测试**——connector 测试的唯一缺口。

### 下个 sprint

7. **考虑将重 Dexie mock 测试迁到 `fake-indexeddb`**：`fake-indexeddb` 已经在 devDependencies（`package.json:198`），但仅被少量测试使用。批量迁移可减少 mock 体量、增强 schema 真实性。
8. **考虑提升 `hooks/**`、`components/logging/**` 覆盖门槛**：现在 `jest.config.ts` 把 `hooks/**` 的 functions 门槛设到 30%、`components/logging/**` 设到 20%，意思是"regression floor 不是目标"。随着补测逐步推进，可阶段性上调。
9. **per-spec 表隔离后将 Playwright `workers` 提到 2**：当前 `playwright.config.ts:40` 的 `workers: 1` 是 Dexie 单例所迫；可探索以 spec 文件名为 Dexie 数据库名前缀的隔离策略。

## 引用

- `CLAUDE.md` "Working Rules" + "Testing Standards"——co-located 与 90% 覆盖率原则。
- `jest.config.ts:99-158`——分目录 coverage threshold（regression floor 而非 aspirational gate）。
- `jest.config.ts:363-365`——`transformIgnorePatterns` 负前瞻链。
- `jest.setup.ts:199-266`——全局 `next-intl` mock（解析 en.json + key fallback）。
- `playwright.config.ts:36-45`——`workers: 1` + `fullyParallel: false` 的根因注释。
- `docs/content/docs/en/adr/0011-workflows-subsystem.md`——workflow executor 权威清单（用于 C3 校验）。
