# AnyDoc 作为 Cognia 文档解析引擎的可行性评估

> 调研日期：2026-08-17  
> 目标版本：Firecrawl AnyDoc `v0.1.9`（源码快照 `e754e1d`）  
> 结论：**技术上可进入隔离 PoC，但当前不应直接进入生产。只有多端构建、内存/取消、离线缓存和 `ProcessedDocument` 映射门槛全部通过后，才适合作为本地 Office/旧格式补充；不应替换现有统一文档层、PDF/OCR 链路或结构化解析结果。**
> 实施记录：已完成默认关闭的受限代码接入——shell 必须设置 `NEXT_PUBLIC_ENABLE_ANYDOC_LEGACY_OFFICE=true`，或调用方通过 `ProcessingOptions.anyDoc.enabled` 显式启用；启用后仅对内容签名匹配的 legacy `.doc/.ppt` 使用 Markdown-only 路由。实现固定 WASM `0.1.9`，采用单任务 dedicated Worker、单文件 10 MiB/总保留 20 MiB admission、caller-owned buffer copy、硬取消/timeout 和 OOXML mismatch 回退。开启 build flag 的 production static export 已验证会发出并 precache 6,753,527-byte WASM；关闭时不会把该大文件加入 precache。实体移动设备、离线生命周期和 80 份金标 corpus 仍是 rollout 认证项，未通过前不得由 shell 打开 feature gate。

## 1. 项目识别

“AnyDoc”至少对应三个容易混淆的项目：

