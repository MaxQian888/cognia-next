---
title: "0035 — Rust 性能仪表盘"
description: "一个Task-Manager-style/性能面板，背后有一个Rust性能子系统——live process-tree + Tokio 运行时采样以及一个可选加入的跨区热点注册表——用于查找后端性能热点。"
---

## 状态

已接受（2026-05-26）。2026-08-13 的实现已由下述 capability 驱动的 lease 与 Capture 模型取代；原有本地命令只保留一个版本作为兼容适配器。

## 背景

该应用已经具备丰富的可观察性，涵盖*相关*关注点——统一日志（`lib/logging/`+`src-tauri/src/logging/`）、坠机报告（`src-tauri/src/crash/`）、连接器心跳、Anthropic使用追踪、**前端**性能计时（`lib/perf/`——W3C标记、PerfHud、React.Profiler），以及`dial9-tokio-telemetry`飞行记录器将二进制异步追踪写入`<data_dir>/cognia/traces/`。

缺少的是*实时、Rust-运行时*视图：Rust进程树目前使用的CPU/memory量、Tokio 运行时负载如何，以及哪些后端操作较慢。这ADR增加了这种视角。

## 决策

新增Rust子系统`src-tauri/src/perf/`，并设有专用Task-Manager-style `/performance`线路（公会-铁路条入）。

### 三层数据

1. **进程树**（`perf/process.rs`）——`sysinfo`（已存在的`0.33`函数，`system`特征）采样当前PID及每个后代（parent-PID行走），分类为`main` / `sidecar`（节点`claude-host.mjs`）/ `child`。CPU既有原始报告，也有0–100标准的归一化;盘I/O是从采样区间推导出来的bytes/sec。重复使用`crash::system_info::gather()`主机快照。
2. **异步运行时**（`perf/runtime.rs`）——Tokio `RuntimeMetrics` `Handle::current().metrics()`（全套接口可用，因为`.cargo/config.toml`为Dial9设置了`--cfg tokio_unstable`）。总干线为**Worker忙碌%**，通过将单调每节Worker繁忙时长与前一个样本微分计算得出。
3. **Span热点**（`perf/registry.rs` + `perf/span.rs`）——一个选择加入的流程全局指标注册库。每个带仪器的带显示的区间名称会累计计数/错误/总/最小/最大值，并加上一个固定的**log-bucket直方图**，用于近似p50/p95（无依赖、固定大小——由小型策划命名集限制的内存）。乐器编制为`crate::perf::guard("name")`（RAII，唱片发布）/ `timed(name, fut)` / `record(name, elapsed, ok)`，种子设在策划边界（`claude.send`、`ocr.extract`、`vector.query`、`connector.ws_send`等），因为Tauri没有通用的命令中间件。

### 采样器与 传输

`perf/sampler.rs`将三层合成一个`PerfSample`，并以`perf://sample`~1 Hz频率发射。循环是**ref计数**的：面板安装时由`perf_start_sampling`启动，卸载时由`perf_stop_sampling`停止——这样面板关闭时不会有采样开销（Windows任务管理器使用的相同型号）。一个有界环（`RING_CAP = 120`）填充了刚打开面板的滚动图形。命令：`perf_snapshot`、`perf_start_sampling`、`perf_set_interval`、`perf_stop_sampling`、`perf_hotspots`、`perf_reset_hotspots`、`perf_system_details`、`perf_list_traces`、`perf_open_trace_dir`。

### 前端

- 数据层：`lib/perf/backend/{types,commands,format}.ts`;实时hook `hooks/perf/use-perf-stream.ts`（开始→回填→订阅→滚动窗口;暂停时UI冻结而不停止后端）。
- UI：`components/performance/` — `performance-dashboard.tsx`（四个标签页：概览图表·工艺 ·热点 ·异步运行时）、`perf-graph-card`、`perf-metric-tile`、`perf-overview-tab`、`perf-process-table`、`perf-hotspots-table`、`perf-runtime-tab`、`perf-toolbar`。重新绘制+`useThemeColors`，匹配`components/logging/log-stats-dashboard.tsx`。
- `app/performance/page.tsx`号线;行会铁路辅助参赛;i18N `performance.*` （EN + zh-CN）。仅桌面：web/mobile渲染一个无效的解释器。

