# GitHub Actions 临时 Host

[English](README.md) | [简体中文](README.zh-CN.md)

GitHub 托管的 Linux runner 可以创建临时 Cognia Host。创建、恢复和停止由本地桌面端管理；配对后，终端、文件、Git、Agent 进程和项目环境继续使用现有的经过身份验证的 Companion 协议。该方案不引入 SSH 传输，也不另建 GitHub 专用的 Agent 运行时。

## 安装 runner 模板

选择一个当前 GitHub 账号有权触发 Actions workflow 的仓库作为环境创建仓库。桌面端复用本机 `gh` 对 **github.com** 的现有登录。当前 artifact 协议不支持 GitHub Enterprise Server。

将以下文件原样复制到环境创建仓库：

| 本目录中的源文件                       | 目标位置                                  |
| -------------------------------------- | ----------------------------------------- |
| [cognia-runner.yml](cognia-runner.yml) | `.github/workflows/cognia-runner.yml`     |
| [action.yml](action.yml)               | `.github/cognia-runner/action.yml`        |
| [bootstrap.mjs](bootstrap.mjs)         | `.github/cognia-runner/bootstrap.mjs`     |
| [package.json](package.json)           | `.github/cognia-runner/package.json`      |
| [package-lock.json](package-lock.json) | `.github/cognia-runner/package-lock.json` |

先将这些文件提交到默认分支，使 GitHub 能识别可手动触发的 workflow。然后在仓库的 Actions variables 中设置 `COGNIA_RUNNER_ACTORS`，值为允许操作的 GitHub 登录名组成的 JSON 数组，例如 `["your-login"]`。未设置或空数组会拒绝所有运行。组织仓库也需要配置这一显式允许列表。

桌面端在触发 workflow 前，会解析所选分支对应的 commit，并校验这五个文件与桌面端内置模板一致。升级桌面端时应一并更新模板。需要自定义开发环境时，应修改镜像和项目环境配置，而不是修改控制脚本。界面中的 workflow ref 是**分支**，不是 tag。

Workflow 只检出自己的启动代码，并禁用 Git 凭据持久化。项目源码、对话上下文、模型密钥、插件凭据和配对秘密都不是 workflow dispatch 输入。Host 不会继承 Actions token 或 artifact runtime token。

## 准备镜像、创建并连接

打开 **设置 → 连接 → 远程主机 → GitHub runner 开发环境**，按三个步骤操作：

1. **仓库。** 填写 `owner/repo`，或粘贴 `https://github.com/owner/repo` 仓库地址，Cognia 会将其转换为 `owner/repo`。选择 workflow **分支**，不能使用 tag。点击**检查并继续**，检查本机 `gh`、当前 GitHub 账号、仓库写入权限及可用状态、分支 commit、已启用的 workflow，以及五个文件是否与内置模板一致。这些检查只读取 GitHub，不触发 job。按提示修复后可重新检查；修改仓库或分支后也需要重新检查。
2. **环境。** 填写名称，选择 60、120 或 240 分钟，或自定义 10 至 330 之间的整数分钟数。填写三个已发布的 Linux amd64 镜像：Cognia Host、Agent bundle 和开发镜像，都使用 `image@sha256:<64 位小写十六进制摘要>`。填写可访问的 Cognia 信令服务器 `wss://…` 地址，不能包含凭据、查询参数或 fragment。向导不会构建或发布镜像。点击**确认配置**进入下一步。
3. **确认。** 核对八个字段和 GitHub 账号，再明确点击**创建环境**。回执仅表示已记录创建请求，不代表 Host 已启动。关注下方环境状态，等待排队和准备完成，状态为**可以连接**后点击**连接**，与 Host 配对。

检查前，请在本机安装 GitHub CLI 并运行 `gh auth login`，按上文安装全部五个模板文件。检查通过**不代表**已验证 `COGNIA_RUNNER_ACTORS`、组织 Actions 策略、镜像是否可拉取或信令服务器是否可达；仍须配置允许操作的账号列表，并另行确认这些部署条件。检查总时限为 90 秒；超时或 API 失败也可能源于网络问题，不一定是登录失效。

