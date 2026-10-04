# Cognia 版 Pi LaTeX 工作台

[English](README.md) · **简体中文**

一个可安装的 Cognia 桌面插件，封装了
[Pi LaTeX Workbench](https://github.com/Arxtect/pi-latex-workbench)：一个面向
LaTeX 项目的受控智能体工作台。每次编辑都落在内容寻址的快照上，受保护内容会停在
只有宿主才能批准的关卡前；发布只有在获得绑定摘要的授权、并且洁净环境重建通过后
才会交付。

插件以三种方式提供工作台：

1. **Cognia 智能体**通过 27 个声明式 `latexwb_*` 工具调用工作台的宿主 CLI
   （`latexwb`），并由五个技能引导。
2. **你自己的 Pi** 可以把工作台作为 Pi 包安装。
3. **Cognia 托管的 Pi 智能体**可以选择加入，加载工作台扩展，成为受控的 LaTeX 工作者。

三种方式下，审批都来自你，绝不来自模型。

## 前置条件

| 要求                                                                  | 用途                                        |
| --------------------------------------------------------------------- | ------------------------------------------- |
| `PATH` 上的 Node.js ≥ 24（`node:sqlite`、原生 TypeScript 类型剥离）   | 所有工具；插件在 `requires.binaries` 中声明 |
| npm ≥ 10                                                              | 一次性依赖准备步骤（`prepare`）             |
| `PATH` 上的 `tectonic`（已验证 0.17.0，例如 `brew install tectonic`） | 编译——唯一的 LaTeX 引擎                     |
| 约 3 GB 磁盘                                                          | 预置的离线 Tectonic 资源包                  |
| macOS arm64 + Xcode 命令行工具（`swiftc`）                            | 页面渲染、文本提取与页面审阅                |
| Pi ≥ 0.85.1                                                           | 仅安装到 Pi 和托管 Pi 智能体时需要          |

仅限桌面端：插件的工具会启动宿主进程，因此在浏览器、移动端和无头外壳中被禁用。

## 构建并安装插件

在仓库根目录执行（构建复用根目录安装的 `esbuild` 与 `jszip`；`dist/` 是被 git
忽略的构建产物）：

```bash
pnpm exec node plugins/pi-latex-workbench/build.mjs
```

它会生成 `plugins/pi-latex-workbench/dist/index.js` 和
`plugins/pi-latex-workbench/dist/cognia-pi-latex-workbench-0.1.0.zip`。清单的
`main` 是 `dist/index.js`，属于被 git 忽略的构建产物，所以在构建运行之前插件无法
加载——这也是从 GitHub URL 安装行不通的原因（仓库里没有 `dist/index.js`）。随后
用以下两种方式之一安装到正在运行的 Cognia 桌面实例：

- **Cognia CLI**（安装 ZIP；CLI 会解析相对路径）：

  ```bash
  cognia plugin install plugins/pi-latex-workbench/dist/cognia-pi-latex-workbench-0.1.0.zip --json
  ```

- **加载本地目录**：在 **插件** 面板工具栏中使用 **加载本地目录…**，选择
  `plugins/pi-latex-workbench` 目录（需先完成上面的构建）。Cognia 会把该目录复制到
  它的插件存储中。

插件面板自带的归档安装只接受 WASM 插件，会拒绝这个前端插件。ZIP 只包含
`bundle_include` 白名单中的文件：这些文档、`pi/`、`skills/` 以及 `vendor/`
快照——绝不包含 `node_modules`、预置的工具链或工作台状态。

## 一次性宿主准备

以下步骤在你的机器上、任何智能体之外运行：

1. **安装依赖。** 打开 **插件 → Pi LaTeX 工作台 → Pi 包**，运行 **准备**。你批准
   确切的命令后，Cognia 会在插件的 `vendor/` 目录中、不经 shell 运行：

   ```bash
   npm install --omit=dev --omit=peer --ignore-scripts --no-audit --no-fund
   ```

   它只安装 `ajv`/`ajv-formats` 并链接工作台自己的包。`--omit=peer` 让
   `@earendil-works/pi-*` 和 `typebox` 不进入包内，这是 Pi 的要求（Pi 会映射到它
   自己的副本）。`latexwb_*` 工具同样依赖这一步。

2. **预置工具链与渲染器**（宿主命令——约 2.9 GB 的下载超过工具调用 600 秒的上限，
   因此没有工具提供它）。在插件的安装目录中执行：

   ```bash
   node vendor/packages/cli/src/bin.ts provision-toolchain   # 固定版本的离线 Tectonic 资源包
   node vendor/packages/cli/src/bin.ts provision-renderer    # Swift/PDFKit 渲染助手，macOS arm64
   node vendor/packages/cli/src/bin.ts doctor                # BUILD_READY 表示就绪
   ```

   它们写入 `vendor/runtime/toolchain/` 与 `vendor/runtime/render/`，插件更新会
   替换这两个目录——更新后请重新运行。

## 在 Cognia 中使用

**设置**（插件 → Pi LaTeX 工作台 → 配置）：

| 设置         | 默认值     | 含义                                                                                                         |
| ------------ | ---------- | ------------------------------------------------------------------------------------------------------------ |
| `project`    | 空         | 默认工作台项目 id；同时绑定托管 Pi 智能体（为空 = 未绑定、不生效）                                           |
| `protection` | `strict`   | 仅用于托管 Pi 智能体：`authoring` 允许新增的受保护内容无需逐补丁授权即可应用。Cognia 自己的工具始终是 strict |
| `stateDir`   | `.latexwb` | 工作台状态（SQLite 数据库、blob、任务目录），相对于工作区                                                    |

**技能。** `latex-workbench` 向智能体讲解受治理的流程（导入 → 检视 → 提议 →
应用 → 写回 → 编译 → 检查 → 渲染），并把 `vendor/resources/skills/*/references/guide.md`
中的上游方法映射到这些工具上。四个显式技能用于发起任务：**LaTeX: write**、
**LaTeX: revise**、**LaTeX: tune layout**、**LaTeX: check**（在输入框的技能选择器
中选择）。上游的 Pi 技能本身不会注册——它们使用的是 Cognia 智能体没有的 Pi
`latex_*` 工具。

**工具。** 每次调用都以工作区为工作目录运行
`node <插件目录>/vendor/packages/cli/src/bin.ts <command> …`。`cli:execute`
确认框会显示带绝对脚本路径的确切命令。路径参数被限制在工作区内，ID 必须符合
工作台的 id 语法。

| 工具                                                     | 命令                                                            | 访问              |
| -------------------------------------------------------- | --------------------------------------------------------------- | ----------------- |
| `latexwb_doctor`                                         | `doctor`                                                        | 读                |
| `latexwb_import`                                         | `import <dir> [--project]`                                      | 写                |
| `latexwb_inspect`                                        | `inspect`                                                       | 读                |
| `latexwb_jobs`                                           | `jobs`                                                          | 读                |
| `latexwb_build`                                          | `build [--snapshot] [--target] [--preset] [--clean]`            | 写                |
| `latexwb_check_run` / `latexwb_check_report`             | `check-run` / `check-report`                                    | 写 / 读           |
| `latexwb_render_pages` / `latexwb_render_text`           | `render-pages` / `render-text`                                  | 写                |
| `latexwb_artifact_save`                                  | `artifact-save <id> <dest>`                                     | 写                |
| `latexwb_materialize`                                    | `materialize --dir [--snapshot]`                                | 写                |
| `latexwb_patch_propose` / `_show` / `_apply` / `_revert` | `patch-propose` / `patch-show` / `patch-apply` / `patch-revert` | 写 / 读 / 写 / 写 |
| `latexwb_release_prepare` / `_freeze` / `_package`       | `release-prepare` / `release-freeze` / `release-package`        | 写                |
| `latexwb_release_status` / `_list`                       | `release-status` / `release-list`                               | 读                |
| `latexwb_workflow_start` / `_resume` / `_cancel`         | `workflow-start` / `workflow-resume` / `workflow-cancel`        | 写                |
| `latexwb_workflow_status` / `_list`                      | `workflow-status` / `workflow-list`                             | 读                |
| `latexwb_assets_inspect`                                 | `assets-inspect <assetId>`                                      | 写                |
| `latexwb_review_coverage`                                | `review-coverage`                                               | 读                |

除 `doctor` 外，每个工具都会传入 `--state <stateDir>` 和 `--project`（仅
`import` 可省略），并且所有工具都以 `LATEXWB_PRINCIPAL=cognia-agent` 运行，
审计记录会标明是智能体。

## 信任边界

工作台的原则是**模型永远不能批准自己的工作**。CLI 把调用它的人视为宿主操作员，
因此插件不开放任何授予、记录或绕过审批的命令：

| 未开放                                       | 原因                                       |
| -------------------------------------------- | ------------------------------------------ |
| `approve`（补丁与动作授权）                  | 授权由操作员决定                           |
| `approvals-list`、`approvals-revoke`         | 审批台账保持为宿主界面                     |
| `review-page`                                | 页面结论属于人工审阅（`human.review`）     |
| `materialize --takeover`                     | 接管从未同步过的目录会越过冲突检查         |
| `materialize recover`                        | 日志恢复是操作员的修复动作                 |
| `provision-toolchain`、`provision-renderer`  | 宿主预置；下载超过工具 600 秒上限          |
| `jobs --watch`                               | 无上限的轮询                               |
| `artifact-cat`、`events`、`cancel`、`export` | 原始字节、事件流以及已被其他工具覆盖的别名 |

`latexwb_patch_apply` 之所以开放，是因为 CLI 以 **strict** 语义应用补丁：含有受
保护变更（数学、标签、引用键、报告的数值、引文、未知命令、模板文件）的补丁，
只有在你已经授予绑定其摘要的宿主审批时才会应用；否则返回 `POLICY_DENIED`，智能体
会报告补丁 id 和所需的授权。`latexwb_release_package` 在每一页都有你的审阅结论、
且存在绑定摘要的 `release.package` 授权之前，都会以 `blocked` 结束。
`manifest.test.ts` 固定了这份清单。

你在自己的机器上、于工作区目录中授权：

```bash
node <插件目录>/vendor/packages/cli/src/bin.ts approve --patch <patchId> --project <id> --state .latexwb
node <插件目录>/vendor/packages/cli/src/bin.ts review-page --artifact <pageImageId> --verdict approved --project <id> --state .latexwb
node <插件目录>/vendor/packages/cli/src/bin.ts approve --action release.package --digest <approvalDigest> --snapshot <snapshotId> --project <id> --state .latexwb
```

或者在工作台 Pi 会话中使用 `/latex approve`。

## 安装到你的 Pi

**插件 → Pi LaTeX 工作台 → Pi 包 → 安装**（用户或项目范围）会在 **准备** 运行过
之后执行 `pi install <插件目录>/vendor`（Pi 不可用时则把路径记录到 Pi 的
`settings.json`）。Pi 随后加载 `vendor/package.json` →
`packages/adapter-pi/extensions/workbench.ts`。未绑定时它不生效；按上游文档为
会话绑定：

```bash
LATEXWB_STATE=$PWD/.latexwb LATEXWB_PROJECT=demo pi
```

八个 `latex_*` 工具、`/latex` 命令、`/latex-write|revise|tune|check` 以及审批
对话框，见 `vendor/docs/PI-SESSION.md`。

## 托管 Pi 智能体（选择加入）

Cognia 的 `pi-rpc` 智能体可以选择加入 `cognia-pi-latex-workbench/latex-workbench`。
Cognia 随后用 `-e` 加载 `pi/cognia-workbench.ts`，并把插件设置作为
`COGNIA_PIPKG_*` 变量转发：`LATEXWB_PROJECT` ← `project`，`LATEXWB_PROTECTION`
← `protection`，`LATEXWB_WORKSPACE` = `local`，以及 `STATE_DIR` +
`WORKSPACE_DIR`——入口把两者拼接为 `LATEXWB_STATE`（拒绝工作区之外的状态目录）。
你已设置的变量优先。随后入口原样加载内置的扩展。该包会**接管会话**：智能体只能
使用八个 `latex_*` 工具，审批通过会话对话框或 `/latex approve` 由你给出。

## 目录结构

```text
plugin.json            清单：cliTools、skills、configuration、piPackages、打包白名单
src/index.ts           激活生命周期（纯声明式，无命令式注册）
pi/cognia-workbench.ts 托管会话的 Pi 扩展入口
pi/env-binding.ts      COGNIA_PIPKG_* → LATEXWB_* 绑定（纯函数）
skills/                五个 Cognia 技能
scripts/sync-vendor.mjs  确定性的 vendor 刷新与校验
vendor/                原样的上游快照（VENDOR.md、vendor-lock.json）
manifest.test.ts       清单契约、信任边界、与上游一致性
build.mjs              esbuild + 按 bundle_include 生成安装 ZIP
```

## 维护

```bash
pnpm test -- plugins/pi-latex-workbench          # 全部插件测试
pnpm plugin:pi-latex-workbench:check             # vendor/ == vendor-lock.json
node plugins/pi-latex-workbench/scripts/sync-vendor.mjs --upstream <checkout> --ref <ref>
```

`vendor/` 不参与 Cognia 的 TypeScript、Jest、ESLint、Prettier 与作者导入检查：
它是上游自己的严格 ESM 项目。只能用脚本刷新，然后依据
`vendor/packages/cli/src/bin.ts` 重新核对 `cliTools` 参数；当参数、工作流 id 或
托管工具列表与快照不一致时，`manifest.test.ts` 会失败。

## 许可

上游仓库在内置的提交中**没有 LICENSE 文件**，因此本插件不声明任何许可
（`"license": "UNLICENSED"`）。在本插件——或任何包含 `vendor/` 的产物——发布到
本仓库之外之前，必须与上游所有者（Arxtect）确认分发条款。详见
[VENDOR.md](VENDOR.md)。
