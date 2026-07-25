---
name: cognia-e2e
description: >-
  Design, audit, implement, debug, and verify end-to-end coverage in the Cognia repository across browser/static-export,
  mobile/Capacitor, Tauri/WebView2, workflow, connector, agent, sidecar, and service boundaries. Use when deciding whether
  a product or protocol change needs E2E, mapping a change to a critical user journey, auditing coverage or governed debt,
  adding or updating Playwright E2E, choosing deterministic mocks versus native or real integrations, validating static
  export behavior, or investigating a failing Cognia E2E/CI job. Trigger for requests such as “写 E2E / 补测 / 这个功能测到
  了吗 / E2E 缺口 / CUJ / 用户路径 / Playwright / web vs mobile vs Tauri / mock or real / E2E 门禁”, and proactively
  for user-visible cross-layer behavior, persistence, native IPC, connector, workflow, or agent-runtime changes.
---

# Cognia E2E

把 E2E 工作收敛为闭环：**确定行为与归属 → 证明覆盖现状 → 选择最小可靠 harness → 实现 → 用真实命令验证 → 报告风险**。

不要把本 skill 的路径、用例数量或能力列表当成静态真值。始终以当前分支的 `AGENTS.md`、`package.json`、`playwright.config.ts`、`tests/e2e/README.md`、fixtures、spec 和 CI 配置为准。

## 1. 先分类任务

选择用户真正要求的工作，不默认每次做全量盘点：

- **覆盖决策**：判断改动是否需要新增或更新 E2E，并给出源码与断言证据。
- **路径/缺口审计**：列出用户路径、已有断言、缺失断言、governance debt 与阻塞基建。
- **测试实现**：新增或修改目标 spec/helper/config，并按验证阶梯跑绿。
- **失败诊断**：先复现并保留 trace、截图、视频、console、mock/server 日志；不要先放宽断言。

用户要求实现产品功能时，先做覆盖决策；需要 E2E 时把测试纳入同一实现计划。用户只要求审计或诊断时，不自行修改产品或测试。

## 2. 建立当前分支事实

在建议或编辑前：

1. 读根 `AGENTS.md`、`tests/e2e/README.md` 和目标目录最近的说明。
2. 读 `package.json`、`playwright.config.ts`、`.github/workflows/test.yml` 的相关 job。
3. 查看同区域活跃 spec、`tests/e2e/helpers/**`、`tests/e2e/mocks/**`、`test.skip`/`test.fixme`、`scripts/e2e/governance-exceptions.json` 与本次 diff。
4. 用 `git ls-files <path>` 区分受控事实与未跟踪报告、临时产物或旧计划。
5. 历史计划只解释漂移；当前源码、配置和运行结果优先。

禁止引用固定 spec 数、历史覆盖率或旧缺口快照作为当前结论。每次重新发现。

## 3. 确定测试归属

把行为放到拥有该契约的最窄、最可靠层；只有跨层风险才补一条薄的上层 smoke。

| 契约 | 首选位置或项目 | 典型内容 |
|---|---|---|
| Web UI、静态导出、浏览器请求合同 | `tests/e2e/**` + `chromium` | 页面生命周期、Dexie 持久化、插件/技能/目标/连接器 UI |
| Capacitor 形态与移动持久化 | `tests/e2e/mobile/**` + `mobile-pixel-7` / `mobile-iphone-13` | standalone/paired、离线队列、深链、权限、手势、移动导航 |
| Tauri IPC、sidecar、keyring、原生集成 | `tests/e2e/tauri/**` + `tauri` | WebView2 CDP、Rust command、sidecar、订阅、OCR、原生连接器 |
| Workflow 编辑器/执行器/历史 | `tests/e2e/workflows/**` | 节点配置、路由、执行、重放、持久化 |
| 非浏览器协议或服务边界 | 对应 `*.test.*`、Rust integration test 或 `scripts/smoke/**` | CLI、sidecar、signaling、workspace runtime、纯协议边界 |

不要用浏览器 E2E 代替可在 TypeScript/Rust/服务层稳定证明的边界条件；不要把 Tauri 特有合同复制到浏览器 suite；不要让 mobile viewport 测试冒充真实 native IPC。

按任务完整读取对应参考：

- 浏览器与静态导出：[`references/browser-and-static.md`](references/browser-and-static.md)
- 移动端：[`references/mobile.md`](references/mobile.md)
- Tauri 与原生边界：[`references/tauri-and-native.md`](references/tauri-and-native.md)
- Workflows：[`references/workflows.md`](references/workflows.md)
- 用户路径与覆盖审计：[`references/coverage-and-paths.md`](references/coverage-and-paths.md)
- Spec 模式：[`references/spec-patterns.md`](references/spec-patterns.md)

## 4. 判断是否需要 E2E

满足任一项时，通常新增或更新 E2E：

- 改变用户可见的关键路径、跨页面/跨进程/跨服务流程或失败恢复。
- 改变 AccountGate、Dexie 持久化、static export E2E bridge 或启动顺序。
- 改变 browser、Capacitor、Tauri、connector、workflow、agent、sidecar 之间的集成边界。
- 修复曾逃过单测的回归，且 E2E 能稳定复现。
- 改动现有 spec 的行为合同、fixture、selector、mock 协议、项目矩阵或平台门禁。

