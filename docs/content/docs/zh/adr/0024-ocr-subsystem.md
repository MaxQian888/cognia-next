---
title: "ADR 0024 — OCR 子系统"
description: "从图片和PDFs中提取跨壳文本。在一个`extract()` 接口后方有20 OCR 提供商，具备平台自动路由器、Dexie支持的结果缓存和PDF文本层快速路径。"
---

# ADR 0024 — OCR 子系统

> **状态**：2026-05-18 接受。2026-08-08 修订，修复运行时能力、路由、模型交付和本地传输。`paddle-ocr` 使用 `oar-ocr` 0.9.x + ONNX Runtime 的 PP-OCRv6。

## 背景

Cognia-Next 提供三个外壳——浏览器（静态导出）、Tauri 2.9 桌面和 Capacitor 7 移动端——目前用户获取图像文本的唯一方式是将其转发到多模态模型。这既昂贵又耗PDFs慢，且即使用户只想要文字，模型也必须作为OCR引擎运行。

系统需要一流的 OCR，无论是内嵌Composer（“从附件中提取文本”）还是代理驱动（“模型在对话中途决定读取截图”）。它还必须覆盖平台矩阵，同时不强迫用户选择单一提供商——离线场景用本地引擎，准确性关键时用云提供商，本地引擎不成熟时用回退链（没有MSIX的 Windows，没有 Tesseract的 Linux）。

## 决策

`lib/ocr/`下的新子系统只暴露一个`extract(input, deps)`入口点。每个提供商都插入同一个注册表;每个调用方——Composer菜单、`/ocr`斜杠命令 `ocr.extract`插件工具——都经过同一条调度路径，因此缓存、自动路由器和凭证查询都集中在同一个地方。

### 提供商矩阵（20）

| 类别 | 提供商 |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Document OCR cloud | `mistral-ocr`，`google-vision`，`aws-textract`，`azure-document-intelligence` |
| LLM 视觉云 | `anthropic-vision`，`openai-vision`，`gemini-vision` |
| 专业云 | `mathpix`，`ocr-space`，`abbyy-cloud`，`nanonets` |
| 飞书/Lark云 | `lark-basic` |
| 设备内 | `tesseract-wasm`，`tesseract-native`，`windows-media-ocr`，`apple-vision`，`mlkit-android`，`ocrs`，`paddle-ocr` |
| 自主持HTTP | `local-http` — 通用适配器，方言识别（Umi-OCR / PaddleOCR-Server）。用户固定，路由器从不自动选择 |

这三个LLM-vision 提供商（`anthropic-vision`、`openai-vision`、`gemini-vision`）会重复使用主 提供商 密钥环 条目，而不是请求第二个凭证。其他云的 提供商 将凭证存储在 密钥环 命名空间下`"ocr"`由 提供商 ID 键入。

### 自动布线

`lib/ocr/auto-router.ts:pickDefaultProvider`依次参考三个信号：

1. `UserOcrSettings.defaultProviderId`当它是具体ID（不是`"auto"`）且提供商已注册、启用且兼容shell时。
2. 仅从已就绪的本地候选链选择：macOS 为 `apple-vision` → `paddle-ocr`，Windows/Linux 为 `paddle-ocr`，移动端使用对应系统引擎，浏览器使用 `tesseract-wasm`。`ocrs` 与 `windows-media-ocr` 保留稳定 ID 供高级配置使用，但不会自动路由。
3. 当本地引擎不可用且凭证配置时，云端配置回退（默认`mistral-ocr`）。

路由器是纯粹的——它接受注册表、设置、平台标签、可选的准备探针（`isReady`）和可选的 凭证 探针（`hasCredentials`）。这三者都经过单元测试的 stub，确保桌面完全覆盖，不会启动真正的后端。

### 输出模式

每页Markdown + 纯文本 + 可选的结构化块，带有边界框和置信度。云文档提供商（`google-vision`、`aws-textract`、`azure-document-intelligence`）填充`blocks`数组;LLM-vision 提供商（`anthropic-vision`等）保持空位。Mistral OCR返回其原生Markdown;合成的`text`字段会剥离Markdown装饰。`combinedMarkdown`用`\n\n---\n\n<!-- page N -->`分隔线连接页面，因此多页渲染PDFs清晰边界。

