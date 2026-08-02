---
title: "ADR-0021 — WebRTC DataChannel WAN 传输"
description: "仅支持v2的端到端加密信令和信令DataChannel 传输，用于配对mobile/browser客户端与Cognia主机之间。"
---

# ADR-0021 — WebRTC DataChannel WAN 传输

状态：已接受并已实现。线路协议仅支持v2。没有v1兼容模式、降级路径或共享信令秘密。

## 决策

Cognia将LAN HTTPS/WebSocket作为首选。当配对主机在LAN上不健康时，客户端尝试一条可靠、有序的WebRTC DataChannel，名为`cognia.v2`。经过认证的HTTPS/WebSocket路由仍然是命令元数据允许重试的命令的安全回退。

公共Worker是主要的会合点。Axum服务实现了相同的自托管和灾难恢复协议。两者都暴露了`/v2/signaling`。

## 配对材料

配对形成一个`RoomDescriptorV2`：

- 版本`2`;
- 一个随机的128位房间随机化;
- 桌面和移动端ECDSA P-256公钥;
- 一个有效期;
- `roomId = SHA-256(length-prefixed canonical descriptor fields)`。

描述符不包含用户标识或秘密信息。每个角色将私钥保存在OS 密钥环、Capacitor SecureStorage或不可提取的WebCrypto密钥中，并配有加密IndexedDB配对块。

## 准入与加密信令

服务器首先发送一个五秒钟的随机挑战。客户端订阅时，签名涵盖挑战、房间、角色、会话、纪元、发行时间和临时ECDH公钥。一个较新的有效连接在原子层面上替换了同一角色的旧连接。一个房间有一个活跃的桌面和一个活跃的移动端。

入场后，双方：

1. 衍生出P-256 ECDH共享秘密;
2. 推导出带有HKDF-SHA-256的方向性AES-256-GCM键;
3. 用唯一的随机数加密SDP/ICE;
4. 用 P-256 签名完整的长度前缀头部和密文ECDSA;
5. 通过一个有界、序列化的信令队列发送。

接收端在解密前验证角色、签名、时间戳、纪元和严格递增的序列。一个小的重排序窗口处理网络重排序，不接受重复。交会可以路由并强制房间所有权，但不能读取或伪造SDP/ICE。

## 谈判与恢复

ICE在`setRemoteDescription`之前收到，按顺序保留，最多可达256个候选，持续30秒。溢出或过期结束该协商纪元。异步工作在变异对等状态前检查其历元。

恢复阶梯如下：

- 五秒`disconnected`恩典;
- ICE重启;
- 如果无法恢复ICE则进行全面对等重建;
- 全抖动`1/2/4/8/16/30s`重新连接后退;
- 只有在持续健康连接后才重置。

连接WebSocket有八秒的截止时间;挑战和订阅各有五秒的截止时间。缺少对立角色称为`awaiting-peer`，而非连接失败。

## 数据与RPC合同

DataChannel携带JSON RPC、事件重放控制和有界块帧：

- 体格：32 KiB最大;
- 逻辑消息：最大1 MiB;
- 8次并发重组和4次MiB总保留内存;
- 15秒assembly/send截止时间;
- 高水位1 MiB/低水位256 KiB的浏览器背压;
- 每个节点有32个并发RPCs和128个排队的入站帧。

RPC请求使用`{id, method, params, idempotencyKey, protocolVersion: 2}`。命令行为来自共享命令清单。HTTPS和RTC共享一个由`(deviceId, method, idempotencyKey)`键的持久24小时账本及参数摘要。完成的结果会被重放;不同的参数返回`idempotency_conflict`;崩溃后留下的待处理记录返回`idempotency_indeterminate`。

事件使用一个全局序列、一个持久的客户端光标、显式ack和24-hour/10，000帧保留。错过窗口会产生`resync_required`;客户端必须从权威snapshot/read RPCs重建受影响的域名，然后才能推进光标。

## 资源与运营边界

Axum 和 Worker 强制执行有界帧、令牌桶速率限制、角色基数、会话替换和 45 秒套接字租赁。Axum 使用有界对等队列并驱逐慢用用户。Worker状态存在可休眠的 WebSocket 附件中，并通过持久对象警报检查。

TURN 凭证这些配置寿命短暂，在过期前刷新，并且有代级保护，因此过时的异步结果无法覆盖新的配置。BYO STUN/TURN保持加法性，凭证保持在安全存储中。

遥测仅记录有界维度：协议版本、平台族、候选类型、connection/recovery阶段、错误代码、 回退、溢出和重新同步。SDP、ICE、密钥、载荷和完整room/device标识符从不被记录。