使用 [Dockerfile.cognia-server](../../Dockerfile.cognia-server) 构建 Host，使用 [deploy/bundle/Dockerfile](../bundle/Dockerfile) 构建 Agent bundle。需要在 Host 上使用预装原生 Agent CLI 时选择 `runtime-full`；`runtime-slim` 提供 headless 服务。开发镜像提供项目工具链。将三个镜像发布到 runner 可以拉取的位置，必要时使用下文的 registry secret，并确认 Linux amd64 架构及 libc 兼容性。

向导会提示并恢复最近一次提交的有效配置。**重置表单**清空当前表单；仅编辑字段不会覆盖已保存配置。本地只保存八个公开字段，不保存配对凭据；存储不可用时仍可创建。操作失败或提交结果不确定时，请先**刷新状态**并**查看 GitHub 运行记录**，再决定是否提交新请求。前置检查失败时，修复问题后点击**检查并继续**重试。

配对会校验 Host fingerprint，通过共享凭据库保存设备凭据，并将 Host 加入普通远程主机注册表。连接会切换桌面端当前执行 Host。运行具体项目和 Agent 前，还需准备或传输工作区，并配置 Agent 及模型访问。即使已切换到远程 Host，创建、恢复状态和停止 runner 的操作仍由本地桌面端负责。

## 构建、发布并取得不可变镜像引用

在 Cognia 仓库根目录使用 Docker Buildx 构建。将 namespace 和发布 tag 替换为你有权限发布的实际位置，并在构建机器上通过惯用的 registry 登录流程完成认证。以下是供你在自己的环境执行的示例，不代表这些镜像已经发布。

```bash
export RUNNER_IMAGE_NAMESPACE=ghcr.io/your-owner
export RUNNER_IMAGE_TAG=your-release

docker buildx build --platform linux/amd64 --target runtime-full \
  -f Dockerfile.cognia-server \
  -t "$RUNNER_IMAGE_NAMESPACE/cognia-host:$RUNNER_IMAGE_TAG" --push .

docker buildx build --platform linux/amd64 -f deploy/bundle/Dockerfile \
  --build-arg BUNDLE_RELEASE_TAG="$RUNNER_IMAGE_TAG" \
  -t "$RUNNER_IMAGE_NAMESPACE/cognia-agent-bundle:$RUNNER_IMAGE_TAG" --push .

docker buildx build --platform linux/amd64 -f Dockerfile.project \
  -t "$RUNNER_IMAGE_NAMESPACE/cognia-development:$RUNNER_IMAGE_TAG" --push .
```

`Dockerfile.project` 是你自己的项目开发镜像文件，并非仓库已附带的文件。选择兼容项目工具链和 bundle libc probe 的基础镜像，将稳定依赖预装进去，并保留 `/bin/sh`。固定基础镜像和依赖版本，以获得可复现构建。只有不需要预装原生 Agent CLI 时，才将 Host target 从 `runtime-full` 换成 `runtime-slim`。Agent bundle 使用 Dockerfile 的最终镜像，没有 `runtime-full` target。libc、运行时可用性及兼容性限制见 [bundle 契约](../bundle/README.md)。

检查三个已推送的镜像引用：

```bash
docker buildx imagetools inspect "$RUNNER_IMAGE_NAMESPACE/cognia-host:$RUNNER_IMAGE_TAG"
docker buildx imagetools inspect "$RUNNER_IMAGE_NAMESPACE/cognia-agent-bundle:$RUNNER_IMAGE_TAG"
docker buildx imagetools inspect "$RUNNER_IMAGE_NAMESPACE/cognia-development:$RUNNER_IMAGE_TAG"
```

将每项输出中的 `Digest: sha256:…` 填入对应表单字段，组成 `ghcr.io/your-owner/image@sha256:…`。Tag 用于发布和检查；创建环境要求不可变 digest。如果使用镜像 index 的 digest，该 index 必须包含 Linux amd64。构建和推送成功本身不能证明真实 runner 启动或已认证 Agent session 可用。

## 可选的私有镜像仓库访问

在环境创建仓库的 **Actions secrets** 中设置 `COGNIA_RUNNER_REGISTRY_AUTH`，值为 Docker-config 格式的 JSON。使用仅能读取所需镜像的凭据，例如：

```json
{
  "auths": {
    "ghcr.io": {
      "username": "read-user",
      "password": "read-only-token"
    }
  }
}
```