### PDF策略

`lib/ocr/pdf-router.ts:extractPdf`分两轮运行：

1. **文本层快速路径。** 每个范围内的页面通过`pdfjs-dist` `page.getTextContent()`。包含≥16个非空白字符的页面按原样直接已接受——无OCR成本。
2. **OCR 回退.** 文本层实际上为空的页面会以220 DPI（可配置）光栅化，并通过OCR 提供商路由。

这样可以保证数字PDFs的自由和扫描PDFs准确。路由器也很DI-friendly：测试通过伪造`loadPdf`返回预留页面，所以路由逻辑完全覆盖，无需真正的pdfjs Worker。

### 缓存

`lib/db/ocr-results.ts` 增加了一个Dexie表 `ocrResults`（schema v36），由 `sha256(file) | providerId | sortedLangs.join(",")` 键入。同一张图片 + + 提供商 + 语言组合从不重复使用。设置会暴露一个全局“清除缓存”按钮和每个提供商的变体。TTL 清除通过 `purgeOcrCacheOlderThan(ttlMs)` 实现，但尚未连接到 cron 上——用户可以手动清除。

### 触发因素

| 接口 | 路径 |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Composer菜单 | 在任何image/PDF附件上`components/chat/composer/ocr-menu.tsx` + 悬停下拉选单——“提取文本到输入”或“查看提取文本”。 |
| 斜杠命令 | `/ocr <file or attachment_id> [--provider auto\|<id>] [--lang en,zh] [--pages 1-3] [--format markdown\|text\|blocks]`。处理器 `lib/slash-commands/actions/ocr.ts`。 |
| 插件代理工具 | `plugins/ocr/src/index.ts`寄存器`ocr.extract` — 单个工具，提供商 ID 是一个参数。 |

### 原生绑定（Rust）

`src-tauri/src/ocr/mod.rs`揭示了四个Tauri 命令：

- `ocr_extract_native(payload)` — 通过`payload.backend`（`tesseract` / `windows-media-ocr` / `apple-vision` / `ocrs` / `paddle-ocr`）向注册`NativeBackend`发送调度。
- `ocr_msix_status()` — 报告运行中的 Windows 进程是否具有MSIX包身份。前端在启动时缓存此信息，并用它门禁 `windows-media-ocr`自动路由器。
- `ocr_model_status(backend)` — 为下载自身权重（`ocrs`、`paddle-ocr`）的后端报告每个文件的安装状态。返回`{ installed, files[], total_bytes, model_dir }`;自动路由器会参考此项以跳过尚未下载模型的后端。
- `ocr_download_model(backend, variant, request_id)` — 将固定摘要的模型文件流式传输到版本化目录，使用临时文件和原子替换，恢复损坏文件、按变体去重并发下载，并可通过 `ocr_cancel_model_download(request_id)` 取消。
- `ocr_http_fetch` / `ocr_http_cancel` — `local-http` 的桌面宿主传输。禁止重定向以及公网、链路本地和元数据地址；回环地址默认允许，私有/LAN 端点必须对当前精确端点显式确认。

真实绑定搭载了四个Cargo feature（全部默认关闭，以确保标准构建保持快速;发布流水线开启`ocr-ocrs`和`ocr-paddle`），此外还有一个始终为其平台开启的目标门控后端：

- `ocr-tesseract` → 本机安装的 Tesseract CLI。
- `ocr-windows` 保留 `windows-media-ocr` 稳定 ID，但 Windows.Media.Ocr 尚未实现，因此始终报告不可用。
- `apple-vision`（无功能;目标被macOS时编译）→ Vision.framework 的`VNRecognizeTextRequest`，通过`objc2-vision`绑定进行——无sidecar，无模型下载。
- `ocr-ocrs` → `ocrs` + `rten`（pure-Rust，无系统分级）。
- `ocr-paddle` → `oar-ocr` 0.9.x + ONNX Runtime，可选 PP-OCRv6 Small（默认）或 Tiny。标准桌面构建默认启用此特性，发布 CI 会验证真实绑定；`ocr-ocrs` 仍为高级可选特性。

