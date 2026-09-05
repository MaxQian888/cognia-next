---
title: "0170：中继就是广域网，连接只有一个面"
description: "托管信令会合点承载应用数据通道，邀请携带中继房间以便首次配对可在任何网络完成，主机的连接配置放在所有者鉴权的 RPC 面上，设置里只有一个「连接」区。"
---

# ADR 0170：中继就是广域网，连接只有一个面

**状态：** 已接受
**日期：** 2026-09-05
**修订：** ADR-0021（WebRTC 广域网传输）、ADR-0059（无头服务器）、ADR-0082（远程主机）

## 背景

不在主机局域网内的手机或浏览器有三处会断。

1. 首次配对（`/api/auth/device/challenge` 与 `register`）只能走直连 HTTPS。
   手机必须先在局域网内配对，浏览器则永远无法跨广域网配对，因为它不能固定
   主机的自签证书。
2. 没有托管 TURN，任意一侧的对称 NAT 都会让 WebRTC 升级失败，而底下没有兜底。
3. cloudflared 隧道由用户自行安装，且仅桌面可用。

唯一的托管组件是 `wss://signaling.cognia.cn/signaling` 的信令会合点
（Cloudflare Worker 与 axum 两种构建，共用 `cognia-signaling-core`）。它本来就
在房间的两个对端之间转发不透明的 `Relay` 帧，只是对端把信封类型限制在
`hello` 与 SDP/ICE。所以应用层中继是对端侧的工作加上服务端的预算，而不是
一个新服务。「Cognia Cloud」指的就是升级后的这个会合点。

后端等价还有第二个缺口。桌面渲染端通过 Tauri 命令配置信令、浏览器 origin
白名单、推送凭据与邀请；无头 `cognia-server` 只能在启动时从环境变量做同样的
决定，配对设备无法更改。设置里又把同一个问题拆在「移动端伴侣」（五个折叠组里
十五张卡）和「远程主机」两个区，旁边还有 `/devices` 与 `/pair`。

## 决定

### 中继与 DataChannel 同构

`EnvelopeKind::Data` 承载的就是 `datachannel_framing.rs` 产出的一帧
DataChannel 数据：JSON RPC 帧、`event` 与 `event-batch`、`binary-resource*`
及其分片。同一个分发器、同一个幂等账本、同一个事件游标、同一个 1 MiB 消息上限
同时服务两条载体。主机侧 `carrier.rs` 的 `DataCarrier` 优先使用已打开的
DataChannel，否则回落到中继。客户端 `TransportRtc` 在主机的 `hello` 应答
`relay: true` 的那一刻就通过中继进入 `open`，并在后台协商 ICE。DataChannel
打开即提升载体，掉线即降级，不触发重连。传输层词表新增 `relay`。

服务端按发送方标注的 `lane` 字段给 `Relay` 帧分桶，不解密任何内容：
`signal` 通道保留 20 帧桶与 8 KiB 软上限，`data` 通道单独一桶（256 帧，每秒
补 64 帧）与 64 KiB 上限。`/metrics` 导出按通道的帧数与字节数。本轮没有硬配额。

### 邀请携带中继房间

`cgnp4` 在配对载荷上增加 `relay: { url, room, mobilePrivateKeyJwk }`。主机
为受邀方铸造一把一次性 P-256 密钥，在邀请有效期内驻留于会合点的配对房间，
并通过在进程内驱动自己的 axum 路由来应答 `pair.http` RPC 帧，只放行四条配对
路由。客户端先直连探测四秒，失败再走中继。`cgnp3` 仍可解码，没有会合点的
主机仍然铸造它。

### 通过 host-admin 面实现后端等价

十四个命令从 `target: client` 迁到 `target: host-admin`（`capability:
host.admin`，HTTP、WebSocket、WebRTC）：信令状态、配置、设备状态与重连，
浏览器访问读写，推送状态、四个凭据写入、测试推送，邀请签发与服务状态。同一份
Rust 实现同时服务 Tauri 命令与 RPC 分支（`rpc/host_admin.rs`）。无头主机把
信令配置持久化到 `signaling.json`。`cognia-server pair` 向运行中的服务索取
邀请，这样中继房间是真实存在的。

仍然仅桌面可用的部分就地标注而不是隐藏：隧道（子进程）与 mDNS（局域网组播
套接字）。`lib/connectivity/host-admin-reach.ts` 对每个控制回答「能否从这里
运行，不能的话为什么」，每个区块都渲染这个答案。

### 一个「连接」区

设置新增一个主从式区，七个主题：总览、本机主机、云与中继、配对、远程主机、
推送、同步。两个退役区的深链接重定向到这里。配对步骤搬到
`components/connectivity/pair/`，桌面「添加主机」表单、网页 `/pair` 与移动端
`/pair` 用的是同一个组件，旧路径留有再导出。`/devices` 仍是独立路由。

### 同一批修掉的死线

`/devices` 上的暂停、恢复、吊销从任意已配对伴侣经主机的所有者路由可达。推送
新增「发送测试」，报告触达了多少离线设备。存在感注册表在设备失去全部事件流
后仍持续发请求超过一个租约续期间隔时产出 `degraded`，连接总览与状态栏都渲染它。

## 非目标

托管 TURN。托管无头服务。中继字节配额。无头主机上的隧道或 mDNS。移动端代理
设置。部署 Worker（运营者在 `services/signaling-server/worker` 执行
`wrangler deploy`）。

## 后果

- 设备可以从任何网络配对，两侧都不需要安装任何东西。
- 浏览器配置无头主机的方式与桌面渲染端完全一致。
- 中继是地板而不是天花板：P2P 仍会尝试，成功时仍然优先。
- 会合点现在承载应用流量，通道预算就是滥用控制。关注
  `signaling_relay_bytes_total{lane="data"}`。

## 注册点

- 线路：`services/signaling-server/core/src/{proto,limits}.rs`、axum 的
  `ws.rs` 与 `metrics.rs`、Worker 的 `room.rs`。
- 主机：`src-tauri/src/companion_api/signaling/{carrier,pairing,client,dispatch,mod}.rs`、
  `companion_api/{signaling_config,rpc/host_admin}.rs`、`bin/cognia-server.rs`。
- 客户端：`lib/tauri/{transport-rtc,transport-companion,relay-pair-fetch}.ts`、
  `lib/qr/pair-payload.ts`、`components/connectivity/pair/`。
- 契约：`protocol/companion-commands.json`、`protocol/companion-response-schemas.json`、
  `protocol/headless-command-dispositions.json`、`pnpm companion-api:gen`。
- 设置：`components/settings/connectivity/`、`lib/connectivity/host-admin-reach.ts`、
  `hooks/connectivity/use-host-admin-reach.ts`。
- 设备：`lib/devices/lifecycle-http.ts`、`lib/companion/device-presence-registry.ts`。