以下情况可不新增 E2E，但必须写明证据：

- 纯内部重构，用户行为与边界合同不变，且现有断言覆盖受影响路径。
- 类型、文档、测试代码或无新交互/可访问性合同的纯样式调整。
- 更低层测试能更稳定、完整地证明行为，且没有剩余集成风险。

“改了 UI 文件”只是风险信号；“已有同名 spec”也不等于断言覆盖。输出必须是 `需要 E2E`、`更新已有 E2E` 或 `无需新增 E2E`，并附文件、测试名与关键断言证据。

## 5. 定义可验证路径

写代码前记录最小测试合同：

```text
入口/前置状态 → 用户动作或协议请求 → 可观察结果 → 失败诊断信号
```

要求：

- 结果可由 UI、公开协议、持久状态或真实请求记录观察；不要写“功能正常”。
- selector 从当前源码或真实页面核实；优先 role/accessible name，其次稳定 test id，最后最小 CSS。
- 异步完成等待语义状态、请求、持久行、公开事件或项目 helper；不用任意 sleep。
- 真实模型或外部服务只断言稳定合同；随机行为改用确定性 mock/prompt，无法稳定则下沉测试层。
- 多路径盘点使用 [`references/coverage-and-paths.md`](references/coverage-and-paths.md) 的 gap ledger。

## 6. 选择最小可靠 harness

按顺序决策：

1. **复用同区域 spec/helper**：优先组合 `tests/e2e/helpers/**`、全局 mock fleet 与同区 setup，不复制账号引导、DB reset、mobile boot、Tauri launch。
2. **选择运行面**：普通 UI/持久化用 `chromium`；移动形态用 mobile projects；IPC/sidecar/keyring 才用 `tauri`。
3. **选择 mock 或真实边界**：UI 状态、失败注入、payload 记录用确定性 mock；native/IPC/sidecar/部署连通才承担真实集成成本。
4. **区分产品缺陷和 harness 缺口**：缺 route/helper/可观察信号时补最小基建；若超范围，记录为 blocked gap，不提交永久 skip 空壳。
5. **守住 build-time 条件**：static export 的 E2E bridge 必须用 `NEXT_PUBLIC_E2E=1` 构建；运行时补 env 不能修复已被 tree-shake 的 bridge。

## 7. 实现纪律

- 先证明缺口：跑目标用例/最小 repro，或指出现有 arrange/action/assert 缺少什么。
- 从同目录最接近的活 spec 复制结构，不从旧计划凭空拼装。
- 一条测试聚焦一个行为合同；前置状态放 helper，关键动作与断言留在 spec。
- 不臆造 helper、全局 bridge、mock route、环境变量或命令。
- 不用 `waitForTimeout` 掩盖竞态；仅在模拟手势持续时间等真实时间语义时使用，并满足 governance ledger。
- 不通过放宽断言、增加全局 retry 或扩大 timeout 修复确定性失败。
- 不新增无截止日期的 skip/fixme/stub；受治理的例外必须精确、可计数、有原因和 `reviewAfter`。
- 产品行为变化配回归用例；E2E 基建变化配对应脚本/helper/config 单测。
- 修改后运行 `pnpm audit:e2e-governance`；若修改门禁本身，再运行 `pnpm audit:e2e-governance:test`。

## 8. 验证阶梯

记录每条实际命令及 exit status：

1. 发现：`pnpm exec playwright test --list --project=<project> <spec>`。
2. 目标：单文件、单 project、`--workers=1`。
3. 相关目录/project suite。
4. 浏览器或移动改动：`pnpm test:e2e:build` 后用 `PLAYWRIGHT_STATIC=1` 跑目标；旧 `out/` 不算证据。
5. 共享 config/helper/mock：跑治理门禁、相关单测和受影响项目组合。
6. Tauri：只在 Windows 运行真实 WebView2/CDP；其他平台明确记录未验证，不伪造通过。
7. 最后检查 lint/typecheck/build 与 CI 等价 job，范围按改动风险决定。

任何包装器可能改变输出呈现时，以进程 exit status 和 Playwright 最终 summary 为准。遇到凭据、平台或环境阻塞，不声称通过；写明未运行命令、阻塞原因、替代检查、剩余风险和所需环境。

## 9. 交付格式

最终报告包含：

- **覆盖结论**：新增/更新/无需 E2E，以及归属层和理由。
- **行为合同**：入口、动作、可观察结果、诊断信号。
- **改动**：spec、helper、mock、config、governance debt。
- **验证证据**：实际命令、exit status、pass/fail/skip/retry 数；失败时给首个根因。
- **剩余风险**：未覆盖 project/platform、环境阻塞、已知 flaky、待补 harness。

## 红线

- 不把设计稿、未跟踪文件、归档计划或历史统计描述成当前分支事实。
- 不制造无行为断言、永久 skip、重复 happy path 或 stub theatre。
- 不让 browser/mobile mock 用例声称验证了 Tauri IPC、真实 sidecar 或线上服务。
- 不混淆 viewport、Capacitor injection、static export、Tauri shell 与真实设备。
- 不把 flaky 自动归咎于环境；先保留 artifacts 并定位第一处失败。
