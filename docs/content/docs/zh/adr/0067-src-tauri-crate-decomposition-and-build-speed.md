---
title: "ADR-0067 — src-tauri crate 拆分与构建提速计划"
description: "Tauri后端是单crate（`app_lib`）中有17万LOC Rust，所以每次编辑都会重新编译并重新链接整个树。本ADR记录了研究结论——分解非常可行，因为每个重依赖都有一个拥有者模块，命令函数已隔离在薄适配器中，跨模块耦合较浅——并提出了分层工作区（`cognia-core` / `cognia-telemetry` / 每子系统库 crate / 瘦应用壳）、一组排名零重构的编译速度优势（LLD 链接器、sccache、开发配置文件 debuginfo， AV排除、功能门槛），以及低风险的分阶段迁移，快速着陆优先，并提取一个叶子crate作为可重用模板。"
---

# ADR-0067 — src-tauri crate 拆分与构建提速计划

**状态**：已接受（2026-07-13）——**W1已获批**（2026-07-30）;**A级登陆**（7 crate）;**B级+后续订单已落地**（2026-07-13，crate又13个）;应用壳（C层）保持**作者**：Max Qian + Claude Opus 4.8 **基于**构建**：现有的工作区拆分模式（`crates/cognia-cli`、`crates/cognia-sandbox-runner`——后者明确提取“只编译少数`cargo check -p cognia-sandbox-runner` crate而非整个Tauri树”），根`Cargo.toml`覆盖release/test配置文件，以及后端已有的每个模块`commands.rs`“薄薄Tauri适配器”惯例。

## 背景

Tauri后端已经发展成一个整体的库crate。这是开发速度和CI成本的主要拖累，数据明确无误：

| 度规 | 价值 | 后果 |
| --- | --- | --- |
| Rust来源 | **170,517 LOC**，全部在一个crate（`app_lib`） | 编辑任何一个文件都会重新编译**并重新链接**整个crate |
| 顶层模块 | 42个目录 + 23个散`src/`文件 | crate内“伪叠加”编译器无法并行化 |
| `Cargo.lock`套餐 | **1,331** | 干净的重量 |
| 重复版本crate | **130**（`glam×18`，`windows×6`，`nix×5`，`hashbrown×5`，......） | 同样的crate被编译了N次——纯粹浪费 |
| 最大模组 | `companion_api` — **28,162 LOC / 56 个文件**，依赖于 13 个兄弟模块 | 神的安排者 |
| 链接器 / 构建缓存 | **无** — `.cargo/config.toml` 只是 `tokio_unstable` | 没有配置`lld`/`mold`/`sccache` |

树中已经出现了两种二级症状：

- **test 配置文件**被迫`debug = "line-tables-only"`，因为对庞大单一测试二进制的完整调试信息构建会导致“LLVM在Windows（`rustc-LLVM ERROR: out of memory`）内存不足”（见根文`Cargo.toml`中的评论）。这是一个整体症状——每crate减少编码单元，它就会消失。
- 团队**在快速检查环重要时（`cognia-sandbox-runner`）已经会采取孤立的crate**，证明该模式被理解并欢迎;只是它没有应用到主树上。

### 为什么单体碑可以安全拆除

有三个结构性事实（测量而非假设）使分解风险异常低：

**1.每个“编译怪兽”都有一个拥有者模块。** 提取一个模块可以隔离一个重依赖：

| 严重依赖 | 唯一所有者模块 | 注释 |
| --- | --- | --- |
| `wasmtime`（起重机——树上最重的） | `plugin_api` |  |
| `webrtc`（~50传递deps，拉`glam×18`） | `companion_api` |  |
| `matrix-sdk-crypto` + `matrix-sdk-sqlite` + `ruma` | `connectors` | E2EE堆栈 |
| `qdrant-client` | `vector` |  |
| `git2`（`vendored-libgit2` → **C 编译**） | `git` （+ `twin`） |  |
| `portable-pty` | `terminal` |  |
| `uiautomation` + `enigo` （windows-rs UIA） | `automation` |  |
| `oar-ocr`/`ort`/`ocrs`/`rten`，`bollard`，`liteparse`（PDFium） | `ocr` / `external_agent` / `parse` | **已经`optional`+功能限制** ✅ |

