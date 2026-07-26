---
title: 个人知识捕获
description: ADR-0060 一并引入的三个模块 —— 捕获（按指纹去重、由网页阅读器或 OCR 富化的剪藏）、网页阅读器本身（定制抓取器优先于通用抽取），以及注意力雷达（对已捕获内容的周期性 LLM 报告）。
---

# 个人知识捕获

<Status variant="beta">Beta · ADR-0060 · capturedItems v97 · radarReports v96</Status>

<TLDR>
  三个模块只有放在一起才成立。**捕获**把一个已确认的候选变成持久化条目 ——
  按指纹去重、富化、保存（`lib/capture/capture-manager.ts`）。
  **网页阅读器**是富化环节遇到 URL 时调用的东西，它会在通用抽取**之前**先试定制抓取器，
  因为对少数几个站点而言，专门写的抓取器完胜通用抽取。
  **注意力雷达**随后按间隔对累积的条目跑 `collect → generate → persist`，产出一份 LLM 报告 ——
  并带有守卫：当新材料不足以值回 token 时，整轮直接跳过。
</TLDR>

<StatGrid>
  <Stat label="Dexie 表" value="2" hint="capturedItems v97 · radarReports v96" />
  <Stat label="平台抓取器" value="3" hint="微信 · X/Twitter · YouTube" />
  <Stat label="雷达阶段" value="3" hint="collect → generate → persist" />
  <Stat label="富化路径" value="2" hint="URL 阅读器 · OCR" />
</StatGrid>

设计动机见 [ADR-0060](../adr/0060-personal-knowledge-capture-and-insights) —— 三者是在同一个决策中一并引入的。

## 捕获：指纹、富化、保存

`captureManager` 接收一个已确认的 `CaptureCandidate`，产出持久化的 `CapturedItem`。
表上的指纹索引（`capturedItems: "&id, capturedAt, kind, sourceApp, fingerprint"`）
让去重成为一次查找而非一次扫描 —— 同一段内容剪藏两次不会产生两条记录。

富化是剪藏摆脱「一串裸文本」的地方：URL 走网页阅读器，图片走 OCR。
`enrich.ts` 以注入式 `EnrichDeps` 接收依赖，生产接线由 `buildEnrichDeps()` 提供 ——
因此 manager 无需网络、也无需 OCR 引擎即可测试。

```
lib/capture/
  capture-manager.ts   # 去重 → 富化 → 保存
  detect.ts            # detectKind · buildTextCandidate
  enrich.ts            # enrichCandidate · buildEnrichDeps
lib/db/captured-items.ts · types/capture/ · stores/capture/ · hooks/capture/
components/capture/ · src-tauri/src/capture/
```

## 网页阅读器：定制抓取器优先

`scrapePlatform`（`lib/web/reader/dispatch.ts`）会在 `web_fetch` 的通用「抓取 + 抽取」路径**之前**被尝试。
对微信文章、X/Twitter 长帖与 YouTube 页面，专门编写的抓取器能返回通用抽取无法企及的干净 Markdown。
其余站点则返回 `null`，调用方回落到本地抽取 —— 若结果仍过于稀薄，再回落到 Jina。

这个先后顺序就是全部路由规则：定制 → 本地通用 → 远程兜底，
每一步之所以被触达，都是因为上一步主动弃权。

```
lib/web/reader/
  dispatch.ts      # 主机名 → 抓取器路由
  jina.ts          # 远程兜底
  types.ts
  platform-scrapers/  wechat.ts · x-twitter.ts · youtube.ts
lib/web/web-tools-core.ts
packages/document/.../html-parser.ts
```

## 注意力雷达：带守卫，而非无脑定时

`radar-runner.ts` 编排 `collect → generate → persist`，并且会拒绝跑得比应该的更频繁。
两个守卫沿用 OpenWiki 的行为：可用条目少于 `RADAR_MIN_ITEMS` 时跳过；
上一份报告比 `intervalDays` 更新时跳过 —— 除非调用方传入 `force`。
它解析模型的方式与会话标题生成器一致，都经由 `buildUtilityLlmClient()`，
因此一份后台报告绝不会悄悄消耗主聊天提供方的额度。

`prefilter.ts` 是最值得一读的部分：`computeImportance()` 为条目打分，
`ngrams()` + `jaccard()` 驱动 `dedupeSimilar()`，`smartPreFilter()` 裁剪到 `maxItems` ——
近重复的捕获在抵达模型**之前**就被折叠，而不是之后。

```
lib/radar/
  radar-runner.ts     # collect → generate → persist，含守卫
  collect.ts          # 汇集条目 + computeHeatmap
  prefilter.ts        # 重要度 · n-gram · jaccard · 去重 · 裁剪
  generate.ts  prompts.ts
  radar-cron-bridge.ts   # 调度器调用的入口
lib/db/radar-reports.ts · types/radar/
components/pet/console/radar-panel.tsx · hooks/pet/use-pet-insight.ts
```

报告呈现在宠物控制台上，这也是 `use-pet-insight.ts` 位于宠物侧而非 `lib/radar` 的原因。

## 相关文档

<Cards>
  <Card title="ADR-0060" href="../adr/0060-personal-knowledge-capture-and-insights" description="覆盖三个模块的决策记录" />
  <Card title="OCR" href="./ocr" description="另一条富化路径" />
  <Card title="桌面宠物" href="./desktop-pet" description="雷达报告的呈现处" />
  <Card title="调度器" href="./scheduler" description="驱动雷达 cron 桥的地方" />
</Cards>