每个 registry 条目也可以只使用 `auth`，值为 `username:password` 的 Base64 编码；或者只使用 `identitytoken`、只使用 `registrytoken`。不能混用这些形式。顶层只接受 `auths`，最多 32 个 registry，JSON 最大 48 KiB。`credsStore`、`credHelpers` 等 credential helper 配置会被拒绝。不设置或设为空值时使用匿名拉取。

这是 Actions secret，不是桌面表单字段，也不是 workflow dispatch 输入。Bootstrap 为三个并发镜像拉取创建独立、权限为 `0600` 的 Docker config，并在 setup 成功或失败后删除临时文件。只读 helper mount 将配置复制到受信任 Host 的 `/data/registry-auth.json`，文件权限为 `0600`，所有者为 UID 10001。既有 `COGNIA_REGISTRY_AUTH_FILE` 集成使用这一副本进行 registry 元数据 admission 和后续镜像拉取。该文件不会挂载进 Agent sandbox 子容器，并随租约 data volume 清理。Registry 授权不会配置或扩大模型/API 凭据权限。启用这一能力时，五个受信任模板文件必须一起更新。

## 自定义环境与注入任务输入

连接后复用已有功能：

- **项目运行环境**：选择开发镜像、不可变 Agent bundle、规格、生命周期、网络出口预设以及所需隔离级别。Runner 启用既有 sandbox pool，并通过 named volume 共享工作区。
- **项目 setup / bootstrap Agent**：在执行 Host 上运行现有的确定性 setup 和有界修复流程。将稳定依赖预装进镜像；项目专属初始化交给 setup。
- **任务工作区和附件**：使用既有的、经过身份验证的文件传输及所有权校验。桌面端的任意绝对路径并不是远程工作区；应先通过相应功能 clone 或传输项目。
- **指令和上下文**：通过正常的 Agent session 协议传输，保留原有的出站 PII 检查。
- **Skills**：使用现有的原子远程 Skill 同步，包括内容 hash、二进制资源和原生 Agent 镜像目录。
- **插件工具**：使用 session 范围内的 renderer tool-host bridge。仅提供 UI 的插件界面继续留在 Cognia。插件格式、权限和转换保真度仍决定原生 Agent 能否接收该插件；直接复制任意插件目录不等于完成安装。

远程插件桥只投射所选插件工具及权限、审查元数据。原生 Agent 的文件系统和 shell 操作仍由该 Agent 的执行后端负责。服务端拒绝通过插件桥夹带工作目录、环境变量、模型凭据或 Cognia 内置工具。

对于受支持的 Host 原生和 Docker sandbox Agent 运行时，选择 Cognia 模型会在已连接的 Host 上创建任务范围的 gateway lease。它只委托所选 provider 的一个凭据和模型，不会发布桌面端的完整 provider 配置。子进程收到短期 gateway token；provider 凭据留在 Host gateway 的内存中。租约不续期时两分钟后到期，任务持有期间每 30 秒续期。账号、provider 设置或 Host 变化都会使该授权失效。Agent 退出会释放租约；撤销设备或收回其执行权限也会阻止续期，并终止已激活的网关访问。上游必须使用公共 HTTPS：实际连接固定到已检查的 DNS 结果，禁用代理和重定向，并拒绝私有或本地地址。桌面端 loopback 模型网关不能直接当作远程 URL 使用。

Hosted plugin MCP 支持 Host 原生进程和通过 admission 的 Docker sandbox Agent，也支持在 session 进程创建前注册。容器路径使用受信任 sidecar 自己的 tool-host listener 和私有 `cognia-sandboxd` exec bridge，不向 Agent 暴露可自由选择目标的通用代理或 Docker socket。每个对话保留自己的 bearer token、session 和权限范围。Bridge 每 20 秒续期，native 租约为 60 秒；renderer 的 tool-host 租约也会在停止续期后到期。撤销设备、替换进程或 admission 变化会使桥失效。Host、其 sidecar 和 Agent bundle 需要一起更新；缺少该能力的旧 Host 或 helper 会被明确拒绝。

