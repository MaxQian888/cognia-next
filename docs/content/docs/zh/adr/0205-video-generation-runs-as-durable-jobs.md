---
title: "0205 — 视频生成以持久任务运行"
description: "视频生成成为正式功能：一个引擎用 AI SDK 的 startVideo 发起提供商任务，把不透明的 operation 存进 Dexie 任务行；渲染进程中的协调器跨刷新轮询，只下载一次结果并存到发起的位置。聊天工具、/video、文件页、工作流节点、插件 API 和执行器的 videos.* 处理器都是这个引擎上的适配层。"
---

# ADR 0205 — 视频生成以持久任务运行

**状态：** 提议
**日期：** 2026-09-29
**相关：** [ADR-0168](./0168-an-edit-is-a-new-version-of-the-same-message)（统一媒体引擎，插件 API 委托给它）、[ADR-0180](./0180-a-video-reaches-the-model-as-what-it-can-read)（视频输入处理）、[ADR-0200](./0200-files-is-a-view-that-keeps-what-you-keep)（文件页聚合）、[ADR-0163](./0163-provider-operation-contract)（提供商操作执行器）

## 背景

Cognia 能生成视频，但用户用不到。`generateProviderVideo` 和提供商操作执行器的
`videos.*` 处理器只被插件 API 和 CLI 调用。有三个事实让现有路径无法直接作为产品功能：

- **它是同步的。** `experimental_generateVideo` 在 SDK 内部最多轮询十分钟。渲染进程的工具调用
  120 秒就超时，刷新会丢掉任务以及已经花掉的钱。
- **它在打包后的桌面端跑不起来。** 视频模型构建时没有注入 `fetch`，所有请求都被 WebView 的
  `connect-src` CSP 拦截。`pnpm dev` 没有 CSP，因此掩盖了这个问题。
- **任务句柄活不过刷新。** 执行器的任务注册表只在内存里；刷新后对本地句柄调用 `videos.get`
  会落到 Veo 的接口上，用一个 Veo 从未签发过的 id 去查询。

已安装的 AI SDK 本身就有持久化所需的原语：`experimental_startVideo` 返回可 JSON 序列化的
`operation`，`experimental_getVideoStatus` 可以在任意进程里用它查询。支持的七个提供商
（Google Veo、xAI、fal、Replicate、豆包与火山引擎 Seedance、通义万相）都实现了它。

## 决策

### 1. 一个引擎，持久的任务行

`lib/ai/media/video-jobs/` 用 `startVideo` 发起任务，并写入一行 `mediaGenerationJobs`，
包含请求、提供商坐标（`providerId`、`modelId`、`baseURL`、凭据归属）以及不透明的
`operation`。之所以保存 base URL，是因为除 fal 外，每个提供商都会用当前配置重新拼出状态查询地址。
存储放在一个端口之后：应用里是 Dexie，CLI 里是内存。

### 2. 渲染进程协调器，同一时间只有一个窗口

一个初始化器持有 `navigator.locks` 锁，保证只有一个窗口轮询。它按退避节奏查询到期的任务行，
把超过 30 分钟期限的任务标为 `timed_out`（用户可以再查一次），并在刷新后恢复 `generating`
状态的任务。按状态抢占保证只下载一次。

### 3. 只下载一次，绝不保存 URL

提供商返回的是会过期的 URL，Google 的 URL 还带着 API key。引擎在第一次 `completed`
时就下载，把字节存到发起任务的位置（聊天存为会话资产，插件存为文件页上传项，工作流写到磁盘文件），
然后丢弃 URL。所有请求都走 `platformFetch`，一并修好了所有调用方在桌面端的 CSP 问题。
桌面网络桥最多缓冲 64 MiB；更大的结果会在 `Content-Length` 预检时提前以 `result_too_large` 失败。

### 4. 各入口都是适配层

- agent 工具 `video_generate` 立即返回任务 id（审批方式：询问），另有只读的 `video_status`。
  绑定 IM 的会话和 CLI 不提供它。任务完成不会触发新的 agent 回合，由聊天卡片直接播放。
- `/video` 不经过 agent 回合就发起任务，并把一条带任务 id 的系统消息写入对话记录；卡片读取任务行，
  之后无需再写消息即可跟随任务。已添加的图片作为起始帧（存为该对话的附件），不会再随回合发给模型。
- 任务不跨设备同步。在其他设备上查看这段对话的伴侣端，会把卡片显示为"此设备上没有这个视频任务"。
- 新增"媒体生成"设置分区保存默认值，每个入口都可以单次覆盖。
- 文件页新增 `video` 类型，从成功的任务聚合而来。
- 工作流节点 `action.media.generateVideo` 写出文件并输出其路径。
- 插件 API 和执行器的 `videos.*` 处理器都调用这个引擎。

### 5. 取消如实说明

SDK 没有取消接口。有取消接口的提供商（Replicate、fal、方舟、排队中的 DashScope）会真正远端取消；
其余提供商在 UI 上说明"取消只是停止等待，提供商仍可能完成并计费"。

### 6. Web 端明确标注，不靠猜

在 Web 版里，未确认允许浏览器直连的提供商会列出但不可用，标注"需要桌面端"，在类型上写明并由测试固定。

## 交付

1. 引擎、`mediaGenerationJobs` 表（schema v234）、协调器，以及插件 API 和执行器 `videos.*` 改走引擎。
2. "媒体生成"设置分区、`video_generate` / `video_status` agent 工具、`/video` 和聊天任务卡片（包括对超时任务的"再查一次"）。
3. 文件页 `video` 类型和 `action.media.generateVideo` 工作流节点。

第 1 步交付时还没有来自聊天的任务，但引擎、存储、备份和会话级联已经能处理这种来源，第 2 步开始使用它。

## 影响

- 视频生成在打包后的桌面端可用，并且能跨刷新继续。
- 现有的插件视频 API 在桌面端开始可用，签名不变，并会在文件页留下一项。
- 新的 Dexie 表参与备份；失败和取消的任务 30 天后清理，成功的任务跟随所属会话。
- 对媒体模块支持的七个提供商，提供商操作 `videos.generate` 现在不再等待视频生成完毕，而是返回 `running` 和一个 `vjob_…` 句柄；`videos.get` 会向提供商查询任务状态，`videos.content` 在任务成功后返回字节。CLI 中任务只在进程存活期间保存在内存里。
- 不保存封面图。媒体存储里的封面只会被任务行引用、不会被消息引用，而媒体垃圾回收看不到任务行；播放器会直接显示视频自身的第一帧。时长和尺寸在当前环境能解码时从文件中读取。
- 在有流式原生下载之前，桌面端超过 64 MiB 的结果会失败。
- 所有窗口都关闭时轮询暂停；只要提供商还保留结果，下次启动仍能取回。

## 否决的方案

- **扩展执行器的句柄契约以携带 operation。** 为同样的工作在多个包之间增加契约面；改为让任务 id 直接充当句柄 id。
- **Rust 任务运行器。** 能在窗口关闭后继续并去掉大小上限，但要在 AI SDK 之外重写七家厂商的 REST 接口。只有这两点成为硬需求时再考虑。
- **新增 `supportsVideoGeneration` 模型能力。** 视频模型不在提供商目录里，`VIDEO_PROVIDERS` 已经是唯一来源。
- **复用后台任务注册表。** 它的类型和结果投递都是为子 agent 设计的。