当某个功能脱离时，注册表会宣布一个返回`MissingBinding(id)`的`PlaceholderBackend`。TS层接口该功能作为`OcrError("unsupported_shell")`，自动路由器会切换到下一个候选。

### 模型分布

`ocrs`和`paddle-ocr`会分别向安装程序添加~12–17 MB权重。相反，捆绑包出货时没有权重，设置UI在后端会显示“下载模型”按钮。文件落`<app_data>/cognia/ocr/<backend>/`，并通过`ocr_model_status`向自动路由器公告。许可说明：

- `ocrs`检测+识别模型——Apache-2.0（基于HierText训练，数据集的权重CC-BY-SA 4.0;权重本身为Apache-2.0）。
- PP-OCRv6 模型——Apache-2.0。

下载清单固定每个文件的 SHA-256，只有实时摘要校验通过才会报告就绪。Paddle 的 `v6-small` 与 `v6-tiny` 使用独立目录；旧的未版本化 PP-OCRv5 文件不会被删除，而会报告为非活动旧版文件。

### 本地 HTTP 方言

`local-http` 完全由 `OCR_PARAMETER_SCHEMAS` 配置。旧版明文 token 会迁移到 OCR 密钥环并从设置删除。Umi-OCR 会查询 `/api/ocr/get_options`，把 BCP-47 语言提示映射为服务端实际公布的 `ocr.language` 模型值，并保留响应中的 `end` 排版分隔符。Paddle 方言使用 PaddleOCR 3.x `/ocr` 请求与 `result.ocrResults[].prunedResult` 响应，同时兼容旧 hubserving 字典/元组响应。语言提示不代表所有本地模型实际消费它；`ocrs` 是仅支持拉丁文字的早期预览，Tesseract WASM 需要下载 traineddata，除非 `langPath` 指向本地资源。

### 测试策略

原生后端被隔离在`NativeBackend`特性后面，因此CI运行模拟实现。真实绑定存在于排除在覆盖目标之外的 `#[cfg(target_os = …)]` 块后面。TS-side `__set*Invoker` 辅助工具允许单元测试注入预设调用器而无需实际的 Tauri 运行时。

### 记录文件

- `lib/ocr/` — 公共接口、提供商、自动路由器、PDF路由器、缓存。
- `lib/db/ocr-results.ts` — Dexie行 + CRUD。
- `lib/slash-commands/actions/ocr.ts` — `/ocr`解析器+调度器。
- `components/settings/ocr/` — `settings.tabs.ocr`下的专用设置部分。
- `components/chat/composer/ocr-menu.tsx`、`ocr-result-bubble.tsx`、`attachment-preview.tsx`——Composer整合。
- `hooks/use-ocr.ts` — 用状态包裹`extract()`，React hook。
- `plugins/ocr/` — 第一方插件暴露`ocr.extract`。
- `src-tauri/src/ocr/` — 原生命令 接口+后端特征。

## 考虑的替代方案

- **单一超级提供商（例如仅Mistral OCR）。** 已拒绝 — 项目跨越三种运行壳，采用不同的连接假设;用户要求全面覆盖。
- **按提供商插件。** 已拒绝 ——每个提供商都访问相同的注册表和缓存，自动路由器需要稳定的枚举。将提供商放入单独的插件包会使调度路径分段。
- **没有设备内引擎。** 已拒绝 ——没有稳定网络的移动和Linux桌面仍需OCR;捆绑Tesseract WASM成本~2 MB，但为每个shell提供了离线能力。

## 后果

- 新的顶层子系统（`lib/ocr/`）加上一个新的Dexie表。
- 设置页面延续了`components/settings/search/`的先例：为拥有自己凭证 接口的non-LLM 提供商家族设立专门的部分。
- Tauri 会获得两个新 命令 + 一个新状态（`NativeOcrRegistry`）。三个可选的 Cargo 功能控制哪些本地绑定被关联。
- 当tesseract.js + pdfjs-dist 被拉入 Composer 路由时，前端捆绑包会增长。两者都已经声明为依赖，但 OCR 功能是第一个导入tesseract.js的——Worker 资产需要通过构建脚本（`scripts/copy-ocr-assets.mjs`）复制到 `public/ocr/` 中，才能运行WASM 提供商。
