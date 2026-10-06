# 插件独立加载修复与验证

验证日期：2026-10-06（Asia/Shanghai）。本报告对应此前 `REPORT.md` 中发现的问题，原始审计证据保留。

## 结果

仓库中的 62 个 frontend 插件已经可以构建成单独 ZIP，并在仓库外解压后通过真实 `PluginLoader` 和 Node frontend importer 加载。检查覆盖 manifest 一致性、命名扩展导出、样式及图标资源；不会替用户调用每个插件的外部服务或执行其业务工具。

浏览器内置列表包含 52 项，其中 1 项仅用于 E2E，生产环境为 51 项。所有这些内置插件现在从生成的独立代码资源加载，registry 不再静态导入插件 TypeScript 实现。独立安装的同 ID 插件优先于 builtin，显式卸载不会在下一次启动被自动补回。

## 修复范围

| 原问题                                      | 修复                                                                                           |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| builtin 依赖宿主静态源码导入                | 统一生成 CommonJS 资源、完整 manifest、共享模块声明、资源 URL 和入口 SHA-256；保留 E2E 筛选    |
| source manifest 缺少运行时导出的贡献声明    | 第一方构建器提取完整导出 manifest，规范化主入口及次级入口，并在所有安装来源检查声明一致性      |
| 构建覆盖源文件、遗漏次级入口                | Rust CLI 和第一方构建器均输出到 dist，编译贡献入口并重写发布 manifest                          |
| 样式、图片、主题、LSP/IDE 程序丢失          | 按 contract 和 bundle_include 收集资源，保留可执行权限，合并导入 CSS；支持插件相对资源路径     |
| Node 直接导入 CJS 导致 SDK 实例或缓存不一致 | 通过宿主共享模块执行发布包，重载重新读取代码，保留源码开发入口                                 |
| pet SDK 子路径缺失                          | 补齐 SDK 子路径解析及 TypeScript 映射                                                          |
| release CSP 禁止 eval                       | 浏览器改用 CSP 允许的 Blob script；并发执行分别管理 exports，错误、超时及卸载清理有测试        |
| PDF worker 依赖宿主 public 目录             | 独立包内嵌 worker，浏览器转为 Blob URL，插件停用时释放；适配当前 pdf.js 的 loadingTask.destroy |
| 本地/市场调用旧安装 IPC                     | 新增通用 ZIP 文件、URL、目录 staging API，并注册 Tauri command 和权限                          |
| 下载完成但未进入完整生命周期                | 市场、本地及 URL 路径进入 manager 事务：校验、注册、配置持久化、启用、提交；失败回滚           |
| 配置在安装提交后才写入                      | 在激活及 finalize 前保存配置，写入失败按事务回滚                                               |
| builtin reseed 覆盖独立安装或复活卸载项     | 保留独立来源、已装版本和显式卸载记录；恢复扫描保留已验证的可执行贡献                           |
| 签名校验使用临时目录名                      | 使用安装 receipt 中的真实安装位置；校验失败处于可回滚事务内                                    |
| 特例发布包漏资源                            | 补全 GitHub delivery 图标资产并重新生成兼容性 ZIP                                              |

作者工具链同时补齐 SDK 对 canonical package 的源码映射，重新生成 81 份作者声明。scaffold、SDK peer 和对应 lockfile 的 ACP 统一使用宿主的 1.5.0，避免宽松版本范围安装到移除了所需类型的版本。

SDK 原构建仅生成部分声明，对其余导出缺少类型文件只打印 warning。现改为从真实 runtime entry 列表生成所有声明，并检查每个导出目标及声明依赖；不会用 root 的宽泛再导出冒充子路径 API。声明构建将临时入口放到同一个目录，共用 TypeScript program，避免多目录入口重复分配内存。发布包检查覆盖 55 个类型导出、84 个声明文件。

新增检查同时拒绝缺失的声明 chunk 和未声明的外部类型依赖，因此将实际声明使用的 `zod` 补为显式 peer（与当前仓库的 `^4.6.5` 对齐），不再依赖其他库的间接安装。

## 使用方式

```bash
# 全部 frontend 插件
pnpm plugin:packages:build

# 单个插件，可以传 plugin ID 或目录名
pnpm plugin:packages:build cognia-pdf

# 重新构建，并在仓库外加载所有 ZIP
pnpm plugin:packages:verify

# 应用内置插件资源
pnpm plugin:builtin:build
```