**2.命令 接口已经是一个薄适配器。** `#[tauri::command]`功能集中在每个子系统中的单个文件中（`git` = 61个cmds在一个文件中，`vector` = 33/1，`external_agent` = 22/1，`browser` = 21/1，`scheduler` = 18/1）。因此每个模块都是*纯逻辑（多文件）+ 一个`commands.rs`（薄Tauri壳）*——正是提取所需的形状crate。Tauri支持`#[tauri::command]`在任意crate中定义，并在`generate_handler!`中通过路径引用，因此命令壳可以随逻辑移动或留在应用端。

**3.跨模块耦合较浅。** 大多数模块为叶子模块（`agents`、`github`、`twin`、`skills`、`pet_window`、`remote_control`、`wallpaper`、`capture`——兄弟 deps 为零）或仅依赖一个小型遥测集群（`perf`/`crash`/`logging`）。唯一真正的枢纽是`companion_api`（13个兄弟节点），它是应用层的编排器，设计上属于应用壳。

测量的耦合还暴露出**三个必须以单位形式提取（或破坏其循环）的圆形簇：

- `logging ↔ crash`加上`perf → crash`，`hooks → crash` →**遥测**集群
- `automation ↔ sandbox ↔ cua_sandbox` → **自动化**集群
- `scheduler ↔ workflow ↔ timing` → **调度**集群

## 决策

采用**分层的Cargo工作区**和**排序的构建速度程序**，按分阶段、并发安全的顺序执行。没有行为改变;这是一个结构+工具链程序。

### 目标架构

```
Layer 2 — app shell  (stays in src-tauri, thin)
  lib.rs assembly · generate_handler! · .manage(State) · plugin init
  companion_api (orchestrator + webrtc) · window/tray/menu/setup hooks

Layer 1 — pure-logic subsystem crates (each isolates one heavy dep)
  cognia-plugin-runtime (wasmtime, 15k)   cognia-connectors (matrix, 6k)
  cognia-vector (qdrant, 7k)   cognia-git (libgit2, 5k)   cognia-ocr (2k)
  cognia-automation +sandbox +cua (UIA, 22k)   cognia-terminal (pty, 5k)
  cognia-subscription (7k)     cognia-scheduling +workflow +timing (10k)

Layer 0 — foundation (no tauri)
  cognia-core: command_error · fs_atomic · secret_store · proxy_config · shared utils
  cognia-telemetry: logging + crash + perf (the cyclic cluster, extracted together)
```

### 提取层级（按风险排序）

**A层——干净的叶（仅依赖第0层）。** 无需依赖反转：`vector`、`git`、`ocr`、`automation`/`sandbox`/`cua_sandbox`集群、`scheduler`/`workflow`/`timing`集群。

** Tier B — 需要先实现依赖反转。** 这些模块对应用层模块有*向上*依赖，必须被crate中定义并在shell中实现的特征替代：`connectors`（→ `companion_api`）、`terminal`（→ `cli_bridge`）、`subscription`（→ `claude`）、`plugin_api`（→ `claude`、`connectors`）。

** C层 — 留在应用壳层。** `companion_api`（webrtc，13路枢纽），window/tray/menu/setup，`lib.rs`布线，`files.rs`。

### 编译速度指标（按ROI排名）

**W1 — 零重构工具链获胜（先完成，独立提交）:**
1. **`lld`链接器。** 添加`rustflags = ["-Clink-arg=-fuse-ld=lld"]`（Windows出厂`rust-lld`）。170k-LOC crate的重连步骤会在每个增量构建中执行;LLD通常会削减30%到50%。
2. **`sccache`** 通过`RUSTC_WRAPPER` — 缓存1,331 dep编译;CI大额中奖、新收账和分行切换。
3. **AV Windows上的`target/`和`~/.cargo/`排除**——Defender扫描每个`.rlib`/`.o`是隐藏的20–40%增量税。
4. **dev-profile debuginfo：** `dev`配置文件仍然`debug = 2`;添加`[profile.dev] debug = "line-tables-only"` + `split-debuginfo = "unpacked"`以压缩增量编译（`test`配置文件已经通过这个来避免LLVM OOM）。
5. **先做基线：** 运行`cargo build --timings`+`cargo tree -d`一次以记录真实的关键路径before/after。

