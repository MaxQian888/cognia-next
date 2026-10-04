# Pi LaTeX Workbench

[English](README.md) · **简体中文**

面向 LaTeX 项目的受控 agent 工作台。模型在 Pi 会话里通过八个受治理的
`latex_*` 工具完成论文的写作、修改、编译与发布——每一次编辑都落在
内容寻址的 snapshot 上，敏感改动必须等宿主侧（host）审批放行，而发布包
只有在拿到 digest 绑定的授权、且净室重建 sha256 完全一致后才会产出。

## 特性

- **自然语言写作** —— 也可以用 `/latex-write`、`/latex-revise`、
  `/latex-tune`、`/latex-check` 这些 prompt 快捷指令。领域 skill 按需
  加载；续写/跟进会从最新的 head snapshot 继续，草稿 PDF 不需要走
  正式 release 流水线。
- **受控会话** —— 模型只能触达 `latex_*` 工具：没有 bash、没有文件
  工具、不能改绑项目。审批只来自宿主（会话内的你或宿主 CLI），模型
  永远无法自批。
- **受治理的编辑** —— 精确文本锚点的 `replace` 编辑（无需数字节）、
  最小 diff 提案、区分“新增”与“修改已有”公式/标签/引用的受保护内容
  分析、过期 head 冲突检测，每个动作都有审计事件。
- **就地审批** —— 交互式会话中，受保护编辑在应用前会直接询问你（仅批准
  本次，或把本会话切到 authoring 模式：新内容直接落地，改动已有公式仍需
  确认）；也可用 `/latex pending` / `/latex approve` / `/latex mode`，或在
  宿主上 `latexwb approve`。
- **面向真实文档的模板** —— 中文论文/学位论文（ctex + GB/T 7714）、英文
  论文/报告、beamer 幻灯片（中/英）、求职信和试卷；每个模板都有摘要校验，
  均可离线编译。
- **真实编译** —— 固定版本的离线 Tectonic 工具链；逐页 PNG 渲染供
  视觉审阅；结构化诊断与 artifact 绑定。
- **托管工作流** —— repair、revise、bibliography、data-assets、
  template-migration，以及一条带门禁的 release 流水线，终点是确定性
  打包 + 净室重建校验。
- **日常写作的草稿检查** —— `latex_check` 的 `draft` 规则集（类似 chktex /
  Overleaf 检查，作用于已编译草稿）：未定义引用、重复标签、参考文献中缺失的
  引用、缺少标题/标签的浮动体、TODO/占位文本、排版规范与编译日志警告，均给出
  文件:行号。`/latex-check` 以此为起点。
- **诚实的检查** —— 凡是机器无法验证的项一律报 `needs-review`，
  绝不报 `pass`。

## 使用方法

工作台有两个操作面：**受控 Pi 会话**（模型在其中写作）和**宿主 CLI**
（`node packages/cli/src/bin.ts`，加入 `PATH` 后即为 `latexwb`），
后者用于导入项目、发放审批、跑检查和 release 流水线。

### 1. 安装并初始化宿主环境（一次性）

前置要求：Node ≥ 24（用到 `node:sqlite` 和 TS 类型擦除）、npm ≥ 10、
`PATH` 上已有 `tectonic` 可执行文件（已验证 0.17.0，例如
`brew install tectonic`——初始化步骤只下载它的 bundle，不下载程序本身）、
渲染助手需要 macOS arm64 + Xcode CLT（`swiftc`）、agent 会话需要
Pi ≥ 0.85（已在 0.85.1 与 0.87.0 上验证）、tectonic bundle 约需 3 GB 磁盘。
不需要 latexmk、Docker 或其他 TeX 后端——tectonic 是唯一引擎。

```bash
git clone <repo> && cd pi-latex-workbench
npm install                                     # workspaces 安装，无编译步骤

node packages/cli/src/bin.ts provision-toolchain # 固定版本的离线 tectonic bundle（约 2.9 GB）
node packages/cli/src/bin.ts provision-renderer  # Swift/PDFKit 渲染助手，仅 macOS arm64
node packages/cli/src/bin.ts doctor              # 探测宿主环境 → DoctorReport JSON
```

