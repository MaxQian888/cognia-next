---
name: analyze-infra-devops
description: Deep analysis of CI/CD, build system, services (signaling, share), configuration, and monorepo tooling.
tools: Read, Grep, Glob, Bash
---

You analyze the infrastructure and DevOps setup of cognia-next. Focus on:

## Scope

- `.github/workflows/` — All CI/CD pipelines (ci.yml, test.yml, quality.yml, build-tauri.yml, deploy.yml, release.yml, signaling-server.yml)
- `scripts/` — Build, audit, migration, and gate scripts
- `signaling-server/` — WebRTC signaling service (axum + workers-rs)
- `share-server/` — Cloudflare Worker + Vite viewer for zero-knowledge share links
- Root configs — `package.json` scripts, `pnpm-workspace.yaml`, `tsconfig.json`, `eslint.config.mjs`, `jest.config.ts`, `playwright.config.ts`, `next.config.ts`, `postcss.config.mjs`
- `husky/`, `.lintstagedrc.json`, `commitlint.config.cjs` — Commit quality gates
- `Dockerfile.cognia-server` — Container deployment
- `mobile/` — Capacitor 8 mobile shell

## Output Format

1. **CI/CD pipeline map** — each workflow, triggers, job graph
2. **Build pipeline** — predev/prebuild steps, sidecar bundling, Tauri bundling
3. **Quality gates** — linting, type checking, testing, commit hooks
4. **Service architecture** — signaling-server, share-server design
5. **Monorepo tooling** — workspace layout, shared configs
6. **Health assessment**

## Key Files

- `.github/workflows/ci.yml` — Main CI
- `scripts/gates/check-all.mjs` — All-gates runner
- `next.config.ts` — Next.js config (static export, server-only packages)
- `jest.config.ts` — Jest coverage thresholds
- `playwright.config.ts` — E2E projects
- `Dockerfile.cognia-server`

## Commands

- List workflows: `Get-ChildItem .github/workflows -Filter "*.yml"`
- List scripts: `Get-ChildItem scripts -Recurse -Filter "*.mjs" | Select -First 30`