Docker 任务可以同时使用委托模型网关和所选插件工具。Host 校验模型 ticket 和插件服务租约，接好固定目标的私有 bridge 后才放行 Agent 启动屏障。插件 endpoint 在容器内保留相同 loopback 端口，因此后续 ACP session 配置以及 Pi/DSH 的 session 子进程能使用同一地址。预注册租约绑定配对设备和 Agent，不能指定转发目标。并发会话分别持有 token，bridge 生命周期通过引用计数管理。

Runner 委托使用已配对远程 Host 的 Companion task lease。本机 Tauri sandbox 使用本机原生 gateway ticket：Host 校验任务、token、当前账号 generation 和正在运行的 listener 后才授予 bridge 权限。撤销 ticket、切换账号或停止 listener 都会使授权失效。本机执行不会伪造配对设备身份。

### Agent 自定义

Agent 编辑器、检查器和聊天中的 Agent 管理器会保留命令、参数边界（包括带引号参数和空参数）、环境变量以及工作目录。路径必须属于所选 Host 或容器；编辑远程配置不会弹出桌面端的本地目录选择器。

选择 Cognia 模型时，由任务管理 provider 路由、凭据和配置 home。支持的运行时选项会保留，例如 Pi 显式指定的 extension、Skill、prompt template、system/append-system prompt 和 thinking 参数；Codex 经校验的指令和推理设置；Qwen 的 include directory、工具/MCP server 允许列表及 extension；OpenCode 的日志选项。与网关冲突或尚未支持的选项会明确报错，不会静默丢弃。显式文件引用必须已存在于任务可见的工作区，这不会自动传输桌面文件或启用 Host 全局配置发现。

OpenCode 内联配置（`OPENCODE_CONFIG_CONTENT`）还会保留命名 Agent、指令引用、Skills、斜杠命令、权限和 snapshot 设置。Bundle 中的 OpenCode ACP 使用 V1 schema：`agent`、`prompt`、`permission`、`command`、`skills.paths`；独立 V2 service 使用 `agents`、`system`、`permissions`、`commands` 和数组形式的 `skills`。Cognia 生成匹配的 provider 配置，并将自定义 Agent/命令的模型选择固定到本任务所选模型。例如，OpenCode ACP 的 `OPENCODE_CONFIG_CONTENT` 可填写：

```json
{
  "default_agent": "reviewer",
  "agent": {
    "reviewer": {
      "description": "审查代码变更",
      "prompt": "检查正确性并说明发现的风险。",
      "mode": "primary",
      "steps": 12,
      "permission": { "edit": "deny", "bash": "ask" }
    }
  },
  "instructions": ["./AGENTS.md"],
  "skills": { "paths": ["./skills"] }
}
```