发布目录为 `dist/plugins/<id>/`，ZIP 为 `dist/plugins/<id>-<version>.zip`。在插件设置中使用 ZIP 文件或下载 URL 安装。未构建的 TypeScript/TSX 源码目录不是发布包；安装器会拒绝未编译运行入口。通用安装 UI 保留 WASM 权限确认，frontend 不会进入 WASM 权限流程。

独立发布校验已接入 `scripts/gates/check-all.mjs` 的 plugin-sdk gate。详细作者说明见 `docs/content/docs/plugin-dev/packaging.mdx`。

## 验证证据

| 验证                                  | 结果                                                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 第一方 frontend ZIP 独立加载          | 62/62；构建后解压到系统临时目录，通过真实 loader/importer                                         |
| 最终插件回归                          | 30 suites，744 tests 通过                                                                         |
| 构建器与 gate 脚本                    | 36 tests 通过                                                                                     |
| Rust frontend builder                 | 17 tests 通过                                                                                     |
| Rust CLI build command                | 13 tests 通过                                                                                     |
| Rust runtime installer                | 29 tests 通过                                                                                     |
| Rust runtime contract                 | 12 tests 通过                                                                                     |
| Rust runtime tauri-host feature       | cargo check 通过                                                                                  |
| Rust CLI 实际构建 fixture             | 主入口、次级入口、CSS、资源、源文件保留、可执行文件权限通过                                       |
| 浏览器 CSP                            | 从当前 tauri.conf.json 读取原始 CSP；eval 确实被阻止，GitHub delivery 发布包仍可加载              |
| 浏览器共享模块与清理                  | SDK 身份一致；并发结果 17/23；预期执行/语法错误正确上抛；遗留 Blob scripts 为 0、全局桥接变量为空 |
| PDF 实际浏览器 worker                 | 读取真实一页 PDF，pageCount=1，warnings=[]                                                        |
| plugin:contract:check                 | 通过                                                                                              |
| plugin:author-imports                 | 67 个插件及模板通过                                                                               |
| 本次修改范围 ESLint、git diff --check | 通过                                                                                              |
| 完整 pnpm build                       | 通过，127/127 静态页面导出；使用 COGNIA_DISABLE_WEBPACK_CACHE=1                                   |

浏览器原始结果：`browser-csp-repair-results.json`。本地完整验证日志保存在 `.codex-tmp/plugin-independent-audit-2026-10-05/`；原始测试 JSON 在该目录的 `final-regression-tests.json`，构建输出在 `retry-build.log`。完整构建前发生两次 ENOSPC，移除可再生成的 `.next/cache/webpack` 后重跑成功。

作者工具的独立验收也已通过：`author-types:check` 确认 81 份声明一致；实际 scaffold 完成依赖安装、严格类型检查、15 项测试、esbuild、native lint 和 native ZIP 构建。另有 9 项 Node 作者工具回归、1 项 Rust template 测试通过。`plugin-ui` 的 JS/CJS 与声明构建、`i18n:build:check`、`lint:i18n` 均通过。

SDK package clean build 和打包后的独立 consumer 检查通过，覆盖 ESM/CJS、全部子路径导入、pet/i18n/agent-turn 的实际类型及错误跨子路径导出检查、Deep Research 插件作者类型检查。日志为 `.codex-tmp/plugin-csp-probe/sdk-package-build.log` 与 `sdk-package-consumer.log`。该 package consumer 延用原有 `skipLibCheck` 来隔离链接的未发布 provider 依赖；独立 scaffold 的类型检查没有使用此开关。

最后一次声明重新生成之后，再次通过 `author-types:check` 和实际 scaffold 全流程。新增 SDK artifact validator 的 5 项行为测试通过；新的声明构建配置也通过定向 TypeScript 检查。最终作者侧日志为 `.codex-tmp/plugin-csp-probe/sdk-author-types-check.log` 与 `sdk-author-scaffold.log`。

## 验证边界

- 完整 app build 的现有配置跳过 TypeScript 语义校验，不能替代独立 typecheck。
- 当前共享工作区还有 agent、identity、push 等并行修改引起的全库 typecheck 错误，不能宣称整个仓库静态检查全部通过。
- 未运行完整桌面安装包构建、移动端设备验收，未逐个调用需要账号、网络或外部进程的插件业务能力。已验证发布包加载、安装事务、资源与构建链路，业务服务配置仍由插件自身需求决定。
- WASM、Python、hybrid 等插件继续使用其已有 runtime；“62/62”仅指此次重点验证的 frontend 插件，不代表跨平台业务功能全量验收。
