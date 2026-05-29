---
title: "0013 — Companion API 命令清单"
description: "显式、手写维护的 Tauri 命令白名单，通过 /api/v1/_rpc 暴露给移动端客户端——之所以选择它而非代码生成 / 宏方案，是因为面向移动端的 API 面是经过精挑细选的子集，而非对每一个 Tauri 命令的 1:1 镜像。"
---

# ADR 0013 — Companion API 命令清单

**状态：** 已接受
**日期：** 2026-05-08
**分支：** `feat/mobile-m1-foundation`
**相关 issue：** [#34](https://github.com/MaxQian888/cognia-next/issues/34) (M2.2)
**前序：** [ADR 0012 — 传输层抽象](./0012-transport-abstraction.md)

---

## 背景

ADR 0012 引入了 `Transport` 接口，使前端封装层能够在 Tauri IPC（桌面端）
与 HTTP/WS（移动端 companion）之间切换。接下来的问题是：**桌面端的
axum 服务器如何知道应暴露哪些 Tauri 命令，而 TS 调用方又如何与 Rust
路由表保持同步？**

如今 `src-tauri/src/lib.rs` 通过单个 `tauri::generate_handler!` 宏注册了
**200+ 个命令**。若天真地把它们全部镜像进 RPC 路由器，将会：

1. 把仅桌面 / 危险命令（托盘操作、写壁纸、系统调度器提权、原生日志
   目录访问）暴露给任意已配对的手机——这是实打实的安全倒退。
2. 让 API 面膨胀到安全评审根本不切实际的程度。
3. 把「Tauri 内部便利性」（桌面 UI 为一次性交互临时派生的命令）与
   「稳定的面向移动端 API」（我们将在 V2 云部署的 OpenAPI 规范中发布的
   内容）混为一谈。

移动端真正需要的只是这 200+ 中的约 30-40 个：chat 发送 / 中断、agent
配置 IO、skill CRUD、MCP 测试、订阅凭据 CRUD、设置读写。其余都是桌面
内部使用。

## 决策

**在 Rust 中手写显式白名单。** 不用代码生成，不用宏。

companion API 面位于 `src-tauri/src/companion_api/commands.rs`，是一个
按命令名分派的单一 match 语句。每个分支都是一层薄薄的 shim，调用既有
Tauri 命令底层的那个函数（`#[tauri::command]` 注解只负责注册 IPC
绑定——函数体本身可被任意其他 Rust 调用方调用）。

理由：

1. **白名单即 API。** 每一个暴露给移动端的命令都会出现在这里。没有
   漂移风险，没有意外暴露——新增一个面向移动端的命令是一次显式、可审计
   的 PR；删除一个则是一行删除。
2. **安全评审范围有界。** 评审者看到的是约 40 条，而非 200 条。
3. **逐命令的形态控制。** 有些 Tauri 命令的便利型载荷无法干净地转换为
   JSON（例如它们接收 `tauri::State` 或 `tauri::AppHandle`）。shim 层在
   调用前先把请求载荷归一化。
4. **版本化存在于 URL 前缀（`/api/v1/`），而非 Rust 类型中。** 当 V2
   重塑某些输入时，唯一必须保持向后兼容的就是这层手写 shim——底层的
   Tauri 命令可以自由演进。
5. **没有构建期工具链。** 没有新的生成器脚本，没有 syn 式解析，没有
   cargo-watch 热重载的可维护性负担，没有 CI 断崖。

### 被否决的方案

- **方案 B —— 从 TOML/YAML 清单代码生成进 Rust + TS。** 很好地解决了
  漂移问题，但增加了一个构建步骤、一个生成器脚本，以及「真相之源在
  哪？」的心智税。对 200+ 个命令值得，对 40 个不值。如果 API 面将来
  越过约 150 个命令，会重新考虑。
- **方案 C —— Rust 宏生成 TS shim。** 宏的复杂度带来的伤害大于它所
  防止的笔误风险。而且是单向的（Rust → TS），无法校验某个 TS 封装是否
  有对应的 shim。
- **方案 D —— 镜像全部 200+ 命令。** 安全倒退，见「背景」。

## 后果

**收益：**

- 显式的安全边界。给移动端 API 新增一个命令需要有人在
  `companion_api/commands.rs` 写 5-10 行——不会出现「我加了个 Tauri
  命令，忘了它最后落到手机上」这样的意外暴露。
- 如果将来逐命令的限流、幂等键或鉴权作用域检查要超出全局中间件，每个
  shim 都是它们天然的落脚点。
- M2.5（`/api/v1/_rpc/<name>` 路由表）是一个薄薄的 axum 路由器，其 match
  分支与本文件一一对应。评审者可以并排阅读两者。

**成本：**

- 新增一个移动端命令是两处编辑（Tauri 命令 + companion shim）。可以接受：
  第二处编辑是 API 契约，而非重复。
- TS 的 `transport.call(name, args)` 调用必须把命令名当作字符串字面量
  知道。M2 把它们内联发布；若维护痛点显现，M3 或之后可加一层薄薄的
  `CompanionApi` 类型化封装，为每个条目导出具名函数——但清单本身仍保持
  手写。
- M2 **不**加入漂移检测的 CI 测试。白名单足够小，PR 评审就能捕获漂移；
  如果该面增长到超过约 80 个命令，我们会用一个读取两份列表并比对的对等
  性测试来重新评估。

## 骨架（落地于 M2.5）

```rust
// src-tauri/src/companion_api/commands.rs
//
// Allowlist of Tauri commands the desktop exposes to paired mobile
// clients via POST /api/v1/_rpc/<name>. Each arm dispatches to the
// existing Tauri command's underlying function. Adding a new entry is
// a two-place edit: implement the Tauri command, then add the shim
// here. PR review enforces the allowlist; no codegen.

pub async fn dispatch(
    name: &str,
    args: serde_json::Value,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, RpcError> {
    match name {
        "claude_send" => claude::commands::claude_send(/* ... */).await,
        "claude_interrupt" => claude::commands::claude_interrupt(/* ... */).await,
        "claude_approve" => claude::commands::claude_approve(/* ... */).await,
        // ... ~30-40 entries total for V1 ...
        unknown => Err(RpcError::UnknownCommand(unknown.to_string())),
    }
}
```

TS 侧维持现状：每个封装模块（`lib/claude/ipc.ts`、
`lib/external-bridge/tauri-control.ts` 等）导出具名函数，调用
`transport.call("snake_case_command", args)`。传输层在桌面端路由到
Tauri IPC，在移动端路由到 `/api/v1/_rpc/snake_case_command`。两者最终
命中同一个 Rust 函数——桌面端经由 Tauri 的 invoke 流水线，移动端经由
`dispatch` match 语句。

## 接下来

M2.3 加入 `POST /api/v1/auth/pair`，M2.4 加入 JWT 校验中间件，M2.5 用约
30-40 个条目把上面的 `dispatch` match 语句填满，覆盖 V1 移动端功能集。
M2.6 加入 WS 事件通道；M2.7 在 TS 侧发布真正的 `CompanionTransport`。

## 参考

- ADR 0012 — 传输层抽象
- M2 issue 链：[#33](https://github.com/MaxQian888/cognia-next/issues/33)
  → [#34](https://github.com/MaxQian888/cognia-next/issues/34)
  → [#35](https://github.com/MaxQian888/cognia-next/issues/35) ‖ [#36](https://github.com/MaxQian888/cognia-next/issues/36)
  → [#37](https://github.com/MaxQian888/cognia-next/issues/37) ‖ [#38](https://github.com/MaxQian888/cognia-next/issues/38)
  → [#39](https://github.com/MaxQian888/cognia-next/issues/39) ‖ [#40](https://github.com/MaxQian888/cognia-next/issues/40)
- 既有 handler 列表（200+）：`src-tauri/src/lib.rs` `tauri::generate_handler!`