**W2 — 结构（真正的修复）:** Tier-A/B提取。编辑`cognia-git`然后重新编译 ~5k LOC + 小幅重新链接，而不是 170k LOC;独立crate并行编译;LLVM-OOM的变通方法变得多余了。

**W3 — 功能门槛（已经完成一半）:** 门禁 `webrtc`在`companion-wan`功能后面，`matrix-sdk`在`connectors-e2ee`功能后面，这样未触及连接的开发者跳过了~50 deps（还有`glam×18`）。OCR/docker/PDFium已经被限制✅了。

**W4 — 删除：** `cargo tree -d`后，在允许的情况下`glam`/`windows`/`nix` `cargo update --precise`的复制体崩溃。边缘但真实。

## 迁徙计划

每一步都是独立提交，由`cargo test --manifest-path src-tauri/Cargo.toml` + a `pnpm tauri build`烟雾进行门槛限制：

1. **W1 快速获胜批** — 仅触碰 `.cargo/config.toml` + 根 `Cargo.toml` 配置文件;几乎没有模块代码，冲突最低接口与并发WIP。
2. **提取`cognia-telemetry`**（日志 + 崩溃 + 穿透）——每个叶子都需要的共享基底;打破`logging ↔ crash`循环。
3. **提取`cognia-core`**（基础）——错误类型，`fs_atomic`，`secret_store`，`proxy_config`。
4. **提取`cognia-vector`**（A层，7k，隔离qdrant）——模板PR：证明“库crate定义`#[tauri::command]`，应用在`generate_handler!`中引用”端到端。
5. 将模板克隆，`cognia-git` → `cognia-ocr` →`automation`集群→`scheduling`集群。
6. 先做**Tier-B**依赖反演，然后提取`connectors`、`terminal`、`subscription`、`plugin_api`。

## 实施状态（W1 — 2026-07-30 着陆）

零重构内环批次在测量了苹果硅片macOS开发路径后登陆。一个代表性的应用壳编辑在温依赖缓存下使用了**44.83秒**：`app_lib`中为**36.5s**，最终`cognia-next`二进制为**3.97秒**。早期的143s样本还包含了因配置变更导致的一次性31.6秒`tauri-build`重播，因此不是热编辑的基线。

- `[profile.dev]`现在使用带有解压调试信息的 `debug = "line-tables-only"`。选择加入的`dev-full`配置文件会恢复完整的LLDB locals/type信息，显示为`pnpm tauri:dev:full`。
- `app_lib`现在只发出一个`rlib`。之前的Tauri移动模板列表在每次桌面重建时也会产生一个 **2.7GB 的静态库**。Cognia的iOS和Android壳Capacitor `mobile/` 8个项目，因此没有哪个Tauri移动版本占用那么多`staticlib`或`cdylib`。
- Apple Silicon macOS通过稳定的配置相对 clang 驱动选择与固定的 Rust 1.93 工具链捆绑的 Mach-O LLD;其他宿主靶标保留其现有的联结子。
- `sccache`仍然被推迟：它不会缓存最终链接，为了热编辑目标会与 Cargo 重叠增量，而且现有的`target/debug`缓存已经超过了 80GB。

在三款具有代表性的温热应用壳重建中，接受率为**≤15**，且Tauri成功上线。Tier-C提取只有在这批没达到那个条时才是下一步。Tauri相当的`--no-default-features`跑完成时间为**11.61秒 / 9.40秒/9.43秒**（中位数**9.43秒**，比44.83秒基线快79.0%），`pnpm tauri dev`成功启动了签名应用。唯一一个干净兼容版本耗时3分48.77秒，不包含在热编辑结果中。

