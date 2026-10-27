# Repository directory guide / 仓库目录指南

The root is both the main Next.js app and the JavaScript/Rust workspace root.
Its directories serve several products and tools. Use the existing owners below
when adding files.

仓库根目录同时承载 Next.js 主应用和 JavaScript/Rust workspace。新增文件时，
按下表放入已有目录。

| Location                                                              | Responsibility / 职责                                                                         |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `app/`, `components/`, `hooks/`, `lib/`, `stores/`, `types/`, `i18n/` | Main app routes, UI, business logic, state, types, and localization / 主应用                  |
| `public/`, `assets/`                                                  | App static resources and repository presentation assets / 应用静态资源与仓库展示素材          |
| `packages/`, `crates/`, `protocol/`                                   | Shared JavaScript packages, Rust crates, and contracts / 共享包与协议                         |
| `src-tauri/`, `sidecar/`                                              | Desktop shell and agent/extension hosts / 桌面外壳与智能体宿主                                |
| `web/`, `mobile/`, `cli/`, `browser-extension/`                       | Product website and client workspaces / 产品网站与客户端                                      |
| `plugins/`, `plugin-sdk/`, `skills/`, `generated/`                    | Plugin assets/tooling, bundled skills, and generated skill loaders / 插件、技能及其生成加载器 |
| `services/`, `deploy/`                                                | Services and deployment assets / 服务与部署资源                                               |
| `config/`, `scripts/`, `tests/`, `test-fixtures/`, `__mocks__/`       | Shared configuration data, automation, E2E suites, fixtures, and mocks / 配置、脚本与测试     |
| `patches/`                                                            | Dependency patches referenced by pnpm / pnpm 依赖补丁                                         |
| `output/`                                                             | Existing tracked document exports; inspect before removing / 已跟踪的文档导出，清理前先检查   |

Managed DeepSeek Harness launcher sources and profiles live alongside their
adapter in `packages/agent-dsh/runtime/`. Their upstream dependencies are installed
into an isolated runtime home, outside the pnpm workspace.

DeepSeek Harness 的托管启动器与配置归属 `packages/agent-dsh/runtime/`，与适配器放在一起；
上游依赖仍安装到 pnpm workspace 之外的隔离运行时目录。

## Development guides / 开发指南

- [Development workflow / 开发流程](development/WORKFLOW.md)
- [CI/CD guide / CI/CD 指南](development/CI_CD.md)
- [Testing guide / 测试指南](development/TESTING.md)
- [Contribution guide / 贡献指南](../CONTRIBUTING.md)

`docs/content/docs/` owns the published bilingual Fumadocs content and ADRs.
`docs/plans/`, `docs/research/`, `docs/reports/`, and `docs/runbooks/` own plans,
research, verification reports, and operator procedures. Keep contributor
guides in `docs/development/` instead of adding more root Markdown files.

`docs/content/docs/` 存放发布到站点的双语文档和 ADR；方案、研究、验证报告与运维
手册分别放入 `docs/plans/`、`docs/research/`、`docs/reports/`、`docs/runbooks/`。
开发协作指南统一放入 `docs/development/`。

## Docs workspace dependencies / 文档工作区依赖

The docs site is a member of the root pnpm workspace. Install from the repository
root with `pnpm install --frozen-lockfile`, then run `pnpm --filter docs typecheck`
or `pnpm docs:build`. The root `pnpm-lock.yaml` owns its dependency versions;
there is no independently maintained lockfile under `docs/`. CI also discovers
the root workspace when it installs from the docs directory.

文档站属于根 pnpm workspace。请在仓库根目录安装依赖，再运行文档类型检查或构建；
依赖版本统一由根 `pnpm-lock.yaml` 管理，`docs/` 不再维护独立锁文件。

## Container builds / 容器构建

The five Dockerfiles in `deploy/docker/` use the repository root as their build
context. Run commands from the root, for example:

`deploy/docker/` 下的五个 Dockerfile 仍以仓库根目录为构建上下文。例如在根目录执行：

```sh
docker build -f deploy/docker/Dockerfile.cognia-server --target runtime-slim -t cognia-server .
```

Compose configurations stay in `deploy/compose/`. Service-local Dockerfiles and
the runner/bundle images stay beside their own deployment assets.

Compose 配置保留在 `deploy/compose/`；服务自有 Dockerfile、runner 和 bundle 镜像
继续由各自目录维护。

## Root files and local output / 根目录文件与本地产物

Keep workspace manifests and lockfiles, framework entry points, and discoverable
tool configuration at the root. `README*`, `LICENSE`, `CHANGELOG.md`,
`CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, and `SECURITY.md` remain contributor
entry points. `AGENTS.md`, `CLAUDE.md`, and `CONTEXT.md` remain agent/domain entry
points. Hidden tool directories contain a mix of tracked settings and local
state; inspect their ownership before changing them.

workspace 清单和锁文件、框架入口、工具自动发现的配置保留在根目录。仓库说明、许可、
贡献与安全文件保留为协作入口；`AGENTS.md`、`CLAUDE.md`、`CONTEXT.md` 保留为智能体
和领域入口。隐藏工具目录可能同时包含受版本管理的配置与本地状态，不能一概清理。

| Local output                          | Purpose / 用途                                                                            |
| ------------------------------------- | ----------------------------------------------------------------------------------------- |
| `.cache/typescript/`                  | TypeScript API and production-build incremental state / TypeScript API 与生产构建增量缓存 |
| `.cache/typecheck/`                   | Native CLI typecheck state / 原生 CLI 类型检查缓存                                        |
| `.cache/`                             | Other configurable caches and ad-hoc verification output / 其他缓存与临时验证产物         |
| `node_modules/`, `.pnpm-store/`       | Installed dependencies and local package store / 依赖与本地包存储                         |
| `.next*/`, `out/`, `dist/`, `target/` | Tool-managed app and Rust build output / 应用与 Rust 构建产物                             |
| `playwright-report/`, `test-results/` | Playwright reports, traces, and test output / 浏览器测试报告与记录                        |

Prefer `.cache/<tool>/` for new scratch output when the tool supports choosing
its location. Existing build/report directories keep their configured paths.
Do not move active outputs or delete local state as part of a source-file move.

新临时产物优先写入 `.cache/<tool>/`。已有构建和报告目录继续遵循各自工具配置，
整理源码时不要顺手迁移活动产物或删除本地状态。