### 明确已拒绝

- **正在进行CPU采样分析器/火焰图。** 在Windows上，基于信号的采样器（`pprof-rs`）不可用，存在safety/overhead风险。相反，该小组接口现有的 dial9 飞行记录器追踪文件（开放文件夹功能）进行离线分析，并依赖 span 热点表进行实时归因。

## 后果

- 新的逐操作可视化使得后端热点无需外部分析器即可被发现;跨度层是选择加入的，因此随着更多边界的安装，覆盖范围会逐步增长。
- 注册表和process/runtime采样器是运行时中立的，因此`cognia-server`（无头）可以之后无需重做地公开它们;只有`app.emit`采样器是通过桌面应用门关的。
- 全频录音包括两个`Instant::now()`呼叫加上一个微小的互斥体段——仅用于粗边界，绝不用于内环。

## 2026-08-13 capability 与证据升级

`/performance` 不再是仅桌面可用的采样器视图，而是区分两类来源的诊断工作区：本地 Renderer document 与选中的 execution host。每个来源都发布带版本的 descriptor、capability、build/profile 标记、独立时钟原点和明确连接状态。因此 Web 与移动端离线时仍可使用 Renderer 指标和加密 Capture；Rust/Tauri 与 Node/headless 的 host 区域仅在选中主机声明支持时出现。不支持的指标保持缺失，不会写成零。

采样所有权由 `PerfLease` 表达。可见 live consumer 或显式 Capture 才会打开并续租；正常隐藏或卸载立即关闭。只有远端设备异常断开时，需求才可保留固定 15 秒 TTL。主机接纳的最小 cadence 为 500 ms，每个设备最多一个 live 和一个 capture lease，每台主机最多 16 个；物理采样器按已接纳的最快 cadence 运行，再按 lease 分别降采样。Frame 携带不可变的 target/routing、source/session/sequence、请求与实际间隔、单调时间、missed ticks 及 reset/discontinuity 标志。事件订阅先于 open/snapshot；旧 routing generation 的迟到 frame 会被拒绝，sequence 丢失会形成持久化 gap。

Capture 是 target database 中的证据，并由账户级配额协调。目标 schema v160 保存结构行、AES-GCM chunk、附件与 gap；账户注册库 v2 保存保守配额 reservation 与加密且不可变的命名预算档案。性能域密钥与 evaluation artifact 分离；AAD 绑定账户、目标数据库、Capture、ordinal 和 content type，并在 WebCrypto 之后及目标 transaction 内再次检查账户安全 generation。明文只含结构 ID、状态、时间、大小、capability bits 和摘要；source/build/environment、数值数据、名称与预算快照均保持加密。

`.cognia-perf` v1 是唯一全保真可移植格式。导入会在写入前校验路径、重复项、entry 数量、MIME、大小、hash、schema 与 P-256 签名，并通过第二遍不可见的 `importing` transaction 最终变为 `ready`。默认导出复用 crash redaction 并增加性能字段伪名化，同时排除 trace bytes。原始导出要求账户已解锁，并进行绑定 Capture 摘要和明确附件选择的二次确认。导入证据获得新的本地 ID，同时保留不可变的原始摘要、scope 和 trust provenance。

信息架构调整为 Overview、Diagnose、Resources 与 Captures；既有 process、managed、hotspot、runtime、system 和 `perf.panel` plugin surface 全部保留并归入其中。显式 Capture 可跨导航继续，并可从桌面状态栏或移动端安全区壳层控制。比较对每个有效 interval 只取一个值，并始终展示 median、type-7 p95、MAD、绝对差和百分比差。预算 verdict 还要求至少 10 个有效 interval、90% 覆盖率、definition/unit/source/schema/cadence 匹配、连续 incarnation、选中的不可变预算以及默认一致的环境；环境不一致只能通过明确记录的接受动作覆盖。

正常 production build 保留轻量 Renderer instrumentation，但不启用 React profiling。`pnpm build:profile` 运行 `next build --profile`，将带标记的静态产物移动到 `out-profile/`；Tauri 始终只消费 `out/`，并在打包 preflight 中拒绝 profiling 标记。
