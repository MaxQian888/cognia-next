# dsh-libreoffice-kit 与 Cognia：实际调用链、能力差距与增量接入判断

审阅日期：2026-10-06。方式：本地源码、清单、测试源码及官方公开文档的只读对比；没有安装依赖、运行包、启动服务、执行测试或改动实现。本报告是唯一新增输出。这里的“已接通”指源码有真实调用链，不代表本机运行验证通过。

## 1. 结论

**Cognia 已有 Office 产品层，缺的是通用 Office 文件引擎层。** 它已实现插件拥有的 DOCX/XLSX/PPTX 数据模型、Agent 结构化修改、浏览器预览、原生文件生成、校验、版本管理，以及部分人工编辑和审阅。`dsh-libreoffice-kit` 的增量价值主要是：直接对原始 Office 文件做版式计算、PDF/PNG 渲染、格式转换，以及通过 Calc 刷新文件中的公式缓存。

**不建议整体替换现有插件，也不建议一开始作为所有客户端的默认后端。** 更合适的定位是可选的、宿主侧运行的 Office 转换与验证后端；先服务桌面和 headless，保留浏览器/移动端当前轻量路径。通过平台和文档集验证后，可成为“原文件保真预览/正式 PDF 导出”的优先后端，而非单元格输入和所有预览的默认执行器。

三个不能再当成空白的能力：

- **公式重算已实现**：`create/applyOperations → recalculateWorkbook → 更新缓存值`，不是仅设置 Excel 打开时重算。
- **人工改单元格已实现**：预览中的编辑走同一 `applyOperations + expectedVersion + 重算` 通路。
- **Agent 看图已实现**：`artifact_capture → captureArtifactImage → 插件 renderer 离屏挂载 → PNG`。不足是捕获 Cognia 的浏览器投影，不能证明实际导出的 Office 文件具有相同版式，也没有按页/幻灯片/sheet A1 区域的批量图片协议。

另一个重要边界：**引擎无法找回早已被 Cognia 导入模型丢弃的对象。** 要提升原文件预览，必须将原始文件字节送进引擎；如果先导入成简化模型、再导出、最后交给引擎，得到的是“当前导出文件的真实效果”，不是“原文件保真恢复”。

## 2. 审阅基线、工作树和资料边界

开始时分支 `dev`，HEAD `558a3bf14b17a5e31dd7221614ca6d56f74fa2fa`。已有未提交范围：

- 已修改：`crates/cognia-cli/src/engine/frontend_build.rs`、`crates/cognia-plugin-template-ts/package.json`、`package.json`、`scripts/gates/check-all.mjs`、`scripts/gates/check-gate-registry.mjs`。
- 未跟踪：`.pnpm-store/`，`scripts/gates/check-invoke-arg-parity.mjs`、对应 test、`invoke-arg-parity-baseline.json`、`lib/invoke-call-sites.mjs`，以及 `check-plugin-externals.mjs`、对应 test、`lib/plugin-externals.mjs`。

审阅途中其他会话将 HEAD 推进到 `cbf5ed10ec2f788f29fe8770944f4379885d10d1`，提交为 `fix(plugin): align builder externals with host modules`。比较两次 HEAD，变更仅涉及以上 plugin externals/build 路径，没有本报告引用的 Office 实现变更。剩余已修改为 `package.json`、两个 gate 文件；剩余未跟踪为 `.pnpm-store/` 及 invoke-arg-parity 相关文件。本报告保留了这些工作，没有 stage/commit/push。

收尾再次采样时，其他会话先改动了 plugin-runtime 的 `api_bridge.rs/window_ops.rs`、宿主 `context/manager` 和 plugin-store（含测试），随后提交为 `8c9edb7fa49dba2cd21b8d71960d6fe4fd2016d0`，`fix(plugin): preserve scoped native command arguments`。已阅读该增量：是窗口调用改走 scoped API、卸载参数对齐，没有增加 Office 引擎或改变本报告的 Office 调用链。**最后采样 HEAD 为这个提交**；dirty 为 `package.json`、`packages/plugin-sdk/tsup.package-types.config.ts`（Node-only import 注释）、两个 gate 文件，加上前述 invoke-arg-parity 未跟踪文件、`.pnpm-store/` 和本报告。共享工作树持续变化，以上是有时间顺序的观测，不是冻结快照。

