# `claude-app-mirror` 项目研究：可验证安装包镜像与 Cognia 借鉴建议

**研究日期：** 2026-08-24  
**外部源码基线：** `Wangnov/claude-app-mirror@a21125ce29b1275c405eddb209e5f69bd2444fe6`；共享依赖 `Wangnov/agents-mirror-kit@8ea9a358824fd57abdf3324d040bbbb03096a19c`  
**Cognia 对照基线：** `MaxQian888/cognia-next@2f28a3be514780765b133e13cd83f26003fd288d`  
**研究边界：** 只使用仓库源码、GitHub API / Releases / Actions / Issues、同作者共享仓库，以及 Anthropic 当前官方文档；没有下载或执行约 800 MB 的安装包，也没有触发发布工作流。

## 结论先行

`claude-app-mirror` 不是 Claude 客户端的开源实现，也不是破解、重打包或替代更新器；它是一条很窄的**二进制搬运与分发流水线**：从 Anthropic 无鉴权的更新重定向接口探测当前 macOS DMG、Windows x64/arm64 MSIX，内容指纹变化时才下载，随后生成 SHA-256 与 provenance-like manifest，发布到 GitHub Releases，并把最新版同步到 Cloudflare R2 短链。它的主要价值是改善中国大陆到 `api.anthropic.com` / `downloads.claude.ai` 链路不稳定时的下载可达性，而不是改变 Claude 的功能、账号、授权或运行时行为。[项目定位与边界](https://github.com/Wangnov/claude-app-mirror/blob/a21125ce29b1275c405eddb209e5f69bd2444fe6/README.md#L38-L54) [non-goals](https://github.com/Wangnov/claude-app-mirror/blob/a21125ce29b1275c405eddb209e5f69bd2444fe6/README.md#L116-L122)

它最值得 Cognia 借鉴的是三组工程手法：**轻量 probe 与大文件下载解耦、公开 manifest/校验和、主调度加低频兜底调度**。但不能照搬其信任模型和发布顺序：流水线没有验证 macOS code signature/notarization 或 Windows Authenticode，只在下载后自己计算 hash；同一发布通道提供的 checksum 不是独立可信根；GitHub Release 先于 R2 同步发布，R2 失败后下一轮会因 manifest 相同而跳过，不能自动自愈；release job 还会在 R2 secrets 环境中执行由可移动 tag 引入的共享脚本。[下载校验](https://github.com/Wangnov/claude-app-mirror/blob/a21125ce29b1275c405eddb209e5f69bd2444fe6/scripts/download-artifacts.sh#L43-L78) [发布与 R2 顺序](https://github.com/Wangnov/claude-app-mirror/blob/a21125ce29b1275c405eddb209e5f69bd2444fe6/.github/workflows/mirror.yml#L92-L179) [共享依赖加载](https://github.com/Wangnov/claude-app-mirror/blob/a21125ce29b1275c405eddb209e5f69bd2444fe6/.github/workflows/mirror.yml#L62-L67)

Cognia 已经由 Tauri 构建一次并生成 updater 签名、`*.sig` 和 `latest.json`，以嵌入应用的 minisign 公钥验证更新；完整平台矩阵先进入 draft，全部成功后才发布。因此若要吸收此项目，应新增**字节不变的次级镜像 / 故障转移分发层**，复制已经签名的产物和签名文件，不应再建第二套 build、repackage 或 signing pipeline。[Cognia updater 基线](https://github.com/MaxQian888/cognia-next/blob/2f28a3be514780765b133e13cd83f26003fd288d/src-tauri/UPDATER.md#L1-L18) [draft-to-publish 设计](https://github.com/MaxQian888/cognia-next/blob/2f28a3be514780765b133e13cd83f26003fd288d/src-tauri/UPDATER.md#L72-L97) [内置 updater 公钥与端点](https://github.com/MaxQian888/cognia-next/blob/2f28a3be514780765b133e13cd83f26003fd288d/src-tauri/tauri.conf.json#L87-L93)

## 1. 目的与价值主张

项目针对的是“官方安装包存在，但官方更新 API 与 GCS 下载链路在目标网络中慢或不可达”的可用性问题。GitHub Releases 保存历史版本，R2 的 `latest/*` 固定键只保存最新版并提供短链；项目明确不构建、不修改、不重打包 Claude，也不处理登录、订阅、模型接入、Cowork 或 Claude Code binary 等客户端运行问题。[用途、资产和历史版本](https://github.com/Wangnov/claude-app-mirror/blob/a21125ce29b1275c405eddb209e5f69bd2444fe6/README.md#L40-L50) [GitHub Release 与 R2 用法](https://github.com/Wangnov/claude-app-mirror/blob/a21125ce29b1275c405eddb209e5f69bd2444fe6/README.md#L70-L85) [维护者对运行问题的边界说明](https://github.com/Wangnov/claude-app-mirror/issues/2#issuecomment-4931780939)

Windows 选择 MSIX 而不是官网的小型 `ClaudeSetup.exe`，原因是后者只是在线 bootstrapper，安装时仍会从 `downloads.claude.ai` 拉取真正的 MSIX；镜像 bootstrapper 无法解决慢链路。macOS 则镜像 universal DMG。[格式选择](https://github.com/Wangnov/claude-app-mirror/blob/a21125ce29b1275c405eddb209e5f69bd2444fe6/README.md#L52-L54)

这个价值主张成立的条件是用户愿意把 GitHub / Cloudflare 视为额外分发方，并仍以安装包签名和官方来源指纹判断真实性。仓库本身不是 Anthropic 官方分发渠道，也没有形成独立的 binary signing trust root。[项目自述边界](https://github.com/Wangnov/claude-app-mirror/blob/a21125ce29b1275c405eddb209e5f69bd2444fe6/README.md#L110-L122)

## 2. 架构、模块图与运行时数据流

```text
Cloudflare Cron Worker（每 15 分钟）
        │ workflow_dispatch
        ├──────────────────────────────┐
        ▼                              │
GitHub Actions mirror.yml              │
  └─ probe job                         │
      ├─ GET 3 个 Anthropic latest/redirect（读取 307 Location）
      ├─ HEAD downloads.claude.ai 具体对象（长度/ETag/Last-Modified）
      └─ 对比最新 GitHub Release 的 release-manifest.json
             │ changed                 │ unchanged / 旧版本 / tag 已存在
             ▼                         └─ no_changes，结束
      release job
      ├─ 下载 DMG + 2 个 MSIX，核对 Content-Length
      ├─ 计算 SHA-256，生成 schema v2 manifest 与双语 release notes
      ├─ 先发布 GitHub Release（历史归档）
      ├─ R2 staging 上传并回读 manifest
      └─ 依次覆盖 R2 latest/{mac,win-x64,win-arm64,checksums,manifest}
                                      │
GitHub schedule（每 6 小时）───────────┘  作为调度兜底

每日 stats.yml
  └─ Cloudflare R2 Analytics 的按日 GetObject 聚合
      → R2 stats/state.json + stats/downloads.json 徽标
```

这条链路没有应用服务器或数据库；持久状态由 GitHub Releases、R2 objects，以及 release/R2 中的 manifest 共同承担。Cloudflare Worker 只是控制面调度器，真正的探测、下载和发布在 GitHub-hosted Ubuntu runner 上完成。[调度实例说明](https://github.com/Wangnov/claude-app-mirror/blob/a21125ce29b1275c405eddb209e5f69bd2444fe6/cloudflare/github-dispatcher/README.md#L1-L23) [mirror workflow](https://github.com/Wangnov/claude-app-mirror/blob/a21125ce29b1275c405eddb209e5f69bd2444fe6/.github/workflows/mirror.yml#L1-L56) [统计 workflow](https://github.com/Wangnov/claude-app-mirror/blob/a21125ce29b1275c405eddb209e5f69bd2444fe6/.github/workflows/stats.yml#L1-L55)

### 2.1 模块职责

| 模块                                          | 职责                                                                                                                          | 关键契约                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/probe-release.sh`                    | 探测三平台 redirect、解析版本/构建 hash、HEAD 元数据、生成 schema v1 probe manifest、比较最新 release、处理降级版本与重复 tag | 输出 `should_release`、`release_tag`、`latest_tag`、`manifest` 等 GitHub outputs；URL + `Content-Length` 是 stable fingerprint。[源码](https://github.com/Wangnov/claude-app-mirror/blob/a21125ce29b1275c405eddb209e5f69bd2444fe6/scripts/probe-release.sh#L75-L142) [去重与降级保护](https://github.com/Wangnov/claude-app-mirror/blob/a21125ce29b1275c405eddb209e5f69bd2444fe6/scripts/probe-release.sh#L180-L220) |
| `scripts/download-artifacts.sh`               | 按 manifest 下载三个大文件，重试并做跨 macOS/Linux `stat` 的 byte-size 校验                                                   | 不做签名或预期 SHA 校验；预期长度为 0 时跳过长度验证。[源码](https://github.com/Wangnov/claude-app-mirror/blob/a21125ce29b1275c405eddb209e5f69bd2444fe6/scripts/download-artifacts.sh#L35-L78)                                                                                                                                                                                                                       |
| `scripts/prepare-release-metadata.sh`         | 对下载结果计算 SHA-256，把 manifest 升级为 schema v2，生成 `SHA256SUMS.txt` 和中英 release notes                              | tag 默认为 `claude-app-v<version>`；manifest 记录每个资产的 `sha256` 和规范化 `assetName`。[源码](https://github.com/Wangnov/claude-app-mirror/blob/a21125ce29b1275c405eddb209e5f69bd2444fe6/scripts/prepare-release-metadata.sh#L34-L89)                                                                                                                                                                            |
| `.github/workflows/mirror.yml`                | 编排 probe/release/no-changes，控制权限与 concurrency，发布 GitHub Release，再同步 R2                                         | 默认 token 只读，release job 提升为 `contents: write`；同一镜像不并发。[权限与并发](https://github.com/Wangnov/claude-app-mirror/blob/a21125ce29b1275c405eddb209e5f69bd2444fe6/.github/workflows/mirror.yml#L18-L27) [release job](https://github.com/Wangnov/claude-app-mirror/blob/a21125ce29b1275c405eddb209e5f69bd2444fe6/.github/workflows/mirror.yml#L52-L106)                                                 |
| `cloudflare/github-dispatcher/wrangler.jsonc` | 该镜像实例的 Worker 名称、cron、目标 repo 和 secret 声明                                                                      | Worker 源码不在主仓，而在共享 kit；实例要求 `GITHUB_TOKEN`。[配置](https://github.com/Wangnov/claude-app-mirror/blob/a21125ce29b1275c405eddb209e5f69bd2444fe6/cloudflare/github-dispatcher/wrangler.jsonc#L1-L21)                                                                                                                                                                                                    |
| `agents-mirror-kit`                           | 提供 dispatcher、R2 upload/cleanup、旧 release notes 清理和累计下载统计                                                       | app-specific probe/download 保留在主仓，通用基础设施由 pinned tag 引入。[kit 边界](https://github.com/Wangnov/agents-mirror-kit/blob/8ea9a358824fd57abdf3324d040bbbb03096a19c/README.md#L7-L29)                                                                                                                                                                                                                      |
| `.github/workflows/ci.yml`                    | `bash -n`、ShellCheck、actionlint                                                                                             | 只做静态检查，不做 probe/download/release 的行为测试或真实安装测试。[源码](https://github.com/Wangnov/claude-app-mirror/blob/a21125ce29b1275c405eddb209e5f69bd2444fe6/.github/workflows/ci.yml#L13-L41)                                                                                                                                                                                                              |

### 2.2 关键数据对象

probe manifest 先记录 `platform/arch/format/redirect/version/url/fileName/buildHash/contentLength/etag/lastModified`，下载完成后再增加 `sha256/assetName` 并把 `schemaVersion` 从 1 升到 2。最新版 `1.34493.1` 的公开 manifest 确实包含三平台各自的上游 URL、长度、ETag、Last-Modified 与 SHA-256。[manifest 构造](https://github.com/Wangnov/claude-app-mirror/blob/a21125ce29b1275c405eddb209e5f69bd2444fe6/scripts/probe-release.sh#L108-L178) [schema v2 增补](https://github.com/Wangnov/claude-app-mirror/blob/a21125ce29b1275c405eddb209e5f69bd2444fe6/scripts/prepare-release-metadata.sh#L70-L89) [最新版 manifest](https://github.com/Wangnov/claude-app-mirror/releases/download/claude-app-v1.34493.1/release-manifest.json)

## 3. 核心实现技术

1. **用版本无关 redirect 做轻量发现。** 三个稳定 endpoint 返回具体 artifact URL，路径包含版本与构建 hash；只有该 URL 或长度变化才进入大文件阶段，从而把高频轮询成本压到几个 header request。[探测说明](https://github.com/Wangnov/claude-app-mirror/blob/a21125ce29b1275c405eddb209e5f69bd2444fe6/scripts/probe-release.sh#L4-L17) [manifest fingerprint](https://github.com/Wangnov/claude-app-mirror/blob/a21125ce29b1275c405eddb209e5f69bd2444fe6/scripts/probe-release.sh#L135-L147)
2. **多重去重与回退保护。** 除了对比最新版 manifest，还拒绝发布比当前 release 更老的探测版本，并在预测 tag 已存在时退出；`FORCE_RELEASE` 与手工 `RELEASE_TAG` 保留运维逃生口。[判定逻辑](https://github.com/Wangnov/claude-app-mirror/blob/a21125ce29b1275c405eddb209e5f69bd2444fe6/scripts/probe-release.sh#L180-L218)
3. **可靠下载而非功能验证。** curl 配置 connect timeout、全错误重试和最长重试窗口；下载后只比较实际 bytes 与 HEAD 的 `Content-Length`，随后才计算本次下载的 SHA-256。[重试与 size check](https://github.com/Wangnov/claude-app-mirror/blob/a21125ce29b1275c405eddb209e5f69bd2444fe6/scripts/download-artifacts.sh#L35-L73)
4. **可审计发布元数据。** release 同时携带三个 installer、`SHA256SUMS.txt` 与 `release-manifest.json`；后者既记录官方 URL/HTTP 指纹，也记录镜像资产的 SHA-256。[release asset 列表](https://github.com/Wangnov/claude-app-mirror/blob/a21125ce29b1275c405eddb209e5f69bd2444fe6/.github/workflows/mirror.yml#L92-L106) [最新版 release](https://github.com/Wangnov/claude-app-mirror/releases/tag/claude-app-v1.34493.1)
5. **staging 后再写 latest aliases。** R2 先写 `staging/<tag>-<run>` 并回读比较 manifest，之后逐对象覆盖 `latest/*`，再从公开域名回读 manifest；退出时清理 staging。[R2 流程](https://github.com/Wangnov/claude-app-mirror/blob/a21125ce29b1275c405eddb209e5f69bd2444fe6/.github/workflows/mirror.yml#L143-L179)
6. **双调度与单飞发布。** Cloudflare 每 15 分钟 dispatch，GitHub schedule 每 6 小时兜底；workflow `concurrency.cancel-in-progress=false` 避免两个发布互相取消或覆盖。[调度](https://github.com/Wangnov/claude-app-mirror/blob/a21125ce29b1275c405eddb209e5f69bd2444fe6/cloudflare/github-dispatcher/README.md#L20-L23) [concurrency](https://github.com/Wangnov/claude-app-mirror/blob/a21125ce29b1275c405eddb209e5f69bd2444fe6/.github/workflows/mirror.yml#L25-L27)
7. **最小用户统计。** 每日 job 从 R2 Analytics 查询指定 `latest/*` keys 的按日 `GetObject` 聚合，只保存累计数和 per-day 计数；查询维度是 date/objectName/request count，不读取 IP 或用户身份字段。[统计设计](https://github.com/Wangnov/agents-mirror-kit/blob/8ea9a358824fd57abdf3324d040bbbb03096a19c/scripts/update-download-stats.py#L1-L38) [GraphQL 查询](https://github.com/Wangnov/agents-mirror-kit/blob/8ea9a358824fd57abdf3324d040bbbb03096a19c/scripts/update-download-stats.py#L82-L150)

## 4. 支持平台、使用与精确搭建步骤

### 4.1 最终用户

仓库当前镜像 macOS universal DMG（Intel + Apple Silicon）、Windows x64 MSIX、Windows arm64 MSIX；macOS 用户打开 DMG 后拖入 Applications，Windows 用户双击 MSIX 或运行 `Add-AppxPackage Claude-win-x64.msix`。用户应同时取得 `SHA256SUMS.txt` 并本地验证。[资产与安装方式](https://github.com/Wangnov/claude-app-mirror/blob/a21125ce29b1275c405eddb209e5f69bd2444fe6/README.md#L44-L50) [安装说明](https://github.com/Wangnov/claude-app-mirror/blob/a21125ce29b1275c405eddb209e5f69bd2444fe6/README.md#L70-L92)

仓库 README 仍写“官方没有 Linux 桌面客户端”，所以镜像管道没有 Linux endpoint 或 `.deb`/apt channel；但这一判断截至研究日已经过时：Anthropic 当前官方安装文档已提供 Linux beta，支持 Ubuntu 22.04+/Debian 12、x64/arm64，并推荐 apt repository。准确表述应是“**本镜像只支持 macOS/Windows，不覆盖当前官方 Linux beta**”。[仓库旧声明](https://github.com/Wangnov/claude-app-mirror/blob/a21125ce29b1275c405eddb209e5f69bd2444fe6/README.md#L56-L58) [Anthropic 当前 Linux 安装文档](https://support.claude.com/en/articles/10065433-install-claude-desktop)

### 4.2 本地复现 probe → download → metadata

主仓没有需要编译的应用或 package manager build；核心是 Bash 脚本。按脚本的显式 `require()` 和 workflow，最低需要 Bash、curl、jq、GitHub CLI、GNU `sha256sum`、`find`，并先让 `gh` 能访问目标仓库。以下命令只会准备本地发布材料，不会自动创建 GitHub Release，但会下载约 800 MB 安装包：[probe 依赖](https://github.com/Wangnov/claude-app-mirror/blob/a21125ce29b1275c405eddb209e5f69bd2444fe6/scripts/probe-release.sh#L19-L42) [download 依赖](https://github.com/Wangnov/claude-app-mirror/blob/a21125ce29b1275c405eddb209e5f69bd2444fe6/scripts/download-artifacts.sh#L23-L33) [metadata 依赖](https://github.com/Wangnov/claude-app-mirror/blob/a21125ce29b1275c405eddb209e5f69bd2444fe6/scripts/prepare-release-metadata.sh#L14-L28)

```bash
git clone https://github.com/Wangnov/claude-app-mirror.git
cd claude-app-mirror
gh auth login

MANIFEST_PATH=probe-manifest.json bash scripts/probe-release.sh
bash scripts/download-artifacts.sh dist probe-manifest.json
bash scripts/prepare-release-metadata.sh \
  probe-manifest.json dist https://claudeapp.agentsmirror.com

sha256sum --check SHA256SUMS.txt
```

这里必须给 probe 指定 `MANIFEST_PATH=probe-manifest.json`：metadata 脚本固定把最终文件写到 `release-manifest.json`，若把同一路径同时作为输入输出，shell redirection 会在 `jq` 读取前截断文件；官方 workflow 也使用独立的 `probe-manifest.json`。[probe 输出路径](https://github.com/Wangnov/claude-app-mirror/blob/a21125ce29b1275c405eddb209e5f69bd2444fe6/scripts/probe-release.sh#L19-L22) [metadata 输出](https://github.com/Wangnov/claude-app-mirror/blob/a21125ce29b1275c405eddb209e5f69bd2444fe6/scripts/prepare-release-metadata.sh#L70-L89) [workflow 的独立输入文件](https://github.com/Wangnov/claude-app-mirror/blob/a21125ce29b1275c405eddb209e5f69bd2444fe6/.github/workflows/mirror.yml#L69-L90)

### 4.3 部署自动化

GitHub 侧直接启用 `mirror.yml` 即有每 6 小时 fallback；完整生产形态还需要 R2 bucket、`R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`、`CLOUDFLARE_ACCOUNT_ID`，以及统计用 `CF_ANALYTICS_API_TOKEN`。release workflow 会安装 AWS CLI 并通过 S3-compatible endpoint 写 R2。[R2 secrets 与 endpoint](https://github.com/Wangnov/claude-app-mirror/blob/a21125ce29b1275c405eddb209e5f69bd2444fe6/.github/workflows/mirror.yml#L117-L132) [统计 secrets](https://github.com/Wangnov/claude-app-mirror/blob/a21125ce29b1275c405eddb209e5f69bd2444fe6/.github/workflows/stats.yml#L46-L55)

15 分钟主调度需要 checkout `agents-mirror-kit@v0.1.0`，复制实例 `wrangler.jsonc`，运行 `npx wrangler deploy`，再写入 `GITHUB_TOKEN` secret。配置 cron 为 UTC 的 `7,22,37,52 * * * *`。[dispatcher 部署步骤](https://github.com/Wangnov/claude-app-mirror/blob/a21125ce29b1275c405eddb209e5f69bd2444fe6/cloudflare/github-dispatcher/README.md#L10-L23)

代码静态验证与仓库 CI 等价的命令是：

```bash
bash -n scripts/*.sh
shellcheck scripts/*.sh
actionlint
```

CI 没有对真实 upstream probe、manifest diff、R2 promotion 或安装包可安装性做自动测试。[CI workflow](https://github.com/Wangnov/claude-app-mirror/blob/a21125ce29b1275c405eddb209e5f69bd2444fe6/.github/workflows/ci.yml#L20-L41)

## 5. 依赖与许可证

| 类别          | 依赖                                                                                                               | 锁定情况 / 备注                                                                                                                                                                                                                                                                                                                |
| ------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 仓库代码      | Bash/YAML/JSONC；无 `package.json` 或 lockfile                                                                     | 主仓只有脚本、workflows、文档与资产，不存在传统应用 build。[HEAD tree](https://github.com/Wangnov/claude-app-mirror/tree/a21125ce29b1275c405eddb209e5f69bd2444fe6)                                                                                                                                                             |
| 系统工具      | `curl`、`jq`、`gh`、`sha256sum`、`find`、`aws`、Python 3                                                           | 由 runner 系统或运行时安装；workflow 的 `pip install --user awscli` 没有版本约束。[AWS CLI 安装](https://github.com/Wangnov/claude-app-mirror/blob/a21125ce29b1275c405eddb209e5f69bd2444fe6/.github/workflows/mirror.yml#L117-L124)                                                                                            |
| GitHub Action | `actions/checkout@v6`                                                                                              | 按 major tag，不是 full commit SHA。[workflow](https://github.com/Wangnov/claude-app-mirror/blob/a21125ce29b1275c405eddb209e5f69bd2444fe6/.github/workflows/mirror.yml#L41-L67)                                                                                                                                                |
| 共享运行代码  | `Wangnov/agents-mirror-kit` `v0.1.0`                                                                               | tag 当前指向 `8ea9a358...`，但 workflow pin 的仍是可移动 tag，不是该 SHA。[checkout](https://github.com/Wangnov/claude-app-mirror/blob/a21125ce29b1275c405eddb209e5f69bd2444fe6/.github/workflows/mirror.yml#L62-L67) [kit commit](https://github.com/Wangnov/agents-mirror-kit/tree/8ea9a358824fd57abdf3324d040bbbb03096a19c) |
| 外部服务      | Anthropic update API / `downloads.claude.ai`、GitHub API / Releases / Actions、Cloudflare Workers / R2 / Analytics | 任一服务的可用性、API 或权限变化都可能中断管道；仓库不含离线源或自托管控制面。[上游来源](https://github.com/Wangnov/claude-app-mirror/blob/a21125ce29b1275c405eddb209e5f69bd2444fe6/README.md#L98-L114)                                                                                                                        |

主仓自动化代码采用 MIT License；共享 kit 也是 MIT。这个许可适用于各自的代码与文档，不能自动解释为 Anthropic 对镜像 Claude proprietary installer 的再分发授权；主仓没有独立的 third-party binary notice、上游许可文本或商标声明。因此代码复用清晰，安装包再分发的法律/品牌边界仍需使用方自行确认。[主仓 LICENSE](https://github.com/Wangnov/claude-app-mirror/blob/a21125ce29b1275c405eddb209e5f69bd2444fe6/LICENSE#L1-L20) [kit LICENSE](https://github.com/Wangnov/agents-mirror-kit/blob/8ea9a358824fd57abdf3324d040bbbb03096a19c/LICENSE#L1-L20) [项目非官方渠道声明](https://github.com/Wangnov/claude-app-mirror/blob/a21125ce29b1275c405eddb209e5f69bd2444fe6/README.md#L116-L122)

## 6. 维护、活跃度与发布信号

截至 2026-08-24 快照，仓库创建于 2026-05-30，有 78 stars、8 forks、1 个 open issue；提交历史只有 6 个 commits，贡献者 API 只有 Wangnov 一人，最后一次源码提交是 2026-07-07。代码变更频率低且 bus factor 为 1。[Repository API](https://api.github.com/repos/Wangnov/claude-app-mirror) [Commits API](https://api.github.com/repos/Wangnov/claude-app-mirror/commits?per_page=100) [Contributors API](https://api.github.com/repos/Wangnov/claude-app-mirror/contributors?per_page=100)

发布运营则明显更活跃：2026-06-03 到 2026-08-21 共 44 个 releases，最新版为 `claude-app-v1.34493.1`；mirror workflow 累计 8,536 runs，研究时最近多轮 15 分钟探测均成功并走 no-change 路径。这里应区分“源码维护较少”和“自动分发管道持续运行”。[Releases API](https://api.github.com/repos/Wangnov/claude-app-mirror/releases?per_page=100) [最新版 release](https://github.com/Wangnov/claude-app-mirror/releases/tag/claude-app-v1.34493.1) [Actions Runs API](https://api.github.com/repos/Wangnov/claude-app-mirror/actions/workflows/mirror.yml/runs?per_page=10) [成功 run 示例](https://github.com/Wangnov/claude-app-mirror/actions/runs/32683676717)

社区响应有限且不稳定：重复的 Cowork 问题在约两小时半内得到一次维护者说明并关闭，2026-07-18 提交的 Claude Code binary 问题截至研究日仍未回复。更重要的是 README 对 Linux 的说明已经落后于 Anthropic 当前发布状态，显示平台矩阵缺少自动 drift detection。[Issue #2](https://github.com/Wangnov/claude-app-mirror/issues/2) [Issue #4](https://github.com/Wangnov/claude-app-mirror/issues/4) [Anthropic 当前 Linux 文档](https://support.claude.com/en/articles/10065433-install-claude-desktop)

## 7. 安全、隐私与可靠性评估

### 7.1 正面控制

- workflow 默认 `contents: read`，只有 release job 提升为 `contents: write`；同一镜像用 concurrency 单飞，减少并发发布冲突。[权限与 concurrency](https://github.com/Wangnov/claude-app-mirror/blob/a21125ce29b1275c405eddb209e5f69bd2444fe6/.github/workflows/mirror.yml#L18-L27) [release 权限](https://github.com/Wangnov/claude-app-mirror/blob/a21125ce29b1275c405eddb209e5f69bd2444fe6/.github/workflows/mirror.yml#L52-L59)
- upstream URL 来自 Anthropic HTTPS redirect，下载有重试与 byte-size check，release 同时公布来源 URL、HTTP 指纹和 SHA-256，便于事后复核。[probe](https://github.com/Wangnov/claude-app-mirror/blob/a21125ce29b1275c405eddb209e5f69bd2444fe6/scripts/probe-release.sh#L75-L142) [SHA 生成](https://github.com/Wangnov/claude-app-mirror/blob/a21125ce29b1275c405eddb209e5f69bd2444fe6/scripts/prepare-release-metadata.sh#L51-L89)
- R2 使用 staging 并至少回读验证 manifest；公开 alias 更新后再次从公网回读 manifest。[R2 verification](https://github.com/Wangnov/claude-app-mirror/blob/a21125ce29b1275c405eddb209e5f69bd2444fe6/.github/workflows/mirror.yml#L143-L179)
- 项目没有改包或注入客户端代码，仓库证据也没有显示增加客户端 telemetry；自身统计读取的是 R2 对象按日聚合请求数。[non-goals](https://github.com/Wangnov/claude-app-mirror/blob/a21125ce29b1275c405eddb209e5f69bd2444fe6/README.md#L116-L122) [统计字段](https://github.com/Wangnov/agents-mirror-kit/blob/8ea9a358824fd57abdf3324d040bbbb03096a19c/scripts/update-download-stats.py#L82-L150)

### 7.2 主要风险

| 等级 | 风险                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 证据与影响 |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 高   | **R2 失败不会自动自愈。** workflow 先执行 `gh release create`，之后才带 R2 secrets 同步；如果 R2 阶段失败，GitHub Release 已公开。下一轮 probe 会从“最新 release”下载相同 manifest，判定 `should_release=false`，所以 release/R2 job 不再执行。除非人工 `force_release` 或上游再次变更，R2 缺失/半更新状态会持续。[先发布后同步](https://github.com/Wangnov/claude-app-mirror/blob/a21125ce29b1275c405eddb209e5f69bd2444fe6/.github/workflows/mirror.yml#L92-L126) [manifest match 即跳过](https://github.com/Wangnov/claude-app-mirror/blob/a21125ce29b1275c405eddb209e5f69bd2444fe6/scripts/probe-release.sh#L186-L210) |
| 高   | **共享 release 代码不是 immutable pin。** release job checkout `agents-mirror-kit` 的可移动 tag `v0.1.0`，随后在带 `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` 的步骤中执行其 `sync-r2.sh`；`actions/checkout@v6` 同样是 tag pin。tag 或上游 action 被接管时，攻击面直接触及 release 内容和 R2 凭证。[kit checkout](https://github.com/Wangnov/claude-app-mirror/blob/a21125ce29b1275c405eddb209e5f69bd2444fe6/.github/workflows/mirror.yml#L60-L67) [在 secrets 环境执行 kit](https://github.com/Wangnov/claude-app-mirror/blob/a21125ce29b1275c405eddb209e5f69bd2444fe6/.github/workflows/mirror.yml#L126-L169)       |
| 高   | **checksum 不证明上游真实性。** pipeline 不调用 `codesign`、`spctl`、`signtool` 或 Authenticode/MSIX certificate verifier；只验证 length 并对收到的 bytes 自算 SHA-256。安装包和 `SHA256SUMS.txt` 又由同一 workflow/account 发布，能发现下载损坏，却不能抵抗该发布账户或 runner 被攻破。[size-only 下载验证](https://github.com/Wangnov/claude-app-mirror/blob/a21125ce29b1275c405eddb209e5f69bd2444fe6/scripts/download-artifacts.sh#L43-L78) [同管道生成 SHA](https://github.com/Wangnov/claude-app-mirror/blob/a21125ce29b1275c405eddb209e5f69bd2444fe6/scripts/prepare-release-metadata.sh#L51-L89)                   |
| 中   | **`latest/*` 不是原子 promotion。** 五个 aliases 依次覆盖，只在 staging 与最终公网端比较 manifest；中途失败可能留下跨版本混合对象，而且没有逐个回读 installer/checksum。concurrency 防止两轮相互覆盖，但不能提供 multi-object transaction。[逐对象写入](https://github.com/Wangnov/claude-app-mirror/blob/a21125ce29b1275c405eddb209e5f69bd2444fe6/.github/workflows/mirror.yml#L149-L179)                                                                                                                                                                                                                                |
| 中   | **fingerprint 有可变对象假设。** 去重只比较 URL + length，依赖“URL 内含 content hash”这一上游约定；若同一 URL 被替换为同长度内容，probe 不会重新下载或发布。ETag/Last-Modified 虽记录进 manifest，却不参与 `manifest_key`。[fingerprint 实现](https://github.com/Wangnov/claude-app-mirror/blob/a21125ce29b1275c405eddb209e5f69bd2444fe6/scripts/probe-release.sh#L135-L142)                                                                                                                                                                                                                                              |
| 中   | **单维护者与凭证集中。** GitHub release、R2、Cloudflare dispatcher 都依赖同一维护域和 secrets；仓库没有 `SECURITY.md`、artifact attestation、SBOM 或独立签名公钥，恢复与披露流程没有公开契约。[HEAD tree](https://github.com/Wangnov/claude-app-mirror/tree/a21125ce29b1275c405eddb209e5f69bd2444fe6)                                                                                                                                                                                                                                                                                                                     |
| 低   | **下载隐私仍转移给镜像运营方。** 没有客户端遥测不等于匿名下载；GitHub/Cloudflare 作为 HTTP 分发方仍可按其平台能力处理请求元数据。项目公开统计只落聚合计数，但仓库没有用户侧隐私说明。[stats workflow](https://github.com/Wangnov/claude-app-mirror/blob/a21125ce29b1275c405eddb209e5f69bd2444fe6/.github/workflows/stats.yml#L1-L55)                                                                                                                                                                                                                                                                                      |

建议使用者至少同时验证 SHA-256 与操作系统签名/证书，并把 manifest 中的 `downloads.claude.ai` URL 作为 provenance 线索；SHA-256 文件不应被描述成“官方签名”。

## 8. 主要限制

1. **只解决分发，不解决应用功能。** 登录、订阅、Claude Code binary、Cowork、第三方模型接入和客户端 bug 都不在项目控制面内；维护者也在 issue 中明确如此回应。[Issue #2 回复](https://github.com/Wangnov/claude-app-mirror/issues/2#issuecomment-4931780939)
2. **平台矩阵已落后。** 只有 macOS DMG、Windows x64/arm64 MSIX；不含 Anthropic 当前 Linux beta、macOS enterprise PKG、移动端或 Squirrel 增量包。[当前 non-goals](https://github.com/Wangnov/claude-app-mirror/blob/a21125ce29b1275c405eddb209e5f69bd2444fe6/README.md#L116-L122) [Anthropic 当前平台](https://support.claude.com/en/articles/10065433-install-claude-desktop)
3. **R2 只保留 latest。** 历史版本只能依赖 GitHub Releases；GitHub 故障或 release 被删除时，R2 不能提供旧版回滚。[分发约定](https://github.com/Wangnov/claude-app-mirror/blob/a21125ce29b1275c405eddb209e5f69bd2444fe6/README.md#L78-L85)
4. **没有独立真实性验证。** manifest 是很好的可审计元数据，但不是签名 attestation；流水线也不检查安装包平台签名。[download 与 metadata scripts](https://github.com/Wangnov/claude-app-mirror/blob/a21125ce29b1275c405eddb209e5f69bd2444fe6/scripts/download-artifacts.sh#L43-L78)
5. **验证面窄。** CI 只有 shell/YAML 静态检查；没有脚本单测、fixture-based manifest diff、失败恢复测试、R2 reconciliation、真实安装 smoke test 或平台启动验证。[CI](https://github.com/Wangnov/claude-app-mirror/blob/a21125ce29b1275c405eddb209e5f69bd2444fe6/.github/workflows/ci.yml#L13-L41)
6. **高频调度产生大量 no-op runs。** 两个多月已有 8,536 次 workflow runs，绝大部分只是探测；延迟低，但 Actions 历史噪声、API 配额和外部依赖调用也随之增长。[Actions Runs API](https://api.github.com/repos/Wangnov/claude-app-mirror/actions/workflows/mirror.yml/runs?per_page=10)

## 9. Cognia 可复用的具体方案

### P0：字节不变的 signed updater 次级镜像

Cognia 不需要第二套构建或签名系统。现有 release matrix 已由 `tauri-action` 生成 installers、`*.sig`、`latest.json`，内置 updater public key 验签，并在完整矩阵成功后发布 draft。建议在该**已发布、已签名** release 后增加 mirror job：复制原始 bytes、对应 `.sig` 与 `latest.json` 到一个备用对象存储；上传后逐对象比较 GitHub asset digest/size，并用 Cognia 的 updater public key 做一次离线验签；最终只切换一个版本化 pointer。禁止重新打包、重命名内容或再签名。[Cognia 现有信任链](https://github.com/MaxQian888/cognia-next/blob/2f28a3be514780765b133e13cd83f26003fd288d/src-tauri/UPDATER.md#L41-L59) [发布产物与原子发布](https://github.com/MaxQian888/cognia-next/blob/2f28a3be514780765b133e13cd83f26003fd288d/src-tauri/UPDATER.md#L72-L97)

故障转移应仍以 embedded public key 为信任根，而不是以镜像域名或 checksum 为信任根；镜像只改善 availability。需要先验证 Tauri updater 对多个 endpoint 的具体 fallback 语义，再决定是在 `endpoints` 中增加备用 manifest，还是由受控 gateway 做健康选择。

### P0：先镜像成功，再暴露 / 可自动修复的发布状态机

不要复制“GitHub Release 已发布 → R2 失败 → 下一轮去重跳过”的顺序。更稳妥的协议是：

```text
build/sign once → draft release → mirror staging → verify every object/signature
→ promote version pointer → publish GitHub release → verify both channels
```

此外每轮 probe 必须分别计算 `upstreamChanged` 与 `mirrorHealthy`；即使版本没变，只要 mirror 缺对象、digest 不符或 pointer 错位，也要进入 reconciliation job。这样次级分发才有自愈能力。这个建议直接修复原项目由 publish 顺序和 manifest 去重组合出的恢复缺口。[原项目 publish 顺序](https://github.com/Wangnov/claude-app-mirror/blob/a21125ce29b1275c405eddb209e5f69bd2444fe6/.github/workflows/mirror.yml#L92-L179) [原项目 skip 逻辑](https://github.com/Wangnov/claude-app-mirror/blob/a21125ce29b1275c405eddb209e5f69bd2444fe6/scripts/probe-release.sh#L186-L210)

### P1：公开、签名关联的 release provenance manifest

在 Tauri `latest.json` 之外生成 Cognia 自己的 `release-manifest.v1.json`，记录 `gitCommit`、workflow run、builder target、asset GitHub ID、size、SHA-256、Tauri signature asset、macOS notarization/Windows signing 摘要、SBOM/attestation URL，以及镜像 locations。manifest 本身应由 release signing key 签名或被 attestation 覆盖；checksum 只做损坏检测，不能替代 signature。`claude-app-mirror` 的 schema v1→v2 和规范化 `assetName` 是可借鉴的起点。[其 manifest 结构](https://github.com/Wangnov/claude-app-mirror/blob/a21125ce29b1275c405eddb209e5f69bd2444fe6/scripts/probe-release.sh#L108-L178) [SHA/assetName 增补](https://github.com/Wangnov/claude-app-mirror/blob/a21125ce29b1275c405eddb209e5f69bd2444fe6/scripts/prepare-release-metadata.sh#L70-L89)

### P1：把 probe/download/publish 分层用于大资产供应链

除桌面 installer 外，Cognia 的 external agent hosts、sidecars、模型或 OCR 大资产、plugin/skill marketplace cache 也适合“轻量 metadata probe → fingerprint diff → 仅变更时下载 → provenance → staging promotion”的结构。复用的应是一个小型 manifest contract 与 reconciliation engine，不是复制三段 Bash 到每个模块。原项目也明确把 app-specific probe 留在各镜像仓、把 R2/dispatcher/statistics 下沉到共享 kit，这个边界是合理的。[kit 的通用/专用边界](https://github.com/Wangnov/agents-mirror-kit/blob/8ea9a358824fd57abdf3324d040bbbb03096a19c/README.md#L7-L29)

### P1：平台矩阵 drift gate

将 release target catalog、文档支持矩阵、updater manifest platforms 和镜像 aliases 从同一机器可读清单生成，并在 CI 中比较。若上游新增平台/架构/格式，probe 应发出需要人工决策的 drift alert，而不是把“未配置 endpoint”误写成“官方不存在”。当前仓库错过 Linux beta 正是缺少此门禁的现实例子。[仓库旧 Linux 声明](https://github.com/Wangnov/claude-app-mirror/blob/a21125ce29b1275c405eddb209e5f69bd2444fe6/README.md#L56-L58) [Anthropic 当前 Linux 文档](https://support.claude.com/en/articles/10065433-install-claude-desktop)

### P1：供应链 pin 与 secret 隔离

所有 release job 的 third-party actions 和共享代码都 pin full commit SHA；带写权限或 R2 credentials 的 job 不执行运行时从可移动 tag/main 获取的脚本。共享 mirror module 若必须复用，应 vendored 或以 SHA checkout，并把 upload 凭证限制到特定 bucket/prefix。原项目 tag pin 比 main 好，但仍达不到不可变依赖要求。[原 kit 治理意图](https://github.com/Wangnov/agents-mirror-kit/blob/8ea9a358824fd57abdf3324d040bbbb03096a19c/README.md#L20-L47) [实际 tag checkout](https://github.com/Wangnov/claude-app-mirror/blob/a21125ce29b1275c405eddb209e5f69bd2444fe6/.github/workflows/mirror.yml#L60-L67)

### 不建议复用

- 不把 GitHub/R2 同通道生成的 `SHA256SUMS.txt` 当成签名或 trusted provenance；Cognia 已有更强的 Tauri updater key 信任链。[Cognia updater public key](https://github.com/MaxQian888/cognia-next/blob/2f28a3be514780765b133e13cd83f26003fd288d/src-tauri/UPDATER.md#L41-L46)
- 不把五个 mutable `latest/*` 对象依次覆盖；用 content-addressed/versioned objects 加一个原子 pointer，客户端取得 pointer 后始终落到同一版本集合。
- 不为 15 分钟新鲜度机械制造每次 GitHub Action run；可让低成本边缘 probe 只在 fingerprint 变化或 mirror health 失败时 dispatch 重 job。
- 不复制第二套 Claude/Cognia installer build 或签名逻辑；镜像层必须保持 Tauri 官方 pipeline 产物 bytes 不变。[Cognia 单一构建/签名 pipeline](https://github.com/MaxQian888/cognia-next/blob/2f28a3be514780765b133e13cd83f26003fd288d/src-tauri/UPDATER.md#L72-L97)

## 10. 最终判断

把 `claude-app-mirror` 定位为“**运营活跃、实现简洁、基础完整性可审计，但不是独立可信根的下载加速镜像**”最准确。其 probe/manifest/staging/双调度思想值得吸收；其二进制真实性验证、依赖 pin、R2 自愈和 multi-object promotion 则需要明显加强。

对 Cognia 的推荐决策是：**采用其分发模式，不采用其信任模式。** 先保留当前 Tauri draft → signed artifacts → atomic publish 的单一权威 pipeline，再增加可自愈、字节不变、签名仍可验证的次级 mirror。若只做一项近期改进，应优先产出 `release-manifest.v1` 与 mirror reconciliation protocol；它能同时服务下载故障转移、release 审计、SBOM/attestation 链接和平台 drift 检测。

## 11. 一手来源索引

### `claude-app-mirror`

- [README：定位、资产、轮询、来源与 non-goals](https://github.com/Wangnov/claude-app-mirror/blob/a21125ce29b1275c405eddb209e5f69bd2444fe6/README.md)
- [`probe-release.sh`](https://github.com/Wangnov/claude-app-mirror/blob/a21125ce29b1275c405eddb209e5f69bd2444fe6/scripts/probe-release.sh)
- [`download-artifacts.sh`](https://github.com/Wangnov/claude-app-mirror/blob/a21125ce29b1275c405eddb209e5f69bd2444fe6/scripts/download-artifacts.sh)
- [`prepare-release-metadata.sh`](https://github.com/Wangnov/claude-app-mirror/blob/a21125ce29b1275c405eddb209e5f69bd2444fe6/scripts/prepare-release-metadata.sh)
- [`mirror.yml`](https://github.com/Wangnov/claude-app-mirror/blob/a21125ce29b1275c405eddb209e5f69bd2444fe6/.github/workflows/mirror.yml)
- [`ci.yml`](https://github.com/Wangnov/claude-app-mirror/blob/a21125ce29b1275c405eddb209e5f69bd2444fe6/.github/workflows/ci.yml)
- [`stats.yml`](https://github.com/Wangnov/claude-app-mirror/blob/a21125ce29b1275c405eddb209e5f69bd2444fe6/.github/workflows/stats.yml)
- [Cloudflare dispatcher 配置与部署说明](https://github.com/Wangnov/claude-app-mirror/tree/a21125ce29b1275c405eddb209e5f69bd2444fe6/cloudflare/github-dispatcher)
- [最新版 release `1.34493.1`](https://github.com/Wangnov/claude-app-mirror/releases/tag/claude-app-v1.34493.1)
- [Repository API](https://api.github.com/repos/Wangnov/claude-app-mirror) · [Releases API](https://api.github.com/repos/Wangnov/claude-app-mirror/releases?per_page=100) · [Actions Runs API](https://api.github.com/repos/Wangnov/claude-app-mirror/actions/workflows/mirror.yml/runs?per_page=10)

### 共享基础设施与官方平台事实

- [`agents-mirror-kit` README](https://github.com/Wangnov/agents-mirror-kit/blob/8ea9a358824fd57abdf3324d040bbbb03096a19c/README.md)
- [R2 sync 实现](https://github.com/Wangnov/agents-mirror-kit/blob/8ea9a358824fd57abdf3324d040bbbb03096a19c/scripts/sync-r2.sh)
- [Cloudflare dispatcher 实现](https://github.com/Wangnov/agents-mirror-kit/blob/8ea9a358824fd57abdf3324d040bbbb03096a19c/workers/github-dispatcher/src/index.js)
- [累计下载统计实现](https://github.com/Wangnov/agents-mirror-kit/blob/8ea9a358824fd57abdf3324d040bbbb03096a19c/scripts/update-download-stats.py)
- [Anthropic：当前 Claude Desktop 安装与 Linux beta](https://support.claude.com/en/articles/10065433-install-claude-desktop)

### Cognia 对照

- [Tauri updater 设计与发布说明](https://github.com/MaxQian888/cognia-next/blob/2f28a3be514780765b133e13cd83f26003fd288d/src-tauri/UPDATER.md)
- [Tauri updater endpoint 与 minisign public key](https://github.com/MaxQian888/cognia-next/blob/2f28a3be514780765b133e13cd83f26003fd288d/src-tauri/tauri.conf.json#L87-L93)
- [Tauri release workflow](https://github.com/MaxQian888/cognia-next/blob/2f28a3be514780765b133e13cd83f26003fd288d/.github/workflows/build-tauri.yml)