环境就绪时 doctor 报告 `BUILD_READY` 并以 0 退出；缺少 latexmk/Docker 只是
`info`，渲染助手未初始化是 `warning`。详细说明与全部 doctor 代码见
[docs/INSTALL.md](docs/INSTALL.md)。

可选：把 CLI 放进 `PATH` —— `cd packages/cli && npm link` 会暴露
`latexwb` 命令，与 `node packages/cli/src/bin.ts` 完全等价。

### 2. 导入项目

```bash
node packages/cli/src/bin.ts import path/to/my-paper --project demo
node packages/cli/src/bin.ts inspect --project demo
```

状态默认落在 `./.latexwb`（SQLite `workbench.db` + CAS `blobs/` +
作业目录 `jobs/`）；加 `--state <dir>` 可换位置。也可以在会话内用
`/latex init --template <id> --target <id>` 从批准的模板新建项目。

### 3. 安装到 Pi

**常驻安装** —— 把本仓库注册为一个 Pi 包，一次即可：

```bash
pi install /absolute/path/to/pi-latex-workbench
```

根 manifest 只加载 workbench 扩展。**未绑定项目时是惰性的**——普通
Pi 会话的工具和 prompt 完全不受影响，`latex_*` 工具只会提示没有绑定
项目。要让某个会话成为 LaTeX worker，为那个会话导出绑定变量（不要
全局设置）：

```bash
LATEXWB_STATE=$PWD/.latexwb LATEXWB_PROJECT=demo pi
```

**按会话 / worker 调用** —— 不安装，显式加载扩展（父 agent 拉起
专用 worker 也是这种方式）：

```bash
# 交互式
LATEXWB_STATE=$PWD/.latexwb LATEXWB_PROJECT=demo \
  pi -e /absolute/path/to/pi-latex-workbench/packages/adapter-pi/extensions/workbench.ts

# 一次性 / 脚本化
LATEXWB_STATE=$PWD/.latexwb LATEXWB_PROJECT=demo \
  pi -p --no-session -ne \
  -e /absolute/path/to/pi-latex-workbench/packages/adapter-pi/extensions/workbench.ts \
  "缩短引言并重新编译"
```

绑定由宿主通过环境变量持有——模型无法改绑：

| 环境变量 | 默认值 | 含义 |
|---|---|---|
| `LATEXWB_STATE` | `./.latexwb` | workbench 状态目录（db + CAS + jobs） |
| `LATEXWB_PROJECT` | — | 绑定的项目 id（工具调用**必填**） |
| `LATEXWB_WORKSPACE` | `local` | workspace 作用域 |
| `LATEXWB_PRINCIPAL` | `pi-operator` | 工具动作记录的主体 |
| `LATEXWB_SESSION` | `pi-<pid>` | 审计中的会话 id |
| `LATEXWB_POLICY` | `default` | 审批查询用的 policy id |
| `LATEXWB_PROTECTION` | 宿主策略（`strict`） | `authoring`：新增的受保护内容无需逐个 patch 授权（适合无人值守的 worker）；无法识别的值一律按 `strict` 处理 |
| `LATEXWB_REPO_ROOT` | 由扩展文件路径推导 | 仓库根目录（含 `resources/`、`runtime/`、`migrations/`） |

**选择模型**：使用 `-ne` 时不会自动加载 provider 扩展，需要用 `-e` 显式加载，
例如用 Command Code provider 运行 `commandcode/deepseek/deepseek-v4-flash`：

```bash
LATEXWB_STATE=$PWD/.latexwb LATEXWB_PROJECT=demo LATEXWB_PROTECTION=authoring \
  pi -p --no-session -ne \
  -e ~/.pi/agent/npm/node_modules/pi-commandcode-provider/index.ts \
  -e /absolute/path/to/pi-latex-workbench/packages/adapter-pi/extensions/workbench.ts \
  --model commandcode/deepseek/deepseek-v4-flash "写一篇中文短论文并编译成 PDF"
```

### 4. 用 agent 写作

会话内直接说自然语言即可；快捷指令会展开为批准过的任务模板：

| 快捷指令 | 作用 |
|---|---|
| `/latex-write <brief>` | 按写作简报起草或扩写文档 |
| `/latex-revise <request>` | 修改选定文本，保留无关内容 |
| `/latex-tune <request>` | 调整排版、浮动体、间距或指定页面 |
| `/latex-check <request>` | 只审阅源码/编译/版面，不做编辑 |
| `/latex-help` | 显示命令目录 |

