---
title: "ADR-0060 — 个人知识捕获与洞察"
description: "记录四阶段传递，借用OpenWiki最佳创意到认知中：更高质量的网页阅读器（Jina + 平台抓取器覆盖CORS-free Rust取）、no-AI维基林特（孤儿页面+破损[[链接]）、注意力雷达（通过桌面宠物传递的7维记忆信息饮食分析+捕获），以及一个OpenWiki-style内容捕获确认气泡，供雷达数据。文档记录了重用优先接缝、模式添加（Dexie v95–v97）以及Phase-4桌面原生范围。"
---

# ADR-0060 — 个人知识捕获与洞察

**状态**：已接受（2026-07-02）**作者**：Max Qian+Claude

## 背景

我们研究了[kdsz001/OpenWiki](https://github.com/kdsz001/OpenWiki)——一个同栈（Tauri + Rust + React + SQLite + 多重提供商 AI）个人知识桌面应用——寻找可借用的创意。Cognia在Wiki编译、Wiki编译、RAG、OCR、ingestion/dedup和Twin蒸馏方面已经更强，所以这些都没有被抄袭。还有四个真正的间隙，作为四个独立可运输阶段（优先重复使用;标准门禁上每个阶段结束时为绿色）。

## 决策

### 第一阶段 — 网页阅读器质量（`lib/web/reader/`）

`web_fetch` + Twin URL 之前的吸收是浅层的 Cheerio 文本提取。我们增加了一个多层读卡器，全部安装在一个注入`fetchImpl`后面，这样它在桌面端CORS-free，在浏览器中会降级：

1. **平台抓取器**按主机名键号——WeChat（`#js_content`）、X/Twitter（公共FxTwitter API）、YouTube（InnerTube `ytInitialPlayerResponse` →字幕文字记录）。没有 yt-dlp。
2. **Jina Reader（`r.jina.ai`）回退——仅在局部提取empty/too稀薄（JS-rendered SPA）时使用，因此常见情况不会离开机器。**纯核心默认关闭**;渲染器主机启用了它。
3. **本地Cheerio**撤离是最后手段。

布线：`lib/claude/plugin-tool-ipc.ts:resolveWebToolDeps`现在设置`deps.fetchImpl` = `createProxyFetch()`（Tauri `proxy_http_request`）/ `pinnedFetch`（Capacitor）。重复使用了现有的Rust `proxy_http_request`（没有新Rust）。`htmlToMarkdown`被固定为处理内联元素，优先于块元素（`<p>`内部的链接正在丢失）。

### 第二阶段 — Wiki Lint（`lib/wiki/lint/`）

没有人审计`[[slug]]`链接CrossRefAgent插入。纯粹的no-AI通行重用`findDeadLinks`（`cross-ref-agent.ts`）用于断链，`collectReferencedSlugs`用于孤立链接（无入站链接的条目;自引用和非持久索引页不计入）。通过设置卡+定时`wiki-lint`执行者浮现。仅在Dexie上运行（网页模式可运行）。

### 第三阶段 — 注意力雷达（`lib/radar/`）

定期进行7维“信息饮食”报告（结论/一目了然/信息-饮食/潜意识/墓地/盲点/动作+主题云+局部计算热图）。**数据来源：现有存储**——长期记忆（已涂黑+重要性加权）+第四阶段捕获的项目——预先过滤并进行了OpenWiki-style重要性→删减→top-N通过。每个物品都经过模型前`hasNoLeakingPii`。LLM通过现有的 `buildUtilityLlmClient` + `extractJson`。**送货：桌面宠物**——新报告上的`use-pet-insight`预览泡泡 + 宠物控制台（`radar-panel.tsx`）中完整的“洞察”标签页，config/schedule折叠在面板中（无新的设置导航条目）。

### 第四阶段 — 内容捕获（`lib/capture/`，`components/capture/`）

OpenWiki-style确认气泡：剪贴板手表→候选者→通过倒计时→保存+异步富集（URL → Phase-1读取器，图像→ OCR）+源应用标签+SHA-256去压。捕获的物品会被输入雷达。第一方（不是插件——插件是沙箱的，没有窗口创建，也没有自由文本的宠物路径）。确认气泡是由一个小型捕获商店驱动的第一方应用内组件（`CaptureMount`在应用布局中）;Source-App 是新Rust `get_foreground_app` 命令。

**范围锁定（第四阶段）:** 始终在顶部的*透明*捕获窗口和全局快捷自动监听被推迟——应用内气泡显示确认UX，剪贴板投票watcher显示“复制时捕获”。`get_foreground_app` 返回 Windows 上的前景 **window title**（已验证的`GetWindowTextW`路径）和最前面的 **app name**，通过 `osascript` on macOS;精确的Windows可执行文件名需要额外的流程`windows`-crate功能，是后续的。

## 结构

仅附加的Dexie版本（每相一个）：**v95** `wikiLintResults`（每个示波器单例），**v96** `radarReports`，**v97** `capturedItems`。新设置：`AppSettings.attentionRadar`（`types/radar`）、`AppSettings.capture`（`types/capture`）、`ExternalBridgeSettings.wikiLintSchedule`。

## 后果

- Cognia 获得了个人知识循环（捕获→丰富→洞察）+ 维基健康，完全重用现有子系统（网页阅读器传输、用OCR、记忆、实用性LLM、宠物、调度器）。
- 雷达的强度取决于储memory/capture;新安装时会自动跳过（最小物品保护）。
- 后续改进：始终在顶部的透明捕获窗口 + 全局快捷键绑定;精确的Windows源代码检测;图像剪贴板捕捉;杂交BM25+密集`wiki_search`。
