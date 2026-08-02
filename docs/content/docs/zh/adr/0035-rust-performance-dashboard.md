---
title: "0035 — Rust 性能仪表盘"
description: "一个Task-Manager-style/性能面板，背后有一个Rust性能子系统——live process-tree + Tokio 运行时采样以及一个可选加入的跨区热点注册表——用于查找后端性能热点。"
---

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