另外 `/repair` 和 `/release` 作为 Pi prompt 模板提供，分别对应编译排错和
正式发布流程。每一轮模型都会拿到当前绑定、head snapshot、target id 和 skill 目录；
skill 通过 `latex_project resource` 按需加载。编辑经 `latex_patch`
以最小 diff 落在不可变 snapshot 上——跟进修改从最新 head 继续，
不会重新导入。

**新建项目**从批准模板开始（`latex_project init`），agent 会按语言和文档
类型选择：`zh-article`、`zh-thesis`、`article-basic`、`report-basic`、
`beamer-basic`、`zh-beamer`、`letter-basic`、`exam-basic`。替换模板里未改动
过的示例内容视为“新写内容”。

**受保护的编辑**：每个提案都会列出受保护变更（公式、标签、引用、报告数值、
引文、不熟悉的命令），并标明是*新增*还是*修改/删除*。默认 **strict** 模式下
任何受保护变更都需授权；**authoring** 模式下新增内容直接生效，只有改动已有
受保护内容才需授权。授权只来自你：

- 交互式会话：agent 应用受限 patch 时弹出对话框（仅批准本次 / 批准并切到
  authoring 模式 / 查看 diff / 拒绝）；
- 会话内命令：`/latex pending`、`/latex approve [patchId]`、
  `/latex mode strict|authoring`；
- 宿主 CLI：`node packages/cli/src/bin.ts approve --patch <patchId> --project demo`。

模型永远不能给自己的工作批票；`/latex status` 可查看 job 和 workflow。

**取出结果**：`/latex pdf --open` 把最新 PDF 保存到 `<state>/exports/<project>/`
并打开；`/latex sync` 通过带日志的同步把修改后的源码写回导入目录——导入后你在
磁盘上改过的文件会被判为冲突，绝不覆盖。

### 5. 编译、渲染、检查（宿主 CLI）

```bash
node packages/cli/src/bin.ts build --project demo --target default
node packages/cli/src/bin.ts jobs --project demo

# 草稿检查（引用、标签、文献、浮动体、占位文本、排版、编译日志）
node packages/cli/src/bin.ts check-run --project demo --artifact <pdfArtifactId> --ruleset draft

node packages/cli/src/bin.ts render-pages --project demo --artifact <pdfArtifactId> [--pages 1,3]
node packages/cli/src/bin.ts review-page --project demo --artifact <pageImageId> --verdict approved
node packages/cli/src/bin.ts check-run --project demo --artifact <pdfArtifactId> --ruleset release

# 把草稿 PDF 存到本地
node packages/cli/src/bin.ts artifact-save <pdfArtifactId> out.pdf --project demo

# 把 head 写回导入目录（带日志、冲突安全）
node packages/cli/src/bin.ts materialize --project demo --dir path/to/my-paper
```

文档编译失败时 `build` 以 4 退出（仍会打印带诊断的 JobResult）；其他错误在
stderr 输出 JSON 格式的 `ToolError` 并以 3 退出。

### 6. 正式发布包

```bash
node packages/cli/src/bin.ts release-freeze --project demo --snapshot <snap> --target default --profile submission
# 输出 approvalDigest；把宿主授权绑定到它：
node packages/cli/src/bin.ts approve --project demo --action release.package \
    --digest <approvalDigest> --snapshot <snap>
node packages/cli/src/bin.ts release-package --project demo --release <releaseId> --artifact <pdfArtifactId>
node packages/cli/src/bin.ts release-status <releaseId> --project demo
```

`release-package` 要求每个渲染页都有人工审阅结论（`requireAllReleasePagesReviewed`）
以及 digest 绑定的授权，否则以 `blocked` 收尾并列出每个未通过的门禁。
`submission-ready` 表示检查全部通过、页面已审阅，且暂存的 PDF 在净室里以相同
sha256 重建成功。

### 7. 托管工作流

会话内的 `/latex repair|review|bib|figure|migrate|release`，或宿主侧
`workflow-start <definitionId>`，会启动持久化工作流；它们可能停在
`waiting-input`（`agent.*` 步骤等待你提供一个基于当前 head 的
`{"patchId": …}`）或 `waiting-approval`（授权后 resume）。`revise` 与
`template-migration` 的最后一步比较尚未实现，因此会如实以 `blocked` 结束：