## 实施状态（A层——2026-07-13登陆）

从`app_lib`中提取七个crate，每个提交是一个独立提交，门槛为`cargo test -p <crate>` + `cargo check --manifest-path src-tauri/Cargo.toml`。最终布局用更窄的 `cognia-instrument`取代了原计划的 `cognia-telemetry`（仅跨度注册——`perf`/`crash`/`logging` 仍保留应用端，因为只有 `perf::guard` 依赖叶子），并`command_error`折叠成`cognia-core`与 `fs_atomic` 并列：

| crate | 什么让我动了 | 孤立体 | 测试赛 |
| --- | --- | --- | --- |
| `cognia-core` | `fs_atomic` + `command_error`（基础，无Tauri） | — | 18 |
| `cognia-instrument` | `perf/{span,registry}`（进程-全局范围注册表） | — | 12 |
| `cognia-git` | `git/`（源控，ADR-0038） | `git2` / vendored-libgit2 （C） | 106 |
| `cognia-ocr` | `ocr/` + 5 `ocr-*`特征 | `ocrs`/`rten`/`oar-ocr`/`ort`（ONNX） | 43 |
| `cognia-vector` | `vector/` + `CredentialStore` 转位 | `qdrant-client` + `sqlite-vec` | 100 |
| `cognia-automation` | `automation`+`sandbox`+`cua_sandbox`簇 | `uiautomation`/`enigo`/`xcap` | 326 |
| `cognia-scheduling` | `scheduler`+`workflow`+`timing`簇 | `cron` | 108 |

**关键技术已验证：** “shim + re-alias”模式（`mod X;` → `pub use cognia_X as X;`）保持了`generate_handler!`列表和每个`crate::X::…`引用不变;`#[tauri::command]`在**库crate根库**中碰撞宏命名空间（E0255），因此OCR的 命令 被保存在`native`子模块中，并通过`ocr::native::…`引用;共享的`CredentialStore`/`perf`/`fs_atomic`接缝被反转或重新导出，而非重复;`command_error ↔ scheduler`循环通过将`impl From<SchedulerError> for CommandError`迁移到排班crate（孤儿规则OK）而被打破。`cognia-automation`需要一个`build.rs`，将Common-Controls v6 manifest嵌入到其**test**二进制文件（tauri→muda/rfd静态导入`TaskDialogIndirect`）中。

**测量胜利**（Windows开发框，温缓存）：`app_lib`是1~170k-LOC crate，所以冷重建需要**~4m08s*，任何编辑都得重新运行crate整个代码生成。提取后`app_lib`为 ~90k LOC，~80k 的子系统LOC为独立缓存的 rlib：繁重的每crate代码生成（git2/vendored-libgit2、Qdrant、ONNX、uiautomation）不再是 `app_lib` 编辑的一部分。每crate循环现在是秒数——`cargo test -p cognia-git` = **12秒*，`-p cognia-automation`的326次测试在编译后每小时**~2秒*内完成——而在接触一个提取crate后，整棵树的完整一整`cargo check`是**~41秒*（相比于重新检查单体）。~726个crate级单元测试通过;每次提取后`app_lib` `cargo check`都是绿色的。最终的应用二进制 **link** 未在本地重运行（开发磁盘处于 ~5–8 GB空闲，完整的工作区调试链接需要更多）——CI / `pnpm tauri build` 执行;`cargo check`+全开版crate涵盖了除了代码生成+链接LLVM以外的所有内容。

**本轮未完成（推迟）:** W1构建速度配置（lld链接器、`[profile.dev]` debuginfo、sccache）和W3功能门槛——用户选择保持默认构建不动;以及 **Tier B**（`connectors`/matrix-sdk、`terminal`、`subscription`、`plugin_api`/wasmtime），需要上述依赖反转，并在审核时有门槛限制。

## 实施状态（Tier B + 后续 — 2026-07-13，macOS场）

