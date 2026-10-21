# Website repository extraction

The marketing website moved from `web/` to [cognia-labs/cognia-website](https://github.com/cognia-labs/cognia-website) on 2026-10-21. Its Git history was retained with `git subtree split --prefix=web` from product commit `0d138eefc6f1d3535ffd57db71a898e540e3686f`; the current website package and Next configuration edits were also transferred.

Use that repository for website development, testing, builds, media and deployment. It owns its lockfile, TypeScript/Jest/ESLint configuration, GitHub CI and static hosting instructions. Product runtime, desktop/mobile apps, services, SDKs and Fumadocs documentation remain here. `deploy/compose/Dockerfile.web` still builds the product browser UI and remains in this repository.

The obsolete website workspace, root scripts, test roots, Docker linking inputs and website CI/deployment/refresh jobs were removed. Historical ADR-0092 remains as the original design record; operational commands now live in the website repository.

Product facts are synchronized explicitly using `pnpm product:export --source-root /path/to/cognia-next` in the website repository. Its normal install/dev/test/build/deploy do not read this checkout. The committed snapshot records source revision, capture time, working-tree state and source hashes.

Cleanup was prepared in an isolated worktree. Shared-checkout edits were preserved. After merging, compare any newer local `web/` edits with the standalone repository before removing an old directory; do not discard them.

## 中文

官网已独立到上述仓库，日常开发、测试、构建和部署均不依赖主仓库。本仓库继续维护产品本体、服务、SDK 和文档，产品浏览器 UI 的 Dockerfile.web 仍保留。产品事实通过显式导出同步为可追溯的版本快照。历史 ADR 保留，当前官网操作以新仓库说明为准。本次清理在独立 worktree 中进行，未改动共享工作区；合并后删除旧目录前，请先核对后续新增修改。