```bash
node packages/cli/src/bin.ts workflow-list --project demo
node packages/cli/src/bin.ts workflow-status <workflowId>
node packages/cli/src/bin.ts workflow-resume <workflowId> --input answer.json --project demo
node packages/cli/src/bin.ts workflow-cancel <workflowId>
```

推荐使用扁平命令拼写；嵌套写法（`release freeze`、`check run`、
`workflow start`……）仍然兼容。完整命令参考：
[docs/RUNBOOK.md](docs/RUNBOOK.md)；会话绑定、环境变量与信任边界：
[docs/PI-SESSION.md](docs/PI-SESSION.md)。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/INSTALL.md](docs/INSTALL.md) | 前置要求、初始化、如何阅读 doctor 报告 |
| [docs/PI-SESSION.md](docs/PI-SESSION.md) | agent 会话：绑定、八个工具、`/latex` 命令、保护模式与审批、信任边界 |
| [docs/RUNBOOK.md](docs/RUNBOOK.md) | 全部宿主 CLI 命令与参数、patch/context 文件格式、宿主策略、状态目录、备份、恢复、排错 |
| [docs/UNSUPPORTED.md](docs/UNSUPPORTED.md) | 尚未实现的部分，以及已实现部分的边界 |
| [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md) | 100 项验收矩阵及复验方法 |
| [docs/EVAL.md](docs/EVAL.md) | 真实 agent canary 与实录运行 |
| [docs/ENVIRONMENT.md](docs/ENVIRONMENT.md) | 开发主机的探测输出记录 |
| [docs/adr/](docs/adr/) | 设计决策 ADR-0001…0007 |
| [fixtures/README.md](fixtures/README.md) | 示例与验收 fixture |

以上文档均为英文。

## 实录的 agent 运行（`results/`）

真实端到端会话，transcript 与交付物俱全：

- `results/pi-live-20260923T001330/` —— 13 段 transcript 的视觉模型
  运行（deepseek-v4.1-flash）：带审批门修复 broken fixture，
  走完 figure/参考文献/边界/修订流程，到达 `submission-ready`，
  净室重建 sha256 一致。模型基于真实 PNG image block 描述了渲染页。
- `results/pi-papers-20260922T114056/` —— 一句话 prompt 写出的三篇
  完整论文（`prompt-*.txt` 是原文）：7 页分析学论文、10 页系统论文
  （TikZ + algorithm2e + booktabs）、15 页综述（37 篇参考文献）。
  两篇完整发布，一篇在宿主门禁处如实 `blocked`。
- `results/pi-deepseek-20260922T110918/` —— 对 broken 数学 fixture
  的修复（deepseek-v4.1-flash，纯文本）：`POLICY_DENIED` → 宿主授权 →
  apply → 编译 → `submission-ready`。

运行中值得注意的诚实行为证据：模型拒绝覆盖一个并发应用的 patch、
原样上报 `POLICY_DENIED` 而不尝试绕过、拒绝「修正」一个它无法证明
有误的表格数值、（纯文本模式下）如实说明渲染页被剥离而不是幻觉
出画面。

ADR-0007 写作轮次（空项目写中文论文、修表格、做幻灯片、会话内审批对话框）
的测量结果见
[docs/acceptance/AGENT-WRITING-2026-09-24.md](docs/acceptance/AGENT-WRITING-2026-09-24.md)；
其 JSONL transcript 未提交到仓库。

复现方法：在一个目录里放个最小 `main.tex`，`import` 后（或在会话内用模板
`init`）启动绑定会话，用自然语言提需求即可。受保护编辑需要授权（新增内容也可
用 authoring 模式）；打包需要页面人工审阅 + digest 绑定的 `release.package`
授权。canary 流程见 [docs/EVAL.md](docs/EVAL.md)。

## 仓库结构