引用文件必须存在于执行工作区，已有 Cognia 权限控制仍然生效。尚未支持的内联字段、任意 provider request 覆盖，以及外部 `OPENCODE_CONFIG`/`OPENCODE_CONFIG_DIR` 路径会被明确拒绝；此模式使用显式内联配置，Cognia 插件工具继续走已有插件桥。Bundle 中的 ACP executable 与 V2 service 是不同的版本/协议选择，不能仅凭 OpenCode 名称互换。字段依据固定版本上游的 [V1 Agent schema](https://github.com/anomalyco/opencode/blob/v1.18.32/packages/core/src/v1/config/agent.ts) 和 [V2 配置 schema](https://github.com/anomalyco/opencode/blob/v1.18.32/packages/core/src/config.ts)。

在 GitHub runner 或所选 Docker sandbox 中应使用 OpenCode ACP。V2 的直连 HTTP service 目前要求本机 Host 执行；其经过身份验证的容器 HTTP 转发尚未实现，因此选中容器后会在连接或发现服务之前明确拒绝，不能静默回退到 Host service。

Locale 和输出设置（`LC_CTYPE`、`TZ`、`NO_COLOR`、`FORCE_COLOR`）会贯穿 native 与 CLI 启动路径，包括 DSH。Codex ACP 还保留 `NO_BROWSER`、`INITIAL_AGENT_MODE`、`APP_SERVER_LOGS`；其中 `APP_SERVER_LOGS` 是日志目录，Agent 内层模式不能取消 Cognia 的外层执行约束。

额外 CLI 和非秘密环境变量需要 Host 管理者显式允许。对于 runner，可在受信任 Host 镜像中加入以下策略，同时保留原有 entrypoint 和非 root 用户：

```dockerfile
ARG COGNIA_HOST_BASE
FROM ${COGNIA_HOST_BASE}
ENV COGNIA_AGENT_COMMAND_ALLOWLIST='["my-agent"]' \
    COGNIA_AGENT_ENV_ALLOWLIST='["AGENT_PERSONA"]'
```

构建时将 `COGNIA_HOST_BASE` 设置为固定 digest 的 Host 镜像，发布产物后把新 digest 填入 runner 表单。原生执行需要将可执行文件安装到该 Host 镜像；sandbox 执行还要求固定 digest 的 Agent bundle 在 manifest 和兼容的 libc 目录中提供该命令。只把二进制放入开发镜像不够。遵循 [bundle 契约](../bundle/README.md)，固定依赖并验证 launcher。在 Cognia 中选择匹配的、已支持的 Agent 协议，命令填写不含路径的 `my-agent`。允许启动命令不等于为任意 CLI 自动增加协议适配器或 Cognia 模型适配器。

这两个策略变量都是 JSON 数组，只从 Host 进程环境读取。默认策略仍然受限；策略格式错误会拒绝启动。Loader、解释器、认证范围和 Host 控制变量不能通过此方式放行，shell、解释器及包执行器命令也不能额外放行。Renderer 把这些策略变量塞入 Agent 环境不能自行授权。秘密应使用既有凭据与环境 secret 机制，不要写入镜像层或普通 Agent 配置。

每个数组最多 8 KiB、64 个不重复名称，每个名称最多 128 个 ASCII 字符，精确匹配且区分大小写。不设置变量或使用 `[]` 会保留默认策略；空字符串、重复项以及不合法或保留的名称会拒绝启动。额外命令不能包含路径或 `.exe`、`.cmd`、`.bat` 后缀。

### 当前能力矩阵

这里的“Host 原生进程”指在临时 Cognia Host 容器内启动 Agent CLI；“Docker sandbox”指由该 Host 管理、使用独立执行容器的任务环境。两者都位于同一台 GitHub 托管 runner VM 上。表格描述当前实现边界，不等同于已通过真实 GitHub 部署验收。

| 能力                           | Host 原生进程                                                                         | Docker sandbox                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 终端、文件、Git 和远程工作区   | 使用既有 Companion 协议                                                               | Host 管理工作区，按已有容器挂载规则提供访问                                                     |
| Agent 运行时                   | 依赖 Host 镜像中已安装的 CLI；需要时使用 `runtime-full`                               | 使用固定版本 Agent bundle 和开发镜像，并通过环境兼容性校验                                      |
| 工具链和系统依赖自定义         | 构建自定义 Host 镜像；保持既有启动契约                                                | 构建开发镜像，并通过项目运行环境选择                                                            |
| 项目 setup 和 bootstrap 修复   | 在对应执行 Host 上使用已有流程                                                        | 使用项目环境及其隔离、网络出口规则；不绕过 admission                                            |
| 指令、上下文和附件             | 走现有 session 与工作区传输路径                                                       | 走相同路径，并受容器可见工作区约束                                                              |
| Skills                         | 原子同步至远程 Host，并使用原生 Agent mirrors                                         | 是否可见取决于相应运行时同步、挂载与 Agent 支持；不能仅以 Host 同步成功判断                     |
| 桌面插件工具的 hosted MCP      | 通过 session-scoped tool-host bridge 访问                                             | persistent 和 ephemeral Agent 均支持预注册与经过身份验证的 exec bridge；需要更新 Host 和 bundle |
| 原生 Agent 的文件和 shell 工具 | 由 Host 原生执行后端负责                                                              | 由容器执行后端负责，不通过插件桥转发                                                            |
| 仅提供 UI 的插件               | UI 留在 Cognia 桌面端                                                                 | UI 留在 Cognia 桌面端                                                                           |
| 模型访问与凭据                 | 所选 Cognia 模型通过任务范围的公共 HTTPS gateway lease 访问，或使用受支持的 Host 配置 | 经固定目标私有 bridge 使用相同委托租约，保留最新 admission 校验与启动屏障                       |
| 必需容器隔离                   | 原生进程模式本身不提供这一保证                                                        | 通过既有 mandatory-isolation 控制要求容器隔离                                                   |
| 私有 registry 登录             | 通过可选 Actions secret 为受信任 Host 配置 registry 访问                              | 由受信任 Host 拉取及校验；凭据文件不挂载进 Agent sandbox 子容器                                 |
| 跨 job 保留工作区或镜像缓存    | 不保证；租约结束会删除临时卷                                                          | 不保证；子容器及其所属卷也会清理                                                                |

自定义命令/环境变量授权、已支持的协议适配器和 bundle 中的命令可用性是分别校验的要求。创建 runner 不代表任意 Agent 与插件组合都能迁移。

## 启动速度与生命周期

界面区分发送创建请求、排队、环境准备、就绪、停止中和终态。GitHub 排队时间由外部平台决定，没有启动延迟保证。Bootstrap 会并发拉取三个固定 digest 的镜像，并在 Actions 日志中分别报告每个镜像的拉取耗时及 Host 整体就绪耗时。

将稳定依赖预构建到体积适当的镜像中，可以减少每个任务重复安装依赖的时间。但新的 GitHub 托管 VM 仍可能需要冷拉取整个镜像；本方案不承诺 warm pool 或跨 job 镜像缓存。排查速度时，应分开观察 GitHub 排队、镜像拉取、Host/relay 就绪以及项目 setup，各阶段的优化方式不同。

租约预算从 bootstrap 开始执行时计时，workflow 的 350 分钟 timeout 是外层上限。界面显示的到期时间依据 GitHub run 的开始时间估算，可能略早于 bootstrap 的实际 deadline。Runner 不会自动续租。停止或到期前，应保存、提交或导出需要保留的工作；runner 的卷是临时存储。

本地租约记录会在 dispatch 前写入。即使创建请求的响应丢失，桌面端也会保留这一不确定租约，并通过唯一 workflow run name 恢复，不会直接重复触发 job。恢复过程会验证仓库、workflow、commit、原始操作者及首次 run attempt。切换本机 GitHub 账号后，不能取消另一个账号记录的租约。

点击**停止 runner**后，只有 GitHub 确认 workflow 已结束，界面才会显示停止完成。在此之前会保持“等待取消确认”。取消失败仍保留记录，便于刷新和重试。确认停止和失败终态都会取消对关联活动 Host 的选择；未知状态保留恢复入口。

## 配对与安全边界

配对邀请有效期较短，在租约存续期间会定期更新。Artifact 中只有使用 P-256、HKDF-SHA256 和 AES-256-GCM 加密的数据，并绑定 lease ID 和 workflow run ID。接收方私钥保留在本地租约记录中；明文邀请不会写入 Actions 日志或 artifact。

每个 Host 在自己的私有 data volume 内生成凭据库 master key。清理流程先停止 Host，再移除所属子容器和卷，并删除加密 artifact；GitHub 在 job 结束时销毁托管 VM。

这是单用户临时 Host。受信任的 Host 持有 Docker daemon 连接；Agent sandbox 容器不会获得这一连接。任务需要容器隔离时，应使用既有 mandatory-isolation 控制。原生 Agent 运行在受信任的 Host 环境内，不能把这一模式视为具备独立容器隔离。

任务配置 home 使用受限权限和受保护的账号/设备绑定。共享同一容器及 Unix 用户的持久化任务仍处于同一个工作区信任边界；任务私有目录不构成互不信任的同级进程之间的隔离。删除保留的任务状态会校验归属，并拒绝删除正在使用的状态，不会仅删除 Host 侧文件就报告完成。

Ephemeral 容器删除后，其 Agent 配置 home 和原生 session 历史也会消失。需要在进程退出后恢复原生 session 时，应选择 persistent 项目运行环境；无论哪种模式，都要在 runner 租约结束前导出工作成果。

## 故障排查

| 现象                          | 检查与处理                                                                                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 创建前提示输入不合法          | 检查 `owner/repo`、分支、10–330 分钟范围和三个小写 `sha256` digest；signaling URL 必须是无凭据、无查询参数及 fragment 的 `wss://` 地址                                   |
| Workflow 找不到或模板不匹配   | 确认五个文件已提交到默认分支，并存在于所选分支；按当前桌面端版本重新同步完整模板，不要只更新单个启动文件                                                                 |
| Workflow 被跳过               | 检查仓库 Actions variable `COGNIA_RUNNER_ACTORS` 是否为有效 JSON 数组，并包含当前 GitHub 登录名；组织仓库同样需要设置                                                    |
| 无法 dispatch、读取状态或取消 | 检查本机 `gh` 的 github.com 登录、仓库与 Actions 权限；切换账号不能操作另一账号的已记录租约                                                                              |
| 长时间处于排队状态            | 在“查看 GitHub run”中检查 GitHub runner 排队及仓库/组织限制；排队不是镜像或项目 setup 阶段                                                                               |
| 长时间准备或 Host 启动失败    | 检查 Actions 中镜像拉取和 bootstrap 阶段，确认镜像可访问、Linux amd64 架构正确且符合 Host 启动契约；使用私有 registry 时，检查 Actions secret 的 JSON 格式和镜像读取权限 |
| Host 无法产生 relay 配对邀请  | 检查 signaling relay 的可达性和 Host 启动状态。模板只接受带 relay 信息且未过期的 `cgnp4` 邀请；不要通过记录明文邀请排查                                                  |
| 配对失败或邀请过期            | 刷新租约状态，确认仍然就绪后重试连接；邀请在租约期间会更新。不要将旧邀请当作持久连接凭据保存                                                                             |
| Agent 找不到项目文件          | 确认工作区已在远程 Host 上 clone 或传输，并检查容器可见的工作区；桌面绝对路径不会自动变成远程路径                                                                        |
| Agent 无法访问模型或插件工具  | 模型检查所选凭据、公共 HTTPS 和 gateway admission；插件检查 Host/sidecar/bundle 版本、租约、格式与权限。检查启动屏障是否超时；不要直接传入桌面 loopback URL              |
| 自定义命令或环境变量被拒绝    | 检查 Host 镜像中的 operator allowlist、CLI 安装和 sandbox bundle manifest；Agent 自身的环境不能设置 Host 授权策略。Cognia 模型模式还会校验运行时选项                     |
| 点击停止后仍显示等待取消确认  | 等待 GitHub 确认 job 结束并刷新；请求失败时保留记录以便重试，不要把“已发送取消”当作资源已释放                                                                            |
| 桌面断开或重启后状态不确定    | 从已有租约记录刷新恢复，并检查其 GitHub run；不要为恢复同一任务直接创建另一份环境                                                                                        |
| 停止后文件丢失                | 临时卷不保证跨 job 保留；结束前使用既有 Git、文件传输或 artifact 导出功能保存工作                                                                                        |

## 验证范围

本地检查覆盖 provider 状态转换、账号与 run 来源校验、不确定结果、取消失败、损坏租约记录恢复、artifact 限制及 Node 到 Rust 的加密互操作。Bootstrap 测试检查镜像和输入校验、仅通过 relay 配对、秘密排除及按资源归属清理。UI 和 transport 测试覆盖 Host 路由、管理和恢复。

Gateway 定向测试覆盖任务、设备与账号归属、撤销以及凭据隔离。Bridge 测试使用真实本地 TCP socket 和 helper 协议检查转发、到期与清理；这些不等于 Docker 或 GitHub 端到端测试。界面生命周期验证使用合成的 native IPC。

自定义测试覆盖参数往返、运行时设置保留、operator 策略和路由覆盖拒绝。Sandbox helper 测试覆盖启动就绪、受保护的绑定、符号链接/硬链接拒绝以及保留状态清理。

真实 GitHub 调度、镜像可用性、relay 配对和端到端 Agent 执行，需要已安装模板、实际镜像 digest 和获得授权的环境创建仓库。本地测试通过，以及使用 mock IPC 的浏览器生命周期验证，都不能证明这些真实部署条件已满足。部署验收还应分别执行 Host 原生 Agent 与所需 Docker sandbox/插件组合，记录实际结果。

资料：[GitHub JavaScript action metadata](https://docs.github.com/en/actions/reference/workflows-and-actions/metadata-syntax)、[@actions/artifact](https://github.com/actions/toolkit/tree/main/packages/artifact)、[GitHub Actions limits](https://docs.github.com/en/actions/reference/limits)。
