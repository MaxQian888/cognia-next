---
title: "0172：外网可达性要验证，不能假定"
description: "rendezvous 自报能承载什么、设置页真正去探测；桌面端检测可借力的第三方隧道与 overlay 客户端并给出安装引导；overlay 地址可以成为邀请通告的地址；唯一的 cloudflared 子进程拒绝被静默改指向。"
---

# ADR 0172：外网可达性要验证，不能假定

**状态：** 已接受
**日期：** 2026-09-06
**修订：** ADR-0170（中继即 WAN）、ADR-0021（WebRTC WAN 传输）
**相关：** ADR-0059（无头服务器）、ADR-0143（设备控制台）

## 背景

ADR-0170 让 `signaling.cognia.cn` 上的托管 rendezvous 成为「在任何地方都能用」的那条路。但有四件事仍然只是假定。

1. rendezvous 的 `GET /healthz` 只回 `ok` 和一个版本号，而 data 通道之前的部署回的是一模一样的 `ok`。那样的中继会把 `data` 通道的帧塞进 signal 通道 8 KiB 的上限里转发，设备看到的是一个「能用」的中继，直到第一帧装不下。应用里没有任何东西能区分这两者，「云端与中继」页面给出的是一个开关和一个 URL，不是一个结果。
2. 桌面端的 cloudflared 隧道是用户自己装的二进制，应用要等开关打开、spawn 失败才知道它不在。安装步骤只在 Connections 的 Tunnel 页有一份，还是没翻译的硬编码表。
3. Tailscale 和 ZeroTier 是大多数人已经在用的、把手机和桌面放进同一私有网络的办法。应用完全不知道它们的存在：邀请通告的是自动探测的 `192.168.x.x`，同一 tailnet 上的手机根本连不到，而它能连到的 overlay 地址就在旁边一张网卡上。
4. 一个 `cloudflared` 子进程服务两个调用方、两个 origin：伴侣 HTTPS 监听器和连接器的 webhook 接收器。第二次启动会静默杀掉第一次，而启动第一次的那个界面仍然显示着一个已经指向别处的公网地址。

Plex 在任何设置之前先用一句话回答「Remote Access」，Tailscale 客户端有连接检查，Home Assistant 的云面板会说什么是可达的。模式就是：先验证，再给一个词。

## 决定

### rendezvous 自报能承载什么

两个信令后端（axum、Worker）的 `/healthz` 都加上来自 `cognia-signaling-core::health` 的 `capabilities` 块：协议代际、所服务的通道、一个 `relayDataLane` 标志。端点带上 `access-control-allow-origin: *`，因为读它的设置页面是一个静态导出、跑在中继从未听说过的 origin 上。没有 data 通道的构建只列出 `signal`，没有 capabilities 的构建什么都不列，两者都读作 `legacy`。

`lib/signaling/relay-probe.ts` 把配置的 `wss://` 端点换成健康检查 URL，通过 `createPlatformFetch()` 抓取（桌面 CSP 没有列中继主机，Capacitor 外壳没有 CORS），并把答案分类为 `ready`、`legacy`、`not-a-relay`、`unreachable`、`invalid-url`。它只按需运行，从不自动运行，最近一次结果连同时间一起展示。

### 各条路线上方的那一句话

「云端与中继」以 `RemoteAccessSummary` 开头：由 `remoteAccessVerdict` 综合中继探测、隧道和 overlay 网络得出一个结论，然后每条路线一行。在任何有主机的外壳上，中继的开关与 URL 来自 host-admin 的 `companion_signaling_status` 臂，所以一个配对到无头服务器的浏览器探测的是主机的中继，不是它自己的设置。独立浏览器读自己的设置，并且明说。

### 桌面端检测它能借力的东西

两个新的仅桌面命令，由 `host-admin-reach` 像隧道和 mDNS 一样标注：

- `companion_tunnel_probe` 在进程的 `PATH` 上找 `cloudflared` 并运行 `--version`。隧道块在开关被碰到之前就显示安装引导，找到时在标题旁显示版本。
- `companion_mesh_status` 枚举本机网卡，报告 Tailscale（`100.64.0.0/10`、`fd7a:115c:a1e0::/48`）与 ZeroTier（`zt*`、`feth*`、"ZeroTier One"）地址，以及各自的客户端是否已安装。检测只看地址和网卡名，从不与守护进程对话。

`components/connectivity/tunnel-install-guide.tsx` 是三个工具共用的唯一安装引导，由 `lib/connectivity/tunnel-install.ts` 按操作系统族提供，厂商命令行原样保留，周围的文字可翻译。Connections 的 Tunnel 页也用它。

### overlay 地址可以成为通告的地址

`reachability.json` 增加 `advertiseHost`。`advertised_lan_host()` 是桌面邀请命令、host-admin 邀请臂和 `companion_endpoints` 局域网报告背后的同一个函数：有保存的地址就用它，否则用自动探测的局域网地址。mesh 块把当前持有的 overlay 地址作为该地址提供，在仅回环绑定时拒绝，在保存的地址不再被任何网卡持有时告警。

### 唯一的隧道子进程不会被静默改指向

`TunnelState::start` 对已经暴露的 origin 是幂等的，对不同的 origin 用 `TunnelError::Busy` 拒绝，除非设置了 `replace`。两个界面都显示冲突，说明隧道暴露的是什么、在哪个公网地址，并提供「替换」。从另一个界面启动的活跃隧道会显示它实际暴露的东西，而不是被当成本监听器的。

## 非目标

无头主机上的隧道、mesh 或 cloudflared 检测：它用 `COGNIA_PUBLIC_URL` 和 `--advertise-url` 说明自己的公网地址。在应用里管理 Tailscale 或 ZeroTier。自动探测中继。部署 Worker 仍是运维方的动作，只是没部署时探测现在会把它显示出来。

## 后果

- 过期的 rendezvous 部署变成设置页里的一句话，而不是路上发来的一张工单。
- 有 Tailscale 的用户翻一个开关，就能让手机从任何网络走普通 HTTPS 层配对，且不向公网暴露任何东西。
- 安装步骤只在一张表和一个组件里。
- `HEADLESS_CATALOG_HASH` 没有变化：两个命令都是 `client` 目标，Brain 桥接契约未被触动。

## 登记点

- 中继：`services/signaling-server/core/src/health.rs`、axum 的 `server.rs` 与 Worker 的 `lib.rs`、`lib/signaling/relay-probe.ts`。
- 桌面：`src-tauri/src/companion_api/{tunnel,mesh,reachability_config}.rs`、`commands.rs`（`companion_tunnel_probe`、`companion_mesh_status`、`advertised_lan_host`）、`rpc/host_admin.rs`、`rpc.rs`（`lan_base_url`）。
- 契约：`protocol/companion-commands.json`、`protocol/headless-command-dispositions.json`（均为 `local-only`）。
- 设置：`components/settings/connectivity/blocks/{remote-access-summary,relay-check-block,mesh-block,tunnel-block}.tsx`、`hooks/connectivity/use-remote-access.ts`、`lib/connectivity/{remote-access,mesh,tunnel-install,tunnel-resolver,reachability-prefs}.ts`、`components/connectivity/tunnel-install-guide.tsx`、`components/settings/connections/tabs/tunnel-tab.tsx`。
