---
title: "0212 — Broker 凭据是文件，不是环境变量"
description: "托管 code-server broker 不再把密钥放进 code-server 的环境变量（每个终端、任务和语言服务器都会继承它）。宿主把一次性 bootstrap 凭据写入私有文件，环境里只有文件路径；扩展读取后立即删除，双方再用握手 nonce 派生会轮换的 session key，密钥本身从不经过网络。bootstrap 在其首个使用者仍在线时被再次出示会触发实例熔断。旧的换行协议已删除，协议主版本改为协商。"
---

# ADR 0212 — Broker 凭据是文件，不是环境变量

**状态：** 已接受
**日期：** 2026-10-02
**相关：** [ADR-0088](./0088-pro-ide-code-server)（Pro IDE 与托管 broker）、[ADR-0196](./0196-a-library-crate-links-tauri-only-when-asked)（Rust 代码分层）

## 背景

托管 code-server profile 会加载 Cognia 的 broker 扩展，它连接应用内的 loopback
JSON-RPC 通道（`crates/cognia-codeserver/src/agent_channel.rs`），让应用和 agent 驱动
编辑器。它此前用每实例的 `tokenId.secret` 认证，宿主把它作为 `COGNIA_CS_AGENT_TOKEN`
放进 code-server 的环境变量。

code-server 会把自己的环境交给它启动的每个进程：集成终端、任务、语言服务器、调试
适配器。所以用户或 agent 在工作台里运行的任何命令都能读到这个密钥
（`env | grep COGNIA`）。通道允许最新的已认证连接替换旧连接，因此持有密钥的任何程序
都能接管编辑器通道、向聊天输入框注入 `chatContextRequested` 事件，并调用 content
handle 端点——后者直接把原始密钥当 bearer，并用 `==` 比较。

旁边还有两个较小的问题：已退役的换行协议仍然被接受（靠首字节嗅探），比计划多留了
一个版本；打包的 broker `.vsix` 只在版本字符串变化时才重装，且不校验文件完整性。

## 决策

### 1. 环境变量只带路径，不带密钥

宿主把 **bootstrap 凭据**（`{ tokenId, secret }`）写入每用户 `0700` 目录中的文件，
该目录位于 code-server user-data 目录**之外**（profile 同步会在 profile 间复制
user-data 树），文件以 `O_EXCL | O_NOFOLLOW`、`0600` 创建。子进程环境只包含
`COGNIA_CS_AGENT_CREDENTIAL_FILE`、agent 与 content 端口、host id 和 workspace，没有
任何密钥。扩展读取文件后立即删除。

### 2. bootstrap 只能用一次；session 派生并轮换

challenge 携带客户端 nonce，宿主回以服务端 nonce，hello 用 `HMAC(secret, 服务端 nonce)`
证明持有。hello 成功即消费 bootstrap，双方计算
`session = HKDF-SHA256(secret, "cognia-broker-session" ‖ 服务端 nonce ‖ 客户端 nonce)`。
session key 从不经过网络。hello 回复给出 `sessionId`；重连时出示它并证明持有 key，
每次成功的 hello 都会再次轮换 session。content 端点的 bearer 是
`sessionId.HMAC(session, "content")`，以常量时间比较。

### 3. 宿主始终保持一份可用凭据

只要某实例没有在线的已认证连接，宿主就重新签发 bootstrap 文件：连接断开时、宿主自己
重启扩展宿主之前、以及维护周期发现文件消失时（扩展宿主读取后崩溃）。这覆盖了宿主
未主动发起的扩展宿主重启，例如浏览器刷新。

### 4. 重放即熔断

bootstrap 在**消费它的连接仍在线时**被再次出示，说明有两方读到了文件。宿主关闭该
root 的全部连接、吊销 session、签发新 bootstrap、记录 `credential-replayed` 并发出
`codeserver://broker-security-event`，面板会警告用户。消费者已离线的旧 bootstrap 只会
被拒绝。

### 5. 唯一的帧格式，协商主版本

broker 只接受 `Content-Length` 帧的 JSON-RPC，其他任何输入都会收到
`IDE_BROKER_PROTOCOL_INCOMPATIBLE` 并被关闭。hello 列出扩展支持的全部版本，宿主选择
双方共有的最高主版本（`broker_protocol.rs` 中的 `negotiate_protocol`）；次版本差异由
capability 表达。没有共同主版本的 hello 被拒绝，并记为 `protocol-incompatible` 供 IDE
状态展示。

### 6. 安装前校验 broker 构建

`build.mjs` 在确定性构建的归档旁写入 `cognia-managed-broker.vsix.sha256`。两种宿主在
安装前都会校验打包文件，安装标记改为 `version+digest`；任何失败都会让工作台在没有
broker 的情况下启动并记录 `install-failed`，而不是写一条没人看的警告日志。若构建不再
写出摘要，或任一打包（Tauri 资源、服务器镜像）不再携带它，`pnpm audit:pro-ide-constants`
会失败。

## 不防御的内容

以同一系统用户运行的代码可以抢在扩展之前读取 `0600` 文件，也可以从扩展宿主内存中
读出 session key（例如通过 Node inspector）。决策 4 让前者变成可见事件；两者都无法
阻止。目标是阻止密钥通过继承泄漏（环境变量、日志、崩溃转储），而不是把用户与其自己
启动的进程隔离开。

凭据目录只支持 POSIX。code-server 没有 Windows 构建（`download.rs`），Windows 宿主
不会写出凭据文件。

## 影响

- Pro IDE 终端里的 `env` 不再显示 broker 密钥。
- 接管编辑器通道需要当前 session key 或宿主签发的 bootstrap，被抢先读取的 bootstrap
  会被报告。
- broker 扩展版本为 `1.2.0`；旧构建无法连接，会在下次启动时被校验后的重装替换。
- 每个 root 会记录 `BrokerIssue`（`protocol-incompatible`、`install-failed`、
  `credential-replayed`），供 IDE 状态展示。