| 名称                                                                                                                                                                                       | 实际用途                                                                                      | 与本次需求的关系                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| [Firecrawl AnyDoc](https://github.com/firecrawl/anydoc)                                                                                                                                    | 纯 Rust 的 Office/EPUB/CSV/文本型 PDF → GFM 转换器，提供 Rust、Node、Python、WASM 和 CLI 接口 | **最可能是本次所指项目**：定位、输出和 2026-08 新近发布均与“文档解析引擎”吻合 |
| [Hyland OCR for AnyDoc](https://docs.hyland.com/r/AnyDoc/OCR-for-AnyDoc/Foundation-23.1/OCR-for-AnyDoc-Programming-Reference-Guide/Overview/Introduction?contentId=TU24SgF2yNvhtnRa9vxLGw) | 商业化表单扫描、OCR、校验、批处理产品，需要 Hyland 许可与专用部署                             | 是同名企业产品，不是可嵌入 Cognia 的开源库                                    |
| [CVPR 2026 AnyDoc](https://openaccess.thecvf.com/content/CVPR2026/papers/Lin_AnyDoc_Enhancing_Document_Generation_via_Large-Scale_HTMLCSS_Data_Synthesis_and_CVPR_2026_paper.pdf)          | HTML/CSS 文档生成研究                                                                         | 生成而非解析，与本需求无关                                                    |

以下“AnyDoc”均指 `firecrawl/anydoc`。其官方仓库明确称它由 Firecrawl 构建并用于 Firecrawl Parse；Python 包刻意命名为 `firecrawl-anydoc`，因为 PyPI 上裸名 `anydoc` 已被无关项目占用（[仓库 README](https://github.com/firecrawl/anydoc/blob/e754e1d33a1a540ebc9226e36f11d3f401852c9e/README.md)、[Python 包配置](https://github.com/firecrawl/anydoc/blob/e754e1d33a1a540ebc9226e36f11d3f401852c9e/python/pyproject.toml)）。

## 2. 核心判断

AnyDoc 的强项是：在 CPU 上、本地、无外部服务地把多种 Office 文档统一转成结构较好的 Markdown，并声明支持 Cognia 当前处理较弱的旧二进制 `.doc/.ppt`，同时提供浏览器 WASM 和 Tauri 可调用的 Rust crate。其共享 `Document` 模型还保留段落、列表、表格跨行跨列、脚注和内嵌资源字节（[公共模型](https://github.com/firecrawl/anydoc/blob/e754e1d33a1a540ebc9226e36f11d3f401852c9e/src/model/mod.rs)、[Node 类型定义](https://github.com/firecrawl/anydoc/blob/e754e1d33a1a540ebc9226e36f11d3f401852c9e/node/index.d.ts)）。这些是进入 PoC 的理由，不是生产适配已经成立的证据。

但它不是 OCR、版面分析或通用 IDP 引擎：

- 扫描件/纯图片 PDF 不支持；混合 PDF 中需要 OCR 的页面只被跳过并写日志，剩余页仍可能成功返回 Markdown（[PDF 适配代码](https://github.com/firecrawl/anydoc/blob/e754e1d33a1a540ebc9226e36f11d3f401852c9e/src/formats/pdf.rs)）。
- 它没有公式识别模型，也不把数学公式转 LaTeX；电子表格路径读取显示值而非公式表达式，DrawingML 图表也只读取缓存显示字符串并忽略公式引用（[Excel 解析器](https://github.com/firecrawl/anydoc/blob/e754e1d33a1a540ebc9226e36f11d3f401852c9e/src/formats/sheet/mod.rs)、[图表提取](https://github.com/firecrawl/anydoc/blob/e754e1d33a1a540ebc9226e36f11d3f401852c9e/src/shared/drawingml.rs)）。
- 非 PDF 的公共模型只有阅读顺序块，没有页码、坐标、原始样式细节或文档元数据；PDF 又绕过该模型直接输出 Markdown（[入口实现](https://github.com/firecrawl/anydoc/blob/e754e1d33a1a540ebc9226e36f11d3f401852c9e/src/lib.rs)）。

因此候选定位应是 **“Office → 规范化 Markdown 的本地解析器”**，而不是 Cognia 的唯一“文档解析引擎”。“规范化结构”只能描述 AnyDoc 自身模型，不能直接等同于 Cognia 的 `ProcessedDocument`。

## 3. 架构与运行方式

处理链路为：内容特征检测 → 每种格式的 Rust 前端解析器 → 共享 `Document`（blocks、notes、assets）→ 单一 GFM 序列化器；PDF 例外，直接委托 `pdf-inspector` 输出 Markdown（[架构说明](https://github.com/firecrawl/anydoc/blob/e754e1d33a1a540ebc9226e36f11d3f401852c9e/README.md#how-it-works)）。依赖主要是 `calamine`、`cfb`、`quick-xml`、`zip`、`encoding_rs` 和 `pdf-inspector`，没有模型或网络客户端依赖（[Cargo.toml](https://github.com/firecrawl/anydoc/blob/e754e1d33a1a540ebc9226e36f11d3f401852c9e/Cargo.toml)）。

可用集成面：

| 运行面          | 包/API                                                                | 关键约束                                                                                                                                                                                                                                                                                                            |
| --------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rust            | crates.io `anydoc`; `to_markdown`、`to_markdown_bytes`、`to_document` | Rust ≥ 1.88；最适合 Tauri 原生命令，但只能覆盖桌面壳                                                                                                                                                                                                                                                                |
| Node            | npm `@firecrawl/anydoc`; Promise API；CLI 同包发布                    | Node ≥ 20；N-API 原生插件，不可直接进入 Next.js 浏览器静态包；支持 macOS x64/arm64、Windows x64、Linux glibc/musl x64/arm64（[package.json](https://github.com/firecrawl/anydoc/blob/e754e1d33a1a540ebc9226e36f11d3f401852c9e/node/package.json)）                                                                  |
| Browser/WASM    | npm `@firecrawl/anydoc-wasm`; `toMarkdownBytes`、`toDocument`         | 调用同步、单线程；官方要求在需保持 UI 响应时放入 Worker（[WASM 文档](https://github.com/firecrawl/anydoc/blob/e754e1d33a1a540ebc9226e36f11d3f401852c9e/wasm/README.md)）。`v0.1.9` npm tarball 为约 3.0 MB，解包后单个 WASM 文件约 6.8 MB（[npm 包](https://www.npmjs.com/package/@firecrawl/anydoc-wasm/v/0.1.9)） |
| Python          | PyPI `firecrawl-anydoc`; Python ≥ 3.10；释放 GIL                      | 适合 sidecar/服务，不是 Cognia 主前端的最短路径（[Python 文档](https://github.com/firecrawl/anydoc/blob/e754e1d33a1a540ebc9226e36f11d3f401852c9e/python/README.md)）                                                                                                                                                |
| CLI/Agent Skill | `npx @firecrawl/anydoc`，支持 stdin/stdout/文件                       | 适合开发工具或 agent 临时读取，不适合作为应用内稳定 IPC 合约                                                                                                                                                                                                                                                        |
| 托管服务        | Firecrawl `POST /v2/parse` 或 `/scrape`                               | 是独立商业服务，不等同于开源库；能为 PDF 增加 OCR、JSON/schema、摘要等能力，文件上限 50 MB，并需要 API key（[官方 Parse 文档](https://docs.firecrawl.dev/features/parse)）                                                                                                                                          |

本地库完全 CPU 运行，无 GPU、模型下载、API key 或系统级 LibreOffice/Pandoc 依赖。官方没有给出最低 CPU/RAM；其固定资源上限允许单个压缩条目解压至 128 MiB、单文档总解压 512 MiB、内嵌资源累计 128 MiB，因此“输入文件很小”不代表峰值内存很小（[安全上限源码](https://github.com/firecrawl/anydoc/blob/e754e1d33a1a540ebc9226e36f11d3f401852c9e/src/package/limits.rs)）。

## 4. 能力边界

### 4.1 格式

官方支持 Word `.doc/.docx/.docm`，PowerPoint `.ppt/.pps/.pot/.pptx/.pptm/.ppsx/.ppsm`，Excel `.xls/.xlsx/.xlsm/.xlsb`，OpenDocument `.odt/.ods/.odp`，以及 `.rtf/.epub/.csv/.pdf`（[支持矩阵](https://github.com/firecrawl/anydoc/blob/e754e1d33a1a540ebc9226e36f11d3f401852c9e/README.md#supported-formats)）。官方“14 formats”是其基准测试所计的格式/容器口径，不应理解为只支持 14 个扩展名；多个宏、放映和模板扩展被归入同一解析器。

未覆盖 Cognia 已支持的 Markdown、HTML、JSON、代码、纯文本和 TSV。因此它无法单独替代 `@cognia/document` 的完整入口。

### 4.2 语言与编码

AnyDoc 没有 OCR 意义上的“支持语言列表”：对于含文本层的 Unicode Office 文档，语言通常不是识别变量。旧格式解析器显式处理 UTF-16 及多种 legacy code page，包括 Shift-JIS、GBK、Big5、EUC-KR、Windows-1250/51/53/54/55/56/57/58 和 Thai 874；CSV 按 BOM → UTF-8 → Windows-1252 退化（[DOC 编码处理](https://github.com/firecrawl/anydoc/blob/e754e1d33a1a540ebc9226e36f11d3f401852c9e/src/formats/doc/mod.rs)、[RTF 编码表](https://github.com/firecrawl/anydoc/blob/e754e1d33a1a540ebc9226e36f11d3f401852c9e/src/formats/rtf/tables.rs)、[CSV 解码](https://github.com/firecrawl/anydoc/blob/e754e1d33a1a540ebc9226e36f11d3f401852c9e/src/formats/csv.rs)）。这意味着 CJK 文本“应可解码”，但不是经过公开多语言准确率基准验证的 OCR 能力。

### 4.3 结构、表格、图片与版面

- 可保留标题、粗体/斜体/删除线、代码块、链接/内部引用、嵌套与任务列表、脚注/尾注、引用和演讲者备注（[功能说明](https://github.com/firecrawl/anydoc/blob/e754e1d33a1a540ebc9226e36f11d3f401852c9e/README.md#features)）。
- `Document` 表格模型原生表示 header rows、row/col span 和 data/layout table；但 GFM 没有合并单元格语法，序列化时被跨越位置会输出空格，合并语义只有调用 `toDocument` 时完整保留（[表格模型](https://github.com/firecrawl/anydoc/blob/e754e1d33a1a540ebc9226e36f11d3f401852c9e/src/model/table.rs)、[GFM 表格渲染](https://github.com/firecrawl/anydoc/blob/e754e1d33a1a540ebc9226e36f11d3f401852c9e/src/render/markdown/table.rs)）。
- 图片和嵌入对象在 Markdown 中只呈现 alt text；原始字节、MIME 和来源 part 位于 `Document.assets`。PDF 不支持 `toDocument`，因此该资产模型也不适用于 PDF（[Node API](https://github.com/firecrawl/anydoc/blob/e754e1d33a1a540ebc9226e36f11d3f401852c9e/node/README.md#images-and-embedded-objects)）。
- DOCX/PPTX 可从缓存值提取图表标题、序列和 SmartArt 文本，但这不是视觉理解；未见对页面几何、复杂浮动布局、批注/修订、手写、印章或表单字段的公共结构化输出。
- 文本型 PDF 使用 `pdf-inspector` 的内部文本层与阅读顺序；扫描页需要另接 Cognia OCR 或托管 Firecrawl Parse。

### 4.4 公式

应把公式能力视为 **不支持**：没有公式 OCR、LaTeX 输出或公共 math block；电子表格只输出已缓存/计算后的单元格值，图表公式引用明确被忽略。若合同、论文和报表中的数学公式是验收项，AnyDoc 不能通过该项。

## 5. API、错误与扩展性

本地 API 很小：按路径或 bytes 转 Markdown，或按 bytes 取得 `Document`；格式通常按内容签名检测，CSV 必须由扩展名或显式 format 指定。错误类型区分 `unsupported`、`malformed`、`encrypted`、`resourceLimit`、`missingPart` 和路径读取 `io`（[Rust API 与错误](https://github.com/firecrawl/anydoc/blob/e754e1d33a1a540ebc9226e36f11d3f401852c9e/src/lib.rs)、[Node 错误契约](https://github.com/firecrawl/anydoc/blob/e754e1d33a1a540ebc9226e36f11d3f401852c9e/node/README.md#errors)）。

需要注意：恢复、跳过内容和混合 PDF 缺页通过 Rust `log` 的 debug/warn 报告，且官方明确声明日志不是稳定 API；这与 Cognia 可展示、可测试的 `ParseDiagnostic` 契约不等价（[crate 文档](https://github.com/firecrawl/anydoc/blob/e754e1d33a1a540ebc9226e36f11d3f401852c9e/src/lib.rs)）。

扩展性属于“改源码/向上游贡献”，不是插件式：`model` 公开，但 `formats` 和 Markdown renderer 是私有模块，资源限制也明确不可配置。新增格式或自定义序列化策略需要 fork/上游 PR，不能注册一个第三方 parser 即完成（[crate 模块边界](https://github.com/firecrawl/anydoc/blob/e754e1d33a1a540ebc9226e36f11d3f401852c9e/src/lib.rs)、[固定上限说明](https://github.com/firecrawl/anydoc/blob/e754e1d33a1a540ebc9226e36f11d3f401852c9e/src/package/limits.rs)）。

## 6. 安全、隐私与许可

本地库：

- MIT License，允许商业使用、修改和再分发，但需保留版权与许可文本；无 copyleft 或按量许可（[LICENSE](https://github.com/firecrawl/anydoc/blob/e754e1d33a1a540ebc9226e36f11d3f401852c9e/LICENSE)）。
- 转换在进程内完成且依赖树中无外部服务，浏览器 demo 也明确为本地 WASM，不上传文件，因此适合 Cognia 的 local-first/privacy 定位（[WASM demo 说明](https://github.com/firecrawl/anydoc/blob/e754e1d33a1a540ebc9226e36f11d3f401852c9e/README.md)）。
- 对 ZIP bomb、XML 深度/节点、表格展开、二进制记录和资产累计设置固定上限；仓库还包含每格式 fuzz target、fixture snapshot 和 mutation robustness 测试（[limits](https://github.com/firecrawl/anydoc/blob/e754e1d33a1a540ebc9226e36f11d3f401852c9e/src/package/limits.rs)、[fuzz 目录](https://github.com/firecrawl/anydoc/tree/e754e1d33a1a540ebc9226e36f11d3f401852c9e/fuzz)、[测试说明](https://github.com/firecrawl/anydoc/blob/e754e1d33a1a540ebc9226e36f11d3f401852c9e/README.md#development)）。
- 截至调研日，官方仓库未提供独立 `SECURITY.md`、第三方安全审计或长期安全支持承诺；这不等于不安全，但不应把 fuzz/上限当作审计替代品。

托管 `/parse` 是另一套风险模型：原始文件会上传至 Firecrawl，OCR/结构化 JSON 等能力按商业 API 提供；官方称支持 Zero Data Retention，但企业敏感文档仍需单独完成 DPA、数据地域、保留、分包商和费用评审（[Parse 文档](https://docs.firecrawl.dev/features/parse)、[官方发布说明](https://www.firecrawl.dev/blog/introducing-parse)）。由于 Cognia 无法在“解析前”对二进制原文做可靠 PII 脱敏，托管模式不应成为默认解析后端，只能是明确 opt-in 的云增强能力。

## 7. 成熟度与基准可信度

项目很活跃，但非常年轻：GitHub 仓库创建于 2026-08-03；截至 2026-08-17 为 `v0.1.9`，从 `v0.1.1` 到 `v0.1.9` 的九个版本都集中在约十天内，尚无 `1.0` 稳定承诺（[GitHub 元数据](https://api.github.com/repos/firecrawl/anydoc)、[官方 Releases](https://github.com/firecrawl/anydoc/releases)）。多语言绑定、跨平台预编译包、CI、snapshot/robustness/fuzz 覆盖是正面信号；快速版本迭代和当前大量开放 issue/PR 则意味着 API/行为漂移风险高，应固定精确版本并维护回归语料。

官方一方基准称：100 份真实文档、14 种格式，AnyDoc 中位转换 4.4 ms、质量总分 81，并在其逐格式对比中领先（[官方 benchmark](https://github.com/firecrawl/anydoc/blob/e754e1d33a1a540ebc9226e36f11d3f401852c9e/README.md#benchmark)）。这些数字只能作为候选筛选信号，不能直接作为 Cognia 采购/替换依据：

1. 语料为 Firecrawl 自有且不公开，无法复现；PDF 明确不在该 benchmark 范围（[benchmark harness](https://github.com/firecrawl/anydoc/blob/e754e1d33a1a540ebc9226e36f11d3f401852c9e/bench/README.md)）。
2. 质量由 Claude Sonnet 5 结合最多前六页渲染图进行盲评，不是人工标注的字段/结构准确率。
3. 各工具总分覆盖的格式集合不同；官方自己也说明逐格式表才相对公平。
4. AnyDoc 和 Python 库排除了进程启动时间，而 CLI 工具包含启动时间；性能结果不等同于浏览器 WASM、移动设备或 Tauri IPC 的端到端时延。
5. 没有 OCR、公式、CJK、超大文档、恶意输入或内存峰值的第一方公开基准。

## 8. 与 Cognia 当前架构的适配

Cognia 当前 `packages/document/src/` 将文件规范化为 `ProcessedDocument`，不只输出文本，还保留 `metadata`、`parseResult`、按页/幻灯片/工作表/章节的 `parseSummary`、可展示的 `parseDiagnostics`，并服务 Twin ingest、向量库、Canvas 和预览 UI（[现有文档处理说明](../content/docs/en/data/document-processing.mdx)、[`ProcessedDocument` 类型](../../packages/document/src/types.ts)）。当前路径还具有 AnyDoc 不提供或会退化的能力：

- PDF：页数、逐页文本、几何 text items、outline、annotation、metadata，以及 Cognia native parse/OCR fallback。
- Excel：二维结构、sheet statistics、merged cell 信息和显示值。现有文档说明要求保留公式，但实现中的 `sheet_to_json` 只落入 `ExcelSheet.data` 基础值，`ExcelSheet` 类型也没有公式字段，因此当前 `ProcessedDocument` **实际并不保留公式表达式**；这是既有能力缺口，不能当成 AnyDoc 的非回归基线（[`office-parser.ts`](../../packages/document/src/parsers/office-parser.ts)、[`types.ts`](../../packages/document/src/types.ts)）。
- Word：HTML、解析 message/diagnostic、图片、metadata、headings。
- Presentation/EPUB：按 slide/chapter 的稳定 segment，可直接驱动 UI 导航和 chunking。

这些差距已有直接的上游信号：PDF 页边界/逐页输出仍是开放需求（[#99](https://github.com/firecrawl/anydoc/issues/99)、[#62](https://github.com/firecrawl/anydoc/issues/62)），`toDocument()` 的 worksheet identity/source coordinates 仍不完整（[#10](https://github.com/firecrawl/anydoc/issues/10)），而 PPT/PPTX 的稳定 slide boundary 仍在开放 PR 中（[#95](https://github.com/firecrawl/anydoc/pull/95)）。因此不能假设稍后可从 Markdown 无损反推 Cognia 当前的 page/sheet/slide segment。

直接把所有分支替换为 `toMarkdownBytes()` 会丢失这些契约，并把“部分内容被跳过”从结构化 diagnostic 降为不可依赖的日志。因此若 PoC 成功，AnyDoc 也只能放在现有统一入口**内部**，而不是让上游直接依赖 AnyDoc API。

这里存在一个必须先解开的映射缺口：`toDocument()` 只返回 blocks/notes/assets，不返回 Markdown；`toMarkdownBytes()` 返回 Markdown，但没有通用 `Document`。若同一文件同时调用两者，就会完整解析两次；若 Cognia 自己为 `Document` 编写序列化器，又会与 AnyDoc 私有 GFM renderer 产生行为漂移。与此同时，AnyDoc `Document` 无法直接填入当前 `parseResult` union：Word 需要 HTML/messages/images/metadata/headings，Presentation 需要 slides/metadata，generic assets/notes 也没有无损容器。Phase 0 必须在以下两条路中明确选择并验证：

1. **旧格式 Markdown-only 路由**：经内容签名确认为 legacy `.doc/.ppt` 后，只调用一次 `toMarkdownBytes()`。`ProcessedDocument.type` 仍是 `word/presentation`（表示格式族而非引擎），`content` 与 `embeddableContent` 都使用 Markdown，`metadata` 填入 size/lineCount/wordCount 以及 `{ parseEngine: "anydoc", parseEngineVersion: "0.1.9", parseMode: "markdown-only" }`，`parseResult` 留空。`ParseSummary.parser` 仍按格式族填 `word/presentation`，`structure.segmentCount = 1`，`quality.status = "partial"`，`quality.reason` 明确说明无结构化 Word/Presentation result；成功结果附一条 `parser_info` diagnostic 记录同一事实。若调用方要求 chunks，继续使用现有 `chunkDocument` 处理 Markdown。它只相对当前失败基线增加可读文本，不声称保留 Word/PPT 结构契约。
2. **新增通用结构结果**：扩展 `ProcessedDocument.parseResult` 和下游消费者以容纳 AnyDoc model，并定义 Markdown 生成、assets/notes、版本化和兼容策略。这是独立架构改动，不属于“换一个 parser”范围。

推荐优先级：

| 场景                                                         | 建议                                                                                                                                               |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.doc`、`.ppt` 等当前弱支持的旧格式                          | **优先 PoC**；当前 `.ppt` 明确拒绝、`.doc` 走 Mammoth 的 DOCX 路径，AnyDoc 有望把失败基线提升为 Markdown，但必须用自有语料证明                     |
| `.rtf/.odt/.odp`、普通 `.docx/.pptx` 的 Markdown-only ingest | 可作为 fallback 或 A/B 候选，需实测结构质量                                                                                                        |
| `.xlsx/.xls`                                                 | 保持现有 `xlsx` 路径以保留二维 sheet、统计、merged cells、类型和显示值；若消费方需要公式表达式，现有路径与 AnyDoc 都不满足，需另立 contract/parser |
| 文本型 PDF                                                   | 暂不替换；AnyDoc 的 PDF 无 `Document` 模型，并会跳过需 OCR 的混合页                                                                                |
| 扫描 PDF/图片/公式/手写                                      | 不适用；继续走 Cognia OCR/文档结构化能力                                                                                                           |
| 托管 Firecrawl `/parse`                                      | 仅作为用户明确启用的云增强 provider，不作为默认引擎                                                                                                |

### 推荐集成形态

1. **跨 Web/Tauri/Capacitor 的首个 PoC 候选：WASM + Web Worker。** 在 `@cognia/document` 内部隔离 AnyDoc adapter，懒加载 `@firecrawl/anydoc-wasm`；旧格式 Markdown-only PoC 调用 `toMarkdownBytes()`，不要在 React 主线程同步解析。上游用 `wasm-pack --target web` 构建并声明兼容 webpack 5 的 `new URL(..., import.meta.url)` 资产模式，但没有声明 Turbopack 兼容；Cognia 的 `pnpm dev`、Next.js 16 production static export、Tauri WebView 和 Capacitor 都必须分别做 smoke test，不能只凭上游说明认定兼容。
2. **桌面性能备选：Rust crate + Tauri command。** Cognia 当前 Rust toolchain floor 高于 AnyDoc 的 1.88，因此 MSRV 不是阻塞项；但 Tauri 全目标构建、二进制增量、WASM/Rust 精确版本同源、IPC 数据量和规范化位置均未验证。若把 assets 大数组经 JSON IPC 返回，可能抵消性能收益。此路线也只能作为独立 PoC，不能因“Rust 可编译”直接进入生产。
3. **不要使用 Node N-API 包进入前端 bundle。** 它是原生 addon，适合 Node service/CLI，不适合静态导出的浏览器应用。

### 包体与离线约束

调研中对官方 `@firecrawl/anydoc-wasm@0.1.9` tarball 做了本地 smoke：Node 26 可用 `initSync` 加载 WASM 并把 CSV 转为 GFM，说明发布物本身可执行；这不等价于浏览器/移动端集成验证。该包的核心是单个约 6.8 MB WASM 文件，而 Cognia 当前 Serwist 配置会排除所有超过 2 MiB 的资产，不进入 Web PWA precache（[`next.config.ts`](../../next.config.ts)）。Tauri CSP 已允许 `wasm-unsafe-eval` 与 blob worker（[`src-tauri/tauri.conf.json`](../../src-tauri/tauri.conf.json)），但实际 webpack 资产 URL、MIME、Tauri custom origin、Capacitor scheme 仍未验证，因此“能随静态资产可靠加载”仍是待证假设。

Web PWA 若要保证首次离线解析，必须为 emitted hashed WASM URL 与 worker chunk 制定原子安装、版本淘汰、quota/eviction 和失败恢复策略；依赖浏览器偶然保留 HTTP cache 不构成离线承诺。现有配置同时设置了 2 MiB `maximumFileSizeToCacheInBytes` 和显式 size-based `exclude`，只提高前者仍会被后者排除。Phase 1 的跨端生产引入以首次离线可用为硬门槛；若该门槛失败，只能通过 shell feature flag 暂不向 Web PWA 暴露，不能把“首次在线初始化后可用”描述为已满足 local-first。

Worker 只解决主线程阻塞，不天然解决取消和内存：AnyDoc 调用是同步的，worker 在解析结束前无法处理 cancel message，硬取消必须 `Worker.terminate()`。PoC 固定为一个 adapter 级 FIFO、全局并发 1、每个活跃任务一个 dedicated worker：任务从实际启动时计 timeout；排队取消直接移除；运行中取消/超时 terminate worker；每个任务带 request id，主线程忽略 terminate 后到达的 stale reply；worker 完成或失败后立即释放，下一个任务重新初始化。该模型牺牲重复初始化成本，换取明确的任务隔离与硬取消语义。

输入所有权必须保持现有 API 语义：`processDocumentAsync` 收到的 `ArrayBuffer` 仍归调用方，adapter 不得直接 transfer 它。Twin ingest 会在解析返回后再次读取 `raw.binary.byteLength`；直接移交会 detach 原 buffer 并把持久化大小写成 `0`。Adapter 应先记录所需 size/metadata，再创建自己拥有的副本，只用 transfer list 移交该副本。这意味着峰值内存至少同时包含调用方 buffer、adapter 副本和 wasm-bindgen 线性内存副本，必须计入验收，不得把 transfer 描述为零拷贝。

Worker wire contract 也应固定，不能直接 structured-clone 上游 `Error`（自定义 `code` 属性不保证保留）：主线程发送 `{ type: "parse", requestId, bytes, format }`；worker 返回 `{ type: "success", requestId, markdown, detectedFormat }` 或 `{ type: "failure", requestId, engineCode, message, detectedFormat? }`。可选 `detectedFormat` 只用于把 mislabeled `.doc/.ppt` 安全路由回现有 OOXML parser；其他 mismatch 仍终止。主线程据此构造 `AnyDocParseError` 和现有 diagnostic。`ProcessingOptions` 增量加入 `signal?: AbortSignal`，adapter 自己拥有 timeout；排队或运行中的 signal abort 都以标准 `AbortError` 结束，timeout 则是 `AnyDocParseError("timeout")`，两者与 stale success 竞争时以第一个终态为准。

wasm-bindgen 仍会把输入复制进线性内存，`toDocument()` 还会物化 JS blocks 和 asset bytes。结合上游 512 MiB 解压与 128 MiB assets 上限，小型压缩输入也可能让移动 WebView 在 timeout 前 OOM；浏览器/WKWebView 又没有可移植、可靠的 per-worker peak-memory gate，WebView 进程被系统杀死后也不能靠 JS “重新初始化”恢复。因此 wrapper 只能通过 stress corpus 选择保守 admission，不能给出硬安全保证。若 Web/Capacitor 在目标低内存设备上仍可能触及 OOM，生产策略只能是禁用这些 shell 的 AnyDoc 路由，或维护降低上游资源上限的 fork；不能用文件大小检查掩盖风险。

## 9. 建议的引入门槛与路线

### Phase 0：隔离式 PoC（建议先做）

- Phase 0 只验证经内容签名确认的 legacy `.doc/.ppt` Markdown-only 路由，不把 PDF、OCR、Excel、现代 OOXML 或 OpenDocument 混入范围。下面是建议在编码前冻结的初始判定线；owner 可以在开工前收紧，但不得在看到结果后放宽再宣告通过：
  - corpus 共 80 份，每格式 40 份：20 份 clean、10 份 complex（CJK/混排、标题/列表/表格、图片、备注等该格式可表达结构）和 10 份 adversarial（损坏、加密、超限、扩展名/签名冲突）。所有样本、期望结果和 hash 必须可内部复现。
  - Clean 全部解析成功；complex 每格式至少 9/10 成功，失败样本按 0 分计入质量。相对人工金标，clean 规范化文本字符召回 ≥99%、标题/列表/表格结构 F1 ≥95%；complex 分别 ≥95% 和 ≥90%。
  - 20 份 adversarial 样本必须全部在 timeout 内进入稳定、可分类的终态，且 app/WebView 零 crash、零 hang。`formatMismatch` 必须作为显式类别验证，不得退化为按扩展名 fallback。
  - 初始 admission 上限为 10 MiB。解析 timeout：desktop 10 秒、mobile 15 秒；warm parse p95：desktop ≤1 秒、mobile ≤3 秒；cold Worker + WASM 初始化：desktop ≤2 秒、mobile ≤5 秒。
  - OS 观测到的 peak working-set 增量：desktop ≤256 MiB、mobile ≤128 MiB，且必须包含 caller buffer、owned transfer copy 和 WASM memory；WebView/process termination 必须为零。若某 shell 无法可靠测量或稳定存活，该 shell 判为 No-Go，而不是“未知但通过”。
  - 必测矩阵为 production static export 下的 Chromium PWA、Tauri macOS arm64 与 Windows x64，以及运行项目最低支持 OS 的实体 iPhone 13 与 Pixel 7 Capacitor 设备。证据必须记录准确 OS/WebView/build SHA；PWA 首次离线安装、版本升级、缓存淘汰/失败、abort/timeout 和 worker crash 用例必须全部通过。
  - 任一格式或 shell 未通过其全部门槛，就不在该格式/shell rollout；不能用另一端通过抵消失败项。
- 在 `packages/document/package.json` 归属依赖并固定 npm `0.1.9` 精确版本，不使用浮动 `^`；若保留 Rust 方案，Cargo 同样使用 `=0.1.9` 并以 lockfile 保证两端版本一致。
- 验证构建链：`pnpm dev` 的 Turbopack worker/WASM resolution、`pnpm build` 的 webpack 资产 URL、Tauri CSP/本地加载、Capacitor iOS/Android WebView、Web PWA 首次离线与升级后的缓存淘汰。
- 验证 worker 资源模型：FIFO、request id、caller-owned input 的 owned copy + transfer、并发 1、dedicated worker、明确的 success/failure envelope、排队取消、运行中 terminate、stale reply suppression、峰值内存和 worker crash；WebView 进程被系统杀死属于 shell 级失败，不宣称 adapter 内可恢复。
- 建立唯一 routing table：同时覆盖上传 accept 列表、`DocumentType`、AnyDoc format、内容签名/扩展名冲突和 mismatch diagnostic；仅安装依赖不会自动让 `.pps/.pot/.ppsx/.ppsm/.xlsb` 出现在现有上传入口。
- 证明 `ProcessedDocument` 的精确输出策略：Markdown-only 旧格式路由，或新增通用结构 contract；未选择之前不进入生产实现。
- 明确验收底线：不得降低当前 `.docx/.xlsx/.pptx/PDF` 的现有结构化能力；对旧格式则与当前“拒绝/低质量”基线比较。

### Phase 1：最小生产引入

- 第一版只把 `formatFromBytes()` 确认为 legacy `doc/ppt`、且扩展名同属该格式族的输入路由到 AnyDoc。内容检测为 OOXML 的 mislabeled `.doc/.ppt` 保持现有解析器；签名与扩展名冲突但无法确定安全路由时，抛出 mismatch error，不按扩展名强制选择 AnyDoc。非回归 corpus 必须包含当前能成功的 mislabeled `.doc`，不能只覆盖 `.docx/.xlsx/.pptx/PDF`。不要把“失败后 fallback”写成能力，因为当前 legacy `.ppt` 本就终止、legacy `.doc` 也没有可靠成功后端。
- Markdown-only 路线只调用一次 `toMarkdownBytes()`，按上文完整字段映射填充 `ProcessedDocument`，`parseResult` 留空，`ParseSummary.quality.status` 固定为 `partial`。若选择通用结构路线，必须单独评审 contract 变更，不能在此阶段隐式混入。
- 失败沿用 `processDocumentAsync` 的既有行为：throw，而不是伪造一个带 error diagnostic 的成功 `ProcessedDocument`。Adapter 抛出 `AnyDocParseError extends Error`，其稳定 `engineCode` 保留 `unsupported/malformed/encrypted/resourceLimit/missingPart/formatMismatch/initFailed/assetUnavailable/timeout/workerCrashed`，并附现有 `diagnostic`：`encrypted → password_protected`、`unsupported/initFailed/assetUnavailable → unsupported_feature`、`formatMismatch` 及其余转换/超时/worker 错误 → `parse_failed`。用户主动取消单独抛 `AbortError`，不计为解析失败。混合 PDF 等无法从稳定 API 得知的部分跳过场景禁止路由。
- 采用上文唯一的 FIFO + dedicated worker contract；shell feature flag 控制只在通过内存与离线门槛的平台启用。Timeout/terminate 后重新初始化 worker；WebView OOM 不宣称可由 adapter 恢复。

### Phase 2：有证据再扩大

- 只有在自有 corpus 证明质量与结构契约不退化后，才逐步替代 RTF/OpenDocument/Office Markdown-only ingest。
- PDF、OCR、公式和结构化元数据继续保持独立引擎；不要为了“统一依赖”牺牲能力。
- 跟踪上游 `1.0`、安全政策/审计、diagnostic API、可配置资源限制和 PDF `Document` 模型，再评估是否升级为默认引擎。

## 10. 最终建议

**当前结论：Conditional Go，仅批准 Phase 0 PoC，不批准生产引入。** MIT、纯 Rust、WASM、无 GPU/服务依赖和旧 Office 覆盖使 AnyDoc 值得进入验证；但在 Cognia 自有 corpus、多端构建、离线缓存、内存/取消和 `ProcessedDocument` 映射通过前，不能断言它已适合 Cognia 的多端架构。

**No-Go（全量替换）**：当前 `0.1.9` 太年轻，且缺少 OCR、公式、页面几何、稳定 diagnostics 和丰富 metadata；全量替换会降低 `ProcessedDocument` 的能力，并破坏 PDF/Excel/预览/分段链路。若 PoC 通过，正确策略是“adapter + 内容签名路由 + 明确 terminal diagnostics + 仅在真实可用时保留现有 parser + 自有金标”，而不是把 AnyDoc 直接设成唯一解析引擎。

## Sources

- [Firecrawl AnyDoc official repository and README](https://github.com/firecrawl/anydoc)
- [Firecrawl AnyDoc `v0.1.9` source snapshot](https://github.com/firecrawl/anydoc/tree/e754e1d33a1a540ebc9226e36f11d3f401852c9e)
- [Firecrawl official announcement: AnyDoc and pdf-inspector](https://www.firecrawl.dev/blog/anydoc-and-pdf-inspector)
- [Firecrawl `/parse` official documentation](https://docs.firecrawl.dev/features/parse)
- [Hyland OCR for AnyDoc official documentation](https://docs.hyland.com/r/AnyDoc/OCR-for-AnyDoc/Foundation-23.1/OCR-for-AnyDoc-Programming-Reference-Guide/Overview/Introduction?contentId=TU24SgF2yNvhtnRa9vxLGw)