已读取根 `AGENTS.md`，检查 `.agents/skills`；应用 `concurrent-tree-safety` 的共享工作树保护原则。也检查了 `map-requirement-flow` 的证据分类要求，但本任务交付功能/架构对比，不创建实现或完整需求流程。没有写 Next.js 代码，因此没有启动 Next 开发环境。相关架构依据包括 ADR-0134（远程文档引用）、0155/0156（公共插件宿主接口）、0158（Artifacts/Canvas，含后续修订）、0197（Node sidecar）。ADR 只作意图依据，能力判断以实现和调用者为准。

外部资料：

- [官方仓库 README](https://github.com/deepseek-ai/dsh-libreoffice-kit)：定位、平台及字体能力。
- [Node API README](https://github.com/deepseek-ai/dsh-libreoffice-kit/blob/master/packages/entry/README.md)：API、取消/清理、converter/factory、文件路径约束。
- [官方 package.json](https://github.com/deepseek-ai/dsh-libreoffice-kit/blob/master/packages/entry/package.json)：本次读到 `0.1.3`、Node `>=22.19.0`、`dsoffice`、MPL-2.0。
- [官方打包说明](https://github.com/deepseek-ai/dsh-libreoffice-kit/blob/master/docs/packaging.md)：平台资源、分发、Worker/进程边界。
- [npm 页面](https://www.npmjs.com/package/@deepseek-ai/libreoffice-kit)：委派上下文此前核实显示 `0.1.5`；本次 registry latest 请求失败，**没有独立重验 npm 最新值**。因此明确保留“npm 0.1.5 / 仓库 manifest 与安装示例 0.1.3”的来源差异，不能把 master 代码当成已验证的 0.1.5 发布包。

未运行 kit，未验证其各平台安装、渲染质量、速度或内存。官方文档描述不等于本项目中的实测结果。不存在从这里恢复先前服务部署安全审计的工作。

## 3. 简要能力矩阵

符号：**接通**＝实现及调用者存在；**插件**＝需插件启用；**部分**＝有能力但边界不同；**条件**＝平台/开关/宿主决定；**未发现**＝此次源码范围内没有对应实现；**待验**＝不能靠静态阅读确认。

| 维度                     | Cognia 当前实现                                                                | kit 官方能力                                                  | 实际差距                                                     |
| ------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------- | ------------------------------------------------------------ |
| Office 内容读取          | 接通：`@cognia/document`，DOCX/Excel/PPTX、ODF 文本结构提取；旧 DOC/PPT 有条件 | Office 导入后转换/渲染                                        | 不是“能读 vs 不能读”，是语义提取 vs Office 版式引擎          |
| DOCX 创建与修改          | 插件：块、列表、表格、批注、修订、版本、DOCX 导出                              | 格式转换，无 Cognia 式编辑模型/UI                             | Cognia 产品层更完整；复杂原稿保留不足                        |
| XLSX 创建与修改          | 插件：单元格、区域、sheet、结构引用改写、样式、人工单元格编辑                  | 转换、渲染、文件重算                                          | 不必重建编辑器；引擎适合文件级处理                           |
| PPTX 创建与修改          | 插件：元素、幻灯片、备注、导入/导出                                            | Impress 布局与格式转换                                        | Cognia 子集模型，表格/图表导出有扁平化                       |
| 原 Office 文件预览       | 部分：HTML/DOM 重建模型；Canvas 导入成为 Markdown                              | Office 原文件布局并输出 PDF/PNG                               | 核心增量，尤其复杂版式                                       |
| PDF 预览/操作            | 插件：pdf.js 真正按页画 PDF；表单填写、抽页、文本提取                          | PDF 输入直接转 PNG                                            | PDF 预览大量重叠，不应重建现有 viewer                        |
| Office → PDF             | 未发现统一原文件转换链；通用 artifact 有 jsPDF 导出                            | `render`/`convert`                                            | kit 可补正式文件打印/预览链                                  |
| PNG 看图                 | 接通：`artifact_capture`，离屏 renderer / DOM 截图                             | `renderImages` + PNG 与 manifest                              | 现有图是 UI 投影；kit 是文件布局结果                         |
| 文档页/幻灯片选择        | PDF UI 翻页、PPT UI 换页；捕获工具无对应参数                                   | 页/幻灯片范围                                                 | 批处理与可重现选择协议有缺口                                 |
| sheet + A1 区域          | `office_read_range` 是结构化值读取；预览显示选中 sheet                         | 指定 sheet/range 的图片渲染                                   | 读取表格区域不等于区域图片                                   |
| Excel 公式缓存           | 接通：自有 parser + formulajs，编辑重算并写 XLSX result                        | Calc 重算 XLS/XLSX/ODS，保存 XLSX/ODS                         | 更广语义与文件级刷新值得验证，不能说 Cognia 没重算           |
| 字体                     | 部分：系统字体枚举、插件 @font-face、CSS family                                | 文件引擎字体发现、替代、缺失报告、有界缓存                    | 缺文档字体→实际字体→导出结果的可追踪闭环                     |
| Office 格式互转          | 各插件导入指定格式、导出本族目标；不是通用转换服务                             | Word/Excel/PPT 各族转换                                       | 二进制旧格式、ODF 与 OOXML 互转是增量                        |
| 队列/取消/资源           | 通用工具生命周期、部分 DOCX 进度/取消、PDF 清理、截图 dispose                  | converter 串行槽、factory、多进程/Worker、AbortSignal/cleanup | 可复用宿主骨架；未发现统一 Office conversion provider/job 层 |
| 桌面/headless/web/mobile | 插件 browser/Tauri/mobile；Office/PDF headless blocked，Docs/PPT degraded      | Node，Mac/Windows native，Linux Node WASM                     | headless 是增量；不是浏览器 WASM 即插即用                    |
| Agent、UI、历史、知识库  | 完整产品层和 SDK，能力依插件/平台而异                                          | 无在线编辑/协同 UI                                            | kit 不替代 Cognia 的 Agent 工作台                            |

## 4. Cognia 的真实调用链

### 4.1 内容读取与可编辑导入是两套目标

**聊天附件 / 知识库路径：**

`附件 dispatch → processDocumentAsync → 按实际扩展名的 parser → text / parseResult / parseSummary / structure → 模型上下文或知识库`。

证据：`lib/chat/attachments/dispatch.ts:388` 调公共 document 包；`:431` 的 `authorizeMatchingPluginAttachments`、`:801` 把原字节句柄授权给已启用的匹配 importer；`:814` 将 handle 提示附给模型。`components/shell/workspace-knowledge-section.tsx:112` 也调用同一 `processDocumentAsync`。因此语义提取与插件读取原字节可以并存，kit 不需要重建附件上传入口。

`packages/document/src/document-processor.ts` 的真实分派：

- DOCX/DOCM：`:403` → `parseWord`，后者 `parsers/office-parser.ts:92` 动态载入 mammoth，`:117` 转 HTML、`:118` 提取文本。可有图像和 heading 信息，但不执行 Word 分页。
- XLS/XLSX/XLSM：`:448` → `parseExcel`，`office-parser.ts:233` 使用 SheetJS。ODS 在 `document-processor.ts:431` 走专门 ODF parser。
- PPTX/PPTM：`:532` → `parsePresentation`，ODP 在 `:515` 走 ODF parser。是解析结构与文本，不是 Impress 渲染。
- 旧 DOC：`:352` 的 AnyDoc 是开关路径；默认开关来自 `:82` 的 `NEXT_PUBLIC_ENABLE_ANYDOC_LEGACY_OFFICE`。未启用时后面的 mammoth 路径不能据此宣称真正二进制 DOC 已支持。
- 旧 PPT：`:474` 在 AnyDoc 未启用时明确报“不支持，请转 PPTX”；启用后的结果在 `:100` 被标为 `markdown-only`、质量 `partial`。扩展名列表包含某格式，不足以证明完整支持。

**Canvas 路径：** `lib/canvas/document-import.ts:176` 复用公共 parser，`:118` 将二进制文档结果放入 Markdown 编辑语言，`:144` 发出 `converted-to-markdown` 警告。它适合继续写文字，不是原 Office 文件编辑器。

### 4.2 Office 插件确实已连到宿主

`plugins/cognia-office/src/index.ts:50` 起的 activation 创建 runtime，注册 workbook renderer、importer、Agent tools 和工具结果卡。其余 Documents/Presentations/PDF 插件也有各自 activation。

资源不是只有源码目录：`lib/plugin/core/browser-builtin-assets.generated.json` 中存在 Documents（`:3140`）、Office（`:5842`）、PDF（`:6075`）、Presentations（`:6199`）的预编译资源登记；`browser-builtin-registry.ts:47` 读取登记，`browser-builtin-assets.ts:4` 说明只在启用时取 chunk。**这证明打包/发现路径存在，不证明用户此刻已启用这些插件，也不证明生成产物与本机源码重新构建后完全一致。**

工具实际调用走 `lib/claude/plugin-tool-ipc.ts:878`：`resolvePluginToolByName → invokePluginTool`，`:895` 传 session、AbortSignal 和项目上下文。插件用公共 `@cognia/plugin-sdk`，宿主不应为 kit 再增加一条特殊 Office 专属 Agent relay。

### 4.3 XLSX：已有重算、已有人工编辑，仍不是 Excel 完整兼容层

链路：`office_create_workbook / office_apply_operations → createOfficeRuntime → applyWorkbookOperations → recalculateWorkbook → ctx.artifact.create/update → renderer / office_read_range / exportWorkbookXlsx`。

关键实现：

- `runtime.ts:91` 创建时应用操作并重算；`:172` 编辑时重算并以 `expectedVersion` 写回。`:114` 导入保留源文件缓存，**导入不自动重算**。
- `model.ts:65` 起提供 setCell/setRange、sheet 增删重命名重排、合并、筛选、冻结、行列尺寸、插删行列、clearRange、样式、追加行等操作；`formula-refs.ts` 随结构操作改写引用。
- `formula-eval.ts:17` 自行处理运算符、引用和 lazy IF 等，其余函数委托 formulajs；`:20` 明确不求值 defined names、3D、structured/external refs、未知函数及 spill 结果：已有缓存保留，无缓存返回错误并报告。
- `formula-eval.ts:52` 限制 50,000 公式单元格、2,000,000 依赖边、2,000,000 读取、3 秒预算；`:125` 返回 `RecalculationReport`。预算不足整次跳过；循环依赖映射 `#REF!`。`status: complete` 也可能有 unsupported issues，不能理解为所有公式都被验证。
- `xlsx.ts:33` SheetJS 导入公式/缓存/样式，再用 ExcelJS 补充；`:146` ExcelJS 写 XLSX，`:152` `fullCalcOnLoad=true`；`:233` 同时写 formula 与 result。设置重算标记与写缓存是并存的。
- `index.ts:68` 将预览人工编辑接至 runtime；`cell-editor.ts` 实现单元格输入/删除。范围是单元格内容，不是完整桌面 Excel 交互。
- `xlsx.ts:354` 探测透视表、图表、drawing、批注、外部链接、table、controls 等；`:385` 检查条件格式/数据验证等。`runtime.ts:253` 起的导出先校验，对已知丢失项要求确认，再保存。

因此 kit 的重算价值是“额外文件级 Calc 后端/校验器和更广兼容性候选”，不是补一个当前不存在的 SUM。Calc 对 Microsoft Excel 的每个函数、循环/迭代、日期系统和动态数组语义是否一致，仍须用实际文档验证。

### 4.4 DOCX：有结构编辑与审阅，但不是无损 Word 往返

`plugins/cognia-documents/src/model.ts:58` 的操作集包含 Markdown 插入、块增删移动、文字替换、表格行列、评论和接受/拒绝修订。`docx.ts:70` 从 ZIP/XML 导入块/编号/评论；`:156` 用 `docx` 库生成文件；`:306` 后续逻辑导出真实 tracked insertion/deletion，评论不是单纯预览标签。

`preview.ts:349` 起有评论和修订审阅区，接受/拒绝动作可写回。文档版本列举/恢复由 `runtime.ts:237`、`:253` 走 artifact 历史。宿主会话导出通过 `index.ts:52` 的 `registerExporter` 接到 `exportTranscriptDocx`，**这是会话转 DOCX，不是任意 Office 文件转换 provider**。

限制有代码证据：`docx.ts:42` 的 imported feature 列表包含图像、超链接、drawing、脚注、尾注、页眉页脚、字段、content controls、section page setup、合并单元格和分页符。导入模型无法无损持有这些 Word 布局信息。Cognia 创建的新修订/评论能导出，不代表任意源文件修订历史都能完整往返。

### 4.5 PPTX：元素模型可编辑，Office 原生对象保留程度有限

`plugins/cognia-presentations/src/model.ts:5` 支持 text/shape/image/table/chart；`:79` 支持新增、替换、删除、重排 slide。`runtime.ts:83` 从授权附件或 picker 导入，`:119` 版本约束更新，`:152` 导出时处理 feature loss 和 validation。

`pptx.ts:14` 手写 ZIP/OOXML 包；`:88` 导入布局尺寸、幻灯片顺序、部分元素和 notes。注意两个实际限制：

1. `pptx.ts:303` 的 `importChart` 只取首个 `c:ser` 的缓存 categories/values，不能宣称多序列原生图表完整保留。
2. `pptx.ts:550` 将表格转成每格一个 shape，`:569` 将 chart 转为柱形 shapes，而不是保留可数据编辑的 PowerPoint chart/table 对象。输出是有效 PPTX，不等于语义无损往返。

`preview.ts:25` 起的 DOM renderer 重建 deck，`:26` 每次 mount 从第一张开始；不调用系统 Office 或 kit。现有能力更接近 Agent 驱动的演示文稿生成/修改，而非完整 PowerPoint 交互编辑器。

## 5. 渲染、PDF、截图和字体：最关键的差距

### 5.1 “原生文件”“原生布局”“PDF 页面”必须分开

生成 DOCX/XLSX/PPTX 表示生成了对应文件格式，不表示用 Office 引擎算过排版。当前 Office 三插件的预览都在浏览器重建模型。

- Office `preview.ts:55` 最多显示 300 行、60 列；`:154` 离屏重新挂载时从 sheet 0 开始。
- Presentations `preview.ts:25` 从 slide 0 开始；文档预览呈现块与审阅 UI。
- `lib/claude/artifact-builtin-tools.ts:181` 的 `artifact_capture` 只收 artifactId/width/height，没有 page/sheet/range。
- `lib/artifacts/export/raster.ts:266` 用固定 viewport 离屏容器、等待 renderer ready，再 `html2canvas`；`:324` finally dispose/remove。截到的可能包括标签/工具条，且不能据此覆盖整个大工作簿或所有 slide。

kit 的 `renderImages` 是原文件直接布局后的 PNG 与 manifest，并能选择页/幻灯片或 sheet+A1 range，正好补“可定位、可批处理、可重现的文件输出验证”。[官方 Node API](https://github.com/deepseek-ai/dsh-libreoffice-kit/blob/master/packages/entry/README.md)

### 5.2 Cognia 已有 PDF，不要重复做 viewer

`plugins/cognia-pdf/src/pdf-engine.ts:124` 用 pdf.js 加载；`:162` 的 `openPdfForRender` 提供 pageCount/renderPage/destroy，会取消前一个 render；`preview.ts:56` 将 PDF 真正画在 canvas 上并翻页。它是实际 PDF 渲染，不应和 Office DOM 近似预览一起贬为“文本展示”。`tools.ts:5` 起还有 inspect、fill form、extract pages、extract text、export 等。

公共 PDF 读取另有 `packages/document/src/parsers/native-pdf.ts:80` → Tauri `parse_document_native` 的 liteparse/PDFium 路径；`src-tauri/src/parse/mod.rs:123` 有未编译 feature 时的 unsupported 分支，`Cargo.toml:603` 定义 `parse-liteparse`。这是条件式 PDF 文本/坐标提取，不是 Office 转 PDF。没有核验本机发布构建是否启用该 feature。

现有通用 artifact PDF 路径：`lib/artifacts/export/pdf.ts:39` 对 text/code/jupyter 调 document-writer，对视觉类型截图后塞进一张 A4；`lib/files/document-writer/index.ts:60` 使用 jsPDF 自行换行分页。这不经过 Word/Calc/Impress 打印布局。且 `export/index.ts:69` 按 artifact 的可导出格式检查；Office/Documents runtime 声明 `exportFormats: ["raw"]`，另有自己的专用文件导出按钮。**不能因为仓库有一个 PDF 函数，就认为所有 Office artifact 已接通正式 PDF 导出。**

### 5.3 字体不是完全空白，但文件级闭环尚缺

Cognia 已有两块可复用基础：

- `src-tauri/src/fonts.rs:48` 的 `os_list_fonts` 使用 fontdb 枚举系统 family/monospaced，接 `lib/appearance/load-system-fonts.ts:40` 与字体选择器。
- `lib/plugin/bridge/font-bridge.ts:1` 注入插件 @font-face，并注册到 appearance 字体表，禁用时撤销。

这些服务 UI 字体选择，不是 Office 引擎字体目录、原始 font bytes、glyph coverage、替代规则、missingFonts 和 PDF 嵌入结果的一体化管理。当前 XLSX `model.ts:29` 的 font 仅 bold/italic/color；PPT theme 有 family，但预览使用浏览器 CSS fallback。`document-writer/index.ts:60` 的 jsPDF 路径未见 CJK 字体装载/嵌入，不能据此保证中文 PDF 可读和版式一致。

kit 对字体目录发现、家族匹配/替代、缺失家族和元数据缓存提供更完整控制，但它**不附带字体、不承诺与 Microsoft Office 或不同引擎逐像素一致**；二进制输入的 `missingFonts` 空数组不代表没有缺字。中文宋体/微软雅黑等仍需要可用字体及实际样本文档验证。[官方字体说明](https://github.com/deepseek-ai/dsh-libreoffice-kit)

## 6. 任务、取消、进度、SDK 与打包

### 已有可复用接口

| 接口/界面                                        | 当前职责                                         | 接入时建议                                                       |
| ------------------------------------------------ | ------------------------------------------------ | ---------------------------------------------------------------- |
| `lib/plugin/api/files-api.ts:71`、`:86`          | 授权附件句柄、picker、保存；桌面/web/mobile 分派 | 继续作为用户文件入口；宿主转换前把授权字节映射成任务临时文件     |
| `lib/plugin/api/import-api.ts:32`、`:121`        | importer 注册、文件归属匹配                      | 延续现有文档/表格 importer，不再写上传器                         |
| `lib/plugin/api/artifact-api.ts:53`、`:94`       | artifact 创建、owner、expectedVersion            | 保留编辑模型与历史；转换输出作为特定版本的派生产物               |
| `lib/claude/plugin-tool-ipc.ts:878`              | 统一工具解析与调用，传 signal/session            | 延用 Agent 桥和结果协议                                          |
| `plugins/*/src/card.tsx`、preview/export-control | 已有结果卡、预览、导出、丢失确认反馈             | 增加“原文件预览/导出文件验证/格式转换”的入口和状态               |
| `lib/artifacts/capture.ts:62`                    | Agent DOM 视觉验证                               | 保留，和文件渲染明确标记来源，避免混淆                           |
| `plugins/cognia-pdf/src/preview.ts:56`           | PDF 分页 viewer                                  | 尽量复用；跨插件调用需正式共享契约，不能私自导入插件内部 runtime |
| `lib/plugin/api/scheduler-tasks.ts:467`          | 通用任务执行取消                                 | 定时/批处理可参考；它目前不是 Office 转换队列                    |

### 现有支持的边界

Docs `runtime.ts:38` 定义 progress/signal，导入（`:130`）、验证/导出（`:209`、`:301`）在阶段间检查取消并上报进度。Office runtime 的 signal 目前出现在 Lark sync（`:302`）；XLSX 编解码/重算没有同等每阶段取消合同。PPT runtime 也未见同等取消/进度串联。通用工具提供 AbortSignal **不等于**底层库计算会及时停止。

现有截图有超时和 dispose，PDF 有 render cancel 与 loadingTask cleanup，公式有预算；它们是不同机制。未发现统一 Office provider 接口、跨转换任务并发上限、全局公平队列、转换资源状态和结果缓存协议。不要将任务调度器、导入注册表或 session exporter 命名成“已经有 conversion provider”。

kit 的 converter 将同实例工作串行化，factory 可拥有多个 converter；取消与 dispose 会等待 worker/native 退出与清理。它不是 Cognia 的持久任务队列，也不自动提供产品级百分比进度 UI。接入仍需宿主决定任务归属、容量、进度阶段和成功产物保存。官方打包说明明确其更新/宏/网络限制**不构成原生代码的 OS sandbox**；本报告仅引用该边界，不扩展服务攻击审计。[官方打包说明](https://github.com/deepseek-ai/dsh-libreoffice-kit/blob/master/docs/packaging.md)

### 平台与发布

- Cognia `sidecar/package.json:7` 要求 Node `>=26.0.0`，满足 kit 声明的最低 Node 版本；但并不证明实际安装包或引擎在该 Node 版本已验证。
- Tauri `tauri.conf.json:44` 的 externalBin 没有 Office 引擎；`:50` 已打包 sidecar、node_modules、plugin-node 和插件资源，是可利用的宿主分发基础。
- Office manifest `plugin.json:178` 的 runtimeCompatibility 明确 headless blocked；Documents `:239`、Presentations `:79` 为 degraded（编写/验证可用，picker/preview 要 UI）；PDF `:84` blocked。这里是清单声明，不能扩大为所有 headless 场景已跑通。
- kit 官方支持 Mac ARM64/x64、Windows ARM64/x64 的 native 预编译包；Linux 默认 Node WASM。Windows 还需要匹配架构 VC++ v14 runtime；Mac/Windows 不因 native 缺失就自动退到 WASM。Linux 包声明不等于所有发行版都已认证。[官方平台说明](https://github.com/deepseek-ai/dsh-libreoffice-kit)
- **Node WASM 不是浏览器可直接运行的 WASM。** Web/mobile 要么保持现有本地能力，要么将这项可选能力路由到受支持的宿主；不能承诺仅添加前端 npm 依赖即跨端。
- 分发要保留完整引擎资源、worker、source/license notices 并验证安装后重定位。不要把旧版官方体积记录当作本次发布包大小。MPL-2.0 和所带第三方/字体 notices 需要按实际分发物核对；没有进行法律结论或重新许可判断。

## 7. Cognia 比 kit 多什么；真正欠缺什么

**Cognia 已多出的产品能力：** Agent 工具 schema 与统一调度、聊天附件/知识库输入、结构化修改、可交互预览、人工单元格修正、DOCX 评论/修订审阅、artifact 版本与冲突检查、工作区归属、导出保存反馈、多语言、多端壳和 SDK。`office_sync_lark` 还可将值/公式推到新建飞书表格（`runtime.ts:299`）；它是 push-create，不是完整双向同步。Canvas 的协作体系属于更广产品能力，不能据此称 Office JSON 模型已具备实时多人单元格协同。

**真正不足按优先级：**

1. 原 Office 文件的版式预览与生成文件的独立布局验证；现有 DOM 视图不能作 Word/Excel/PowerPoint 打印效果依据。
2. 统一的 Office→PDF、页/幻灯片/sheet-range→PNG+manifest，尤其无 UI 的批处理。
3. 旧二进制 Office 与 ODF/OOXML 互转，不能仅靠导入扩展名支持表证明存在。
4. 文件级公式刷新和复杂公式的第二计算引擎；保留既有轻量重算，明确缓存来源与未验证单元格。
5. 字体发现—替代—缺失诊断—导出结果的可复现链，尤其中文跨平台版式。
6. 宿主侧转换任务生命周期、输出所有权、原件保留和跨平台发布验证。

**kit 不能自动补齐：** Office 编辑器交互、多人协同、Excel 完整一致性、源文档导入无损、Cognia 的模型/schema 丰富度、丢弃对象恢复、全部字体授权、产品进度与持久队列。DOCX/PPTX/XLSX 的模型限制若用户要继续编辑，仍需要产品明确支持范围。

## 8. 建议的增量接入方式（仅设计，尚未实现）

### 保留两条内容通路

1. **编辑通路**：原文件 → 现有 importer → Cognia 模型 → 操作/版本 → 现有 writer。继续服务快速互动。
2. **文件通路**：原始授权文件字节，或 writer 生成的新字节 → 宿主转换后端 → PDF/PNG/转换文件/重算结果 → 现有保存与 artifact UI。

每个输出记录源文件/源 artifact 版本、内容摘要、operation、实际 backend/版本、字体配置、warnings、页或 sheet/range 信息；展示时让用户知道看的是原稿、编辑后模型预览，还是已导出文件。这是建议的新契约，当前没有同名现成 provider。

### 优先扩展而非重复建设

- 从现有 Office plugin runtime 调宿主能力；引擎驻 Node 侧，不导入浏览器包。为第三方插件保留同等公共调用契约，遵循 ADR-0155/0156。
- 将 `files.open/readAttachment/save` 继续作为边界；引擎需要绝对路径和独立输出，临时目录由宿主创建/回收，成功结果回到既有保存机制。
- 原件持久引用与派生产物缓存需要补齐。目前 files-api 的 handle 是内存 Map，单凭它不能保证重启后还有原文件可用于保真渲染。
- PDF 显示复用现有 viewer；不要重新造在线 Office UI。通用 artifact PDF 导出也不能直接替换所有插件专用导出，因为它们的类型和 metadata 含义不同。
- 用已有工具生命周期传 signal；阶段进度可报“准备/转换/读取输出/保存”，不要将不透明引擎过程伪装成精确百分比。
- 保留 DOM `artifact_capture`：它验证用户正在看到的界面；另行提供文件页图验证，验证最终交付物。二者互补。
- 文件级重算产生新输出或候选版本，不静默覆盖现有编辑模型。先比较值变化和 unsupported report，避免两套引擎不断互相改写缓存。

### 为什么先可选

kit 增加平台引擎与字体分发、冷启动、每次新进程/Worker、临时磁盘、调度和版本兼容工作；同时浏览器和移动端不能本地直接共用 Node 调用。Cognia 的实时单元格编辑已有轻量求值，不适合每次按键启动 Office 引擎。

推荐先以能力探测选择：有引擎且用户需要原文件/正式输出时可用；没有则说明该项不可用并保留当前语义/预览能力，不能把近似渲染默认为等价替代。待实际验证后，桌面/headless 的正式 Office 文件渲染可默认选 kit，普通编辑和 UI 预览继续使用现有路径。

## 9. 测试证据与边界

本次只读测试文件，没有执行，也没有计算/承诺覆盖率。

| 测试                                                         | 可证明的设计覆盖                                                  | 不能证明                                                     |
| ------------------------------------------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------ |
| `plugins/cognia-office/src/formula-eval.test.ts:35` 起       | 依赖顺序、跨 sheet、coercion、lazy IF、循环、缓存保留、日期、预算 | 与全套 Excel/Calc 函数兼容                                   |
| `plugins/cognia-office/src/xlsx.test.ts`、`runtime.test.ts`  | 编解码、模型/保存、错误和生命周期分支                             | Excel 的完整打印版式                                         |
| `plugins/cognia-office/src/workbuddy-bench.test.ts:148`      | 本地 fixtures 导出/导入，sheet 名、公式存在和 validation          | 不是运行竞争产品的外部对照 benchmark，也不验证每个数值或像素 |
| `plugins/cognia-documents/src/docx.test.ts:28` 起            | 实际 ZIP/DOCX 内容往返、列表/表格/评论/修订                       | Word 的分页、复杂对象、字体 fidelity                         |
| `plugins/cognia-presentations/src/pptx.test.ts:12`、`:66`    | 包结构、slide 文本、元素/notes 导入                               | PowerPoint 图表可编辑性和跨引擎视觉一致                      |
| `lib/artifacts/export/raster.test.ts:1`、`:193`              | html2canvas 被 mock；挂载、ready、超时、dispose、路由             | 实际浏览器像素质量                                           |
| `plugins/cognia-pdf/src/pdf-engine.browser.test.ts:3`        | pdf.js 被 mock 的 worker URL/资源清理行为                         | 浏览器/全部 OS 的真实 PDF 渲染 smoke                         |
| 各 `preview.test.ts`、`cell-editor.test.ts`、`index.test.ts` | DOM、键盘、冲突、注册/卸载                                        | 系统 Office 兼容认证                                         |

当前 `validateDocxRoundTrip`（`docx.ts:233`）主要检查 ZIP 关键 parts/文本；`validateXlsxPackage`（`xlsx.ts:163`）检查关键 ZIP parts；`validatePptxRoundTrip`（`pptx.ts:480`）检查 parts 和 slide 数。它们有价值，但都不是调用 Word/Excel/PowerPoint/LibreOffice 重新排版后的验收。

## 10. 分阶段验证计划（本次没有执行）

| 阶段                       | 验证内容                                                                                                                    | 通过后才能做的决定                     |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| 0. 固定版本与能力合同      | 明确 npm/源码差异；锁 Node API 与平台 engine 版本；读取 capabilities；确定格式、操作、错误、signal、结果 metadata           | 是否进行受控试验                       |
| 1. 纯文件离线试验          | 原始 DOC/DOCX/XLS/XLSX/PPT/PPTX/ODF 样本→PDF/PNG/转换；不先经 Cognia 模型；相同字体/页参数                                  | 证明 kit 对原文件的真实增量            |
| 2. Cognia 生成文件交叉验证 | 现有 writer 输出→kit 读/渲染；与 DOM 预览并排；检查表格跨页、图表扁平化、截断、notes、批注/修订状态                         | 正式导出链能否采用                     |
| 3. 公式与中文专项          | 导入旧缓存、跨 sheet、名字、3D、structured refs、spill、日期/循环/财务函数；固定中英字体并比较换行分页、缺字及 PDF 搜索文本 | 重算何时使用，哪些差异必须提示         |
| 4. 宿主生命周期            | 排队取消、执行取消、超时、插件禁用/应用关闭；失败不留成功文件、并发上限、临时资源与缓存归属；错误结果与 UI 对齐             | 可选后端正式接入                       |
| 5. 真实发布物验证          | Mac ARM/x64、Windows ARM/x64（含 VC runtime）、Linux Node WASM；安装后重定位、离线、无系统 soffice、最小字体环境            | 是否作为相应平台正式文件操作的默认后端 |

测试文档应覆盖：中文长段落和混合字体、页眉页脚/脚注/分页、嵌图/图表、多系列与负值、合并表格、sheet 打印区域、跨页表头、ODS/XLS 输入、超大文件、损坏/不支持输入、受保护文件的明确错误。先定义可接受的语义与视觉偏差，不凭少数合成 fixtures 宣称全量保真。

验收记录应区分正确性（文字、数值、页/slide/sheet 选择、warnings）和运行成本（冷/热启动、耗时、峰值内存、输出/临时磁盘、取消清理）。具体阈值在选定真实使用场景后确定，本报告不虚构测量值。

最终判断：**值得验证和增量接入，优先补文件渲染/转换/正式输出验证；不值得为此推倒 Cognia 现有 Office 插件、公式引擎、截图工具或 PDF UI。**