又提取了13个crate（~58.5k LOC），每个crate提交一次，每个提交受 `cargo test -p <crate>` + `cargo check -p cognia-next` 限制（测试失败与预先移动`app_lib`测试二进制交叉核对——每次失败都重现预先移动，即已有的macOS/platform失败，未引入任何失败）。`app_lib`现在是**65,780 LOC**（从~113k post-Tier-A到170k pre-ADR）。macOS基线还发现了一个Tier-A漏洞：`cognia-scheduling`缺少仅限Mac的`dirs`/`libc` deps（在Windows上提取，`scheduler/macos.rs`从不编译）——已修复。

| crate | LOC | 什么打动了我/孤立了什么 | 需要反转 |
| --- | --- | --- | --- |
| `cognia-secrets` | 1.2k | `secret_store` + `keyring_secrets` + `api_key`;密钥环 + aes-gcm | 无 — 命令 shells仍留在应用侧;`test-inmemory`功能取代了内存中的全局 `cfg(test)`（cfg（test）不跨crate;依赖变量可通过开发-DEPS实现） |
| `cognia-net` | 2.1k | `proxy_config`（state/detect/wsproxy）;Reqwest 保持`cognia-core` | 没有——`proxy_config/` 只是应用端的表象，和 命令 shell 一起 |
| `cognia-terminal` | 4.8k | 终端子系统;`portable-pty` | `set_managed_cli_dirs_provider`（cli_bridge登记处），注册于`run()` |
| `cognia-subscription` | 6.4k | 金库+anthropic/codex/opencode 提供商（ADR-0025） | 无——17 分命令顶级 IPC 接口 留在应用端（拥有sidecar重启缝线） |
| `cognia-connectors` | 6.1k | webhook/WS Ingress、sigverify、Matrix E2EE stack | `BusEventEmitter` impl（其唯一的施工现场）迁至crate `companion_api::server`自有`EventEmitter`地 |
| `cognia-plugin-runtime` | 15.2k | 插件运行时;**wasmtime/cranelift** | `set_sidecar_dir_resolver`（claude：：sidecar），注册于`run()`年;规范WIT保持在`src-tauri/wit/`（Bindgen 使用相对路径——插件 SDK sync/gate脚本依赖于该位置） |
| `cognia-skills` | 2.1k | 技能scan/install/registry | 无（零耦合） |
| `cognia-tts` | 0.9k | 边缘TTS，用 提供商 密钥环，代理取球 | 没有 |
| `cognia-remote-control`（2026-08-09 退役） | — | 由 Companion 控制面取代 | — |
| `cognia-gateway` | 6.6k | OpenAI-compatible 本地网关 | 无 |
| `cognia-ccswitch` | 2.4k | 提供商继电器切换器 | 无（使用 Cognia 订阅发现） |
| `cognia-mcp-server` | 3.9k | 嵌入式MCP服务器（可流式HTTP） | 无（使用Cognia-Automation Dispatcher） |
| `cognia-external-agent` | 4.9k | 执行后端;**路桩**/**kube** 在crate特征后面（`container-exec`/`k8s-exec`现在从app_lib前转） | `BusAgentEmitter`因`companion_api::rpc`移至crate `AgentEventEmitter`特质后方;环境突变测试获得了crate本地锁，取代了借来的`ws_bridge`测试锁 |

** 什么是故意留在应用端（Tier C）:** `companion_api`（28.2k — 每个非目标的编排器枢纽）、`fleet`（5.7k — tray/window/monitor耦合）、`claude`（3.1k — sidecar hooks/companion_api/api_key 的生命周期）、`cli_bridge`（2.7k — 取决于companion_api）、`logging`/`crash`/`perf`遥测剩余部分（5.3k — tauri/app提取`cognia-instrument`核心周围的布线）、windowing/app壳（`pet_window`、`tray`、`menu`、`shortcuts`、`browser` —嵌入WebView窗格依赖Tauri不稳定的 API `window_*`）、`headless`/`bin`装配、承载命令壳的门面模块（`subscription/commands.rs`、`proxy_config/`、`keyring_secrets.rs`）以及小于 1k 的叶子（`agents`、`github`、`twin`、`parse`、`wallpaper`、`capture`、`canvas`、`plugins`、`a2ui_bridge`），其中工作区成员的开销大于编译单元的优势。`files.rs`（2.2k）和`settings.rs`设计上是应用层面的。

**门禁运行：** 每crate套件（13个新crate≈1,100次测试），针对每个移动缝隙的app_lib套件，`cargo check --workspace`绿色（0错误），功能转发路径`cargo check -p cognia-next --features container-exec`。与 Tier A 类似，最终的应用二进制链接由 CI / `pnpm tauri build` 覆盖，而非本地重运行。

## 后果

- **开发内循环：** 一个子系统的更改不再重新编译另一个165k的LOC;App-shell 的 Glue 编辑不再重新编译vector/plugin/automation。
- **并行性：** 独立crate并发编译;CI墙上的时钟随着`sccache`下降得更远。
- **LLVM OOM 已退役：** 每crate代码生成单元体积小，`test`-profile debuginfo 的变通方法不再是负重的。
- **更清晰的分层：** 三个循环簇被迫暴露真实接口;Tier-B反转消除了应用层模块上的向上延迟。
- **功能门槛开发版本**让贡献者编译接口子集。

## 风险

- **并发树危险。** 工作树目前承载了大量来自其他会话的未承诺工作。分解会重写共享文件（`Cargo.toml`、`lib.rs`、`.cargo/config.toml`），因此必须根据该WIP进行排序——因此W1（仅配置）优先，之后每个提交crate一次。参见`concurrent-tree-safety`。
- **Tauri 命令-in-crate注意事项。** 宏生成的`__cmd__*`包装必须在`generate_handler!`站点进行`pub`和导入;编译时错误接线会失败（不是无声的），所以它是自检的。
- **Capability/ACL漂移。**命令移动的crate必须保持其`capabilities/*.json`条目有效——由`tauri-rust-reviewer`陷阱列表覆盖。
- **libgit2/onnxruntime构建脚本**按crate运行;提取必须保持`build.rs` PDFium/dylib 暂存和`ort` `copy-dylibs`行为。

## 非目标

- 没有运行时行为变化，依赖升级也没有，除了去重叠，`output: "export"`和捆绑包布局也没有变化。
- ADR内`companion_api`未分解（单独追踪）;它仍然是应用端的编排器。
- 没有向`panic = "abort"`移动（crash-handler/minidumper路径依赖于展开）。

## 考虑的替代方案

- **什么都不做/只有W1工具链获胜。**真实但有界（link/incremental~30–50%）;保留了170k-LOC的全部重新编译问题。W1也是被采纳的，而不是*取代*。
- **按`mod`可见性/内部`#[path]`技巧分割。** 不改变编译单元——Cargo仍会重新编译整个crate。没有编译速度的好处。
- **一个巨大的 `cognia-backend` 库crate + 一个极薄的 `src-tauri` bin。** 成本更低，但只有当 bin 变化比库更多时才有用;它不提供每个子系统增量隔离，这才是真正的胜利。

## 附录 — 测量数据（2026-07-13）

- 通过`wc`/`grep` `src-tauri/src/`和`Cargo.lock`捕获了每模块的LOC和 `#[tauri::command]`数量、跨模块导入图以及重度所有权。耦合图证实了leaf/hub分裂和上述三个循环簇。
- 重现：在`cargo build --timings`、`cargo tree -d`和每个模块`grep -c '#\[command\]'`/`grep -rhoE 'crate::[a-z_]+'`扫描。

## 关键文件

- 工作区：根`Cargo.toml`（`[workspace] members`）、`.cargo/config.toml`、`rust-toolchain.toml`、`src-tauri/Cargo.toml`、`src-tauri/build.rs`
- 集合点（C层）：`src-tauri/src/lib.rs`（`mod` decls + `.manage()` + `generate_handler!`）
- 提取模板目标：`src-tauri/src/vector/` → `crates/cognia-vector/`
- 现有先例：`crates/cognia-sandbox-runner/`，`crates/cognia-cli/`