```
packages/contracts/    @latexwb/contracts — schema、生成的类型、校验器、错误码
packages/storage/      @latexwb/storage — SQLite、migrations、outbox、CAS
packages/core/         @latexwb/core — 服务：import/snapshot/build/patch/approvals/
                       workflows/bibliography/assets/checks/render/review/release/inspect
packages/runtime/      @latexwb/runtime — tectonic + docker runner、工具链初始化、
                       Swift/PDFKit 渲染助手、doctor 探测
packages/adapter-pi/   @latexwb/adapter-pi — Pi 扩展：8 个 latex_* 工具、prompt
                       快捷指令、/latex 宿主命令、操作者审批对话框、逐轮 agent
                       context、会话边界
packages/cli/          @latexwb/cli — latexwb 宿主 CLI（扁平 + 嵌套命令）
resources/             skills/（8 个，digest 固定）、prompts/、workflows/（7 个定义 +
                       operation 注册表）、templates/（8 个批准模板）、recipes/、
                       bibliography/、profiles/{domains,outputs,venues} + capability、
                       check、resource、source 注册表
runtime/               host-policy.json、toolchain-lock.json、presets/；初始化后生成的
                       toolchain/ 与 render/（gitignore）
migrations/            SQLite migrations 0001–0004
fixtures/              示例项目、30 个领域 fixture（index.json）、exam-marks
docs/                  INSTALL、RUNBOOK、PI-SESSION、EVAL、UNSUPPORTED、ACCEPTANCE、
                       ENVIRONMENT、adr/（ADR-0001…0007）、acceptance/（结果 + 实录）
results/               实录的 agent 会话（transcript + 交付物）
scripts/               generate-types.py（schema → 类型）、generate-known-commands.py
                       （bundle → 命令词表）、pi-canary.sh、acceptance-dom.mjs
```

权威设计输入只读地放在 `design/pi-latex-workbench-v2/`（交接副本——
不要改；要改的是 `packages/contracts/schemas/` 下的仓内 schema，
走 ADR 流程）。

## 状态

M0–M5 均已实现并有真实测试覆盖，另含两轮 agent 可用性改进：字节偏移与可读
diff（ADR-0006），以及写作界面（ADR-0007——锚点编辑、保护模式、会话内审批、
模板、草稿检查、诊断定位）。100 项验收矩阵
（[docs/ACCEPTANCE.md](docs/ACCEPTANCE.md)）为 **97 pass /
3 partial / 0 fail**。在提交 `1ddf4dd`（2026-09-25）上：`npm test` 共 333 个
测试——332 pass、1 个如实跳过的 docker 用例；`npm run test:contracts` 37 pass；
13 个 fixture 的 DOM 验收 sweep 13/13。使用 `deepseek-v4-flash` 的真实 agent
运行记录见
[docs/acceptance/AGENT-WRITING-2026-09-24.md](docs/acceptance/AGENT-WRITING-2026-09-24.md)。

已知限制是承重设计的一部分——见 [docs/UNSUPPORTED.md](docs/UNSUPPORTED.md)
和 `resources/profiles/capability-registry.json`：本机没有 Docker
runner、渲染仅支持 macOS arm64、`answer-mapping` 是唯一不支持的
release 检查、local-runner 的 cpu/内存限制未强制执行，且任何检查
都不声称科学正确性——合规不等于正确。

## 开发

```bash
npm install              # workspaces 安装；无编译步骤
npm run typecheck        # 全包 tsc --noEmit
npm test                 # 跨包 node --test
npm run test:contracts   # 仅 contracts 包测试
npm run contracts:types  # 从 schema 重新生成 types.generated.ts（需要 python3）
npm run doctor           # latexwb doctor → DoctorReport JSON
python3 scripts/generate-known-commands.py   # 从已初始化的 bundle 重新生成已知命令词表
```

CI（`.github/workflows/ci.yml`，ubuntu 上的 Node 26）依次运行 `npm ci`、
typecheck、`types.generated.ts` 与 schema 是否同步的检查，以及 `npm test`。
需要已初始化 bundle、渲染助手或 Docker 的测试大多会在缺失时带原因跳过。

纯 ESM、TypeScript strict（`erasableSyntaxOnly`、
`verbatimModuleSyntax`）、无构建步骤——包通过 `exports` 直接消费
`.ts` 源码，import 带显式 `.ts` 后缀（ADR-0002）。每个「已定义但未
实现」的表面都抛出在 `docs/UNSUPPORTED.md` 登记的带码
`NotImplementedError`。agent 评估 canary：
[docs/EVAL.md](docs/EVAL.md) + `scripts/pi-canary.sh`。
