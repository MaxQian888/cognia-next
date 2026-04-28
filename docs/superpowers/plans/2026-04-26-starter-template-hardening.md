# Starter Template Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring `react-quick-starter` to open-source-template "standard practices" by adding DX foundation (Prettier/Husky/commitlint), reconciling doc inconsistencies, hardening Tauri security & metadata, and demonstrating one typed Tauri IPC bridge — without introducing React-side scaffolding (store/provider/i18n).

**Architecture:** 4 sequential segments, each commits independently. Segment 1 (DX) → Segment 2 (governance/docs) → Segment 3 (Tauri security/metadata) → Segment 4 (IPC bridge demo). Tests-first for the 3 modules with logic (`lib/env.ts`, `lib/tauri.ts`, Rust `commands.rs`); declarative config changes verified by running the toolchain.

**Tech Stack:** pnpm 10 / Node 20 / Next.js 16 / React 19 / Jest 30 / Tauri 2.9 / Rust 1.77+ / Prettier 3 / Husky 9 / commitlint 19

**Spec:** `docs/superpowers/specs/2026-04-26-starter-template-hardening-design.md`

---

## File Structure

### Files to CREATE

| Path                                  | Responsibility                                                   |
| ------------------------------------- | ---------------------------------------------------------------- |
| `.prettierrc.json`                    | Prettier formatting rules                                        |
| `.prettierignore`                     | Paths Prettier skips                                             |
| `.husky/pre-commit`                   | Run lint-staged on staged files                                  |
| `.husky/commit-msg`                   | Validate commit message via commitlint                           |
| `commitlint.config.cjs`               | Conventional Commits rules                                       |
| `.lintstagedrc.json`                  | Per-extension formatter/linter mapping                           |
| `.nvmrc`                              | Pinned Node major version                                        |
| `.env.example`                        | Documented env-var template                                      |
| `env.d.ts`                            | TypeScript augmentation for `process.env`                        |
| `lib/env.ts`                          | Runtime validation + typed accessor for public env               |
| `lib/env.test.ts`                     | Tests for `getPublicEnv()`                                       |
| `SECURITY.md`                         | Vulnerability disclosure policy                                  |
| `CODE_OF_CONDUCT.md`                  | Contributor Covenant 2.1                                         |
| `.github/CODEOWNERS`                  | Default reviewers                                                |
| `src-tauri/UPDATER.md`                | Updater key-gen + endpoint setup guide                           |
| `src-tauri/capabilities/desktop.json` | Empty desktop-permissions skeleton                               |
| `src-tauri/src/commands.rs`           | Tauri IPC commands (with Rust unit tests)                        |
| `lib/tauri.ts`                        | Single point that calls `invoke()`; typed wrappers + `isTauri()` |
| `lib/tauri.test.ts`                   | Tests for `lib/tauri.ts`                                         |
| `components/tauri-demo.tsx`           | Client component demoing IPC; renders nothing in web mode        |
| `__mocks__/tauri-api.js`              | Jest mock for `@tauri-apps/api/core`                             |

### Files to MODIFY

| Path                            | Change                                                           |
| ------------------------------- | ---------------------------------------------------------------- |
| `package.json`                  | scripts, devDeps, deps, engines, packageManager                  |
| `eslint.config.mjs`             | Append `eslint-config-prettier` to disable formatting rules      |
| `.github/workflows/quality.yml` | Add `format:check` + `typecheck` steps                           |
| `jest.config.ts`                | `moduleNameMapper` for `@tauri-apps/api/core`                    |
| `README.md`                     | 4 doc fixes + IPC section                                        |
| `README_zh.md`                  | Sync with README.md                                              |
| `CLAUDE.md`                     | Drop `__tests__/`, update commands, add IPC pattern              |
| `AGENTS.md`                     | Sync command table with CLAUDE.md                                |
| `CONTRIBUTING.md`               | Coding Standards (mention enforcement); fix CoC link             |
| `TESTING.md`                    | Note collocated `*.test.tsx` convention                          |
| `src-tauri/Cargo.toml`          | 5 metadata fields + `thiserror` + `tauri-plugin-updater`         |
| `src-tauri/tauri.conf.json`     | Set CSP + add `plugins.updater` placeholder                      |
| `src-tauri/src/lib.rs`          | `mod commands;` + `.invoke_handler()` + cfg-gated updater plugin |
| `app/page.tsx`                  | Append `<TauriDemo />`                                           |
| `app/page.test.tsx`             | Verify still passes (likely no change needed)                    |

---

# Segment 1 — Developer Experience 底座

## Task 1: 取本地 pnpm 版本号

**Why:** `package.json` 的 `packageManager` 字段必须是精确版本，不接受 semver range。

- [ ] **Step 1: Get pnpm version**

Run: `pnpm --version`
Expected: a version like `10.10.0` (something in the 10.x series)
Record this value — Task 4 will paste it into `package.json`.

---

## Task 2: 引入 Prettier

**Files:**

- Create: `.prettierrc.json`
- Create: `.prettierignore`
- Modify: `eslint.config.mjs`
- Modify: `package.json` (devDependencies + scripts)

- [ ] **Step 1: Create `.prettierrc.json`**

```json
{
  "semi": false,
  "singleQuote": false,
  "printWidth": 100,
  "tabWidth": 2,
  "trailingComma": "es5",
  "arrowParens": "always",
  "endOfLine": "lf"
}
```

- [ ] **Step 2: Create `.prettierignore`**

```
node_modules
.next
out
build
coverage
dist
src-tauri/target
src-tauri/gen
pnpm-lock.yaml
*.min.js
*.min.css
```

- [ ] **Step 3: Install Prettier deps**

Run: `pnpm add -D prettier@^3 eslint-config-prettier@^10`
Expected: pnpm-lock.yaml updates, packages added to devDependencies.

- [ ] **Step 4: Append `eslint-config-prettier` to `eslint.config.mjs`**

Replace the file's contents with:

```js
import { defineConfig, globalIgnores } from "eslint/config"
import nextVitals from "eslint-config-next/core-web-vitals"
import nextTs from "eslint-config-next/typescript"
import prettier from "eslint-config-prettier"

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  prettier,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "coverage/**",
    "src-tauri/target/**",
    "next-env.d.ts",
  ]),
])

export default eslintConfig
```

- [ ] **Step 5: Add Prettier + lint scripts to `package.json`**

In the `"scripts"` block, replace `"lint": "eslint"` and add new entries so the block reads:

```json
"scripts": {
  "dev": "next dev",
  "build": "next build",
  "start": "next start",
  "lint": "eslint .",
  "lint:fix": "eslint . --fix",
  "format": "prettier --write .",
  "format:check": "prettier --check .",
  "typecheck": "tsc --noEmit",
  "test": "jest",
  "test:watch": "jest --watch",
  "test:coverage": "jest --coverage"
}
```

- [ ] **Step 6: Verify Prettier runs clean**

Run: `pnpm format:check`
Expected: Either passes, or lists files Prettier would reformat. If files are listed, run `pnpm format` once to normalize, then `pnpm format:check` should pass.

Run: `pnpm lint`
Expected: PASS (Prettier-related rules now disabled in ESLint).

Run: `pnpm typecheck`
Expected: PASS.

---

## Task 3: 引入 Husky + lint-staged + commitlint

**Files:**

- Create: `.husky/pre-commit`
- Create: `.husky/commit-msg`
- Create: `commitlint.config.cjs`
- Create: `.lintstagedrc.json`
- Modify: `package.json` (devDependencies + `prepare` script)

- [ ] **Step 1: Install hook deps**

Run: `pnpm add -D husky@^9 lint-staged@^15 @commitlint/cli@^19 @commitlint/config-conventional@^19`
Expected: pnpm-lock.yaml updates.

- [ ] **Step 2: Add `prepare` script to `package.json`**

In `"scripts"`, add:

```json
"prepare": "husky"
```

- [ ] **Step 3: Initialize Husky**

Run: `pnpm exec husky init`
Expected: Creates `.husky/` directory with default `pre-commit`. We will overwrite it.

- [ ] **Step 4: Write `.husky/pre-commit`**

Overwrite contents:

```sh
pnpm exec lint-staged
```

- [ ] **Step 5: Write `.husky/commit-msg`**

Create file with contents:

```sh
pnpm exec commitlint --edit "$1"
```

- [ ] **Step 6: Make hooks executable** (Unix only — Windows skips)

Run on macOS/Linux: `chmod +x .husky/pre-commit .husky/commit-msg`
On Windows: skip; Husky 9 handles this via git config.

- [ ] **Step 7: Create `commitlint.config.cjs`**

```js
module.exports = {
  extends: ["@commitlint/config-conventional"],
}
```

- [ ] **Step 8: Create `.lintstagedrc.json`**

```json
{
  "*.{ts,tsx,js,mjs,cjs}": ["eslint --fix", "prettier --write"],
  "*.{json,md,yml,yaml,css}": ["prettier --write"]
}
```

- [ ] **Step 9: Smoke test the commit-msg hook**

Run (in a temp branch or staged dummy change):

```bash
git commit --allow-empty -m "this is not conventional"
```

Expected: hook FAILS with commitlint complaint about subject.

Then:

```bash
git commit --allow-empty -m "chore: verify commitlint hook works"
```

Expected: PASS. Then `git reset HEAD~1` to drop the empty commit.

---

## Task 4: package.json 元数据 + .nvmrc

**Files:**

- Create: `.nvmrc`
- Modify: `package.json`

- [ ] **Step 1: Create `.nvmrc`**

```
20
```

- [ ] **Step 2: Add `engines` and `packageManager` to `package.json`**

Insert immediately after the `"private": true` line (use the pnpm version recorded in Task 1):

```json
"private": true,
"engines": {
  "node": ">=20.0.0"
},
"packageManager": "pnpm@<version-from-task-1>",
```

(For example, if Task 1 returned `10.10.0`, write `"packageManager": "pnpm@10.10.0"`.)

- [ ] **Step 3: Verify pnpm reads it**

Run: `pnpm --version`
Expected: still works; `package.json` is valid JSON.

---

## Task 5: env 类型化（TDD）

**Files:**

- Create: `.env.example`
- Create: `env.d.ts`
- Create: `lib/env.ts`
- Test: `lib/env.test.ts`

- [ ] **Step 1: Create `.env.example`**

```
# Public env vars — exposed to browser, MUST start with NEXT_PUBLIC_
NEXT_PUBLIC_APP_NAME="React Quick Starter"
NEXT_PUBLIC_API_URL=https://api.example.com

# Private env vars (server-only, NOT exposed to browser).
# Add server-only secrets below this line as your project grows.
# DATABASE_URL=
# API_SECRET_KEY=
```

- [ ] **Step 2: Create `env.d.ts`**

```ts
declare namespace NodeJS {
  interface ProcessEnv {
    /** Display name for the app. Required. */
    NEXT_PUBLIC_APP_NAME?: string
    /** Base URL for an external API. Optional. */
    NEXT_PUBLIC_API_URL?: string
  }
}
```

- [ ] **Step 3: Write the failing test** — `lib/env.test.ts`

```ts
import { getPublicEnv } from "./env"

describe("getPublicEnv", () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
  })

  afterAll(() => {
    process.env = originalEnv
  })

  it("returns appName when NEXT_PUBLIC_APP_NAME is set", () => {
    process.env.NEXT_PUBLIC_APP_NAME = "My App"
    delete process.env.NEXT_PUBLIC_API_URL
    expect(getPublicEnv()).toEqual({ appName: "My App", apiUrl: undefined })
  })

  it("includes apiUrl when NEXT_PUBLIC_API_URL is set", () => {
    process.env.NEXT_PUBLIC_APP_NAME = "My App"
    process.env.NEXT_PUBLIC_API_URL = "https://api.test"
    expect(getPublicEnv()).toEqual({ appName: "My App", apiUrl: "https://api.test" })
  })

  it("throws when NEXT_PUBLIC_APP_NAME is missing", () => {
    delete process.env.NEXT_PUBLIC_APP_NAME
    expect(() => getPublicEnv()).toThrow(/NEXT_PUBLIC_APP_NAME/)
  })
})
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm test -- lib/env.test.ts`
Expected: FAIL — `Cannot find module './env'`.

- [ ] **Step 5: Implement `lib/env.ts`**

```ts
export type PublicEnv = {
  appName: string
  apiUrl: string | undefined
}

const REQUIRED = ["NEXT_PUBLIC_APP_NAME"] as const

/**
 * Reads NEXT_PUBLIC_* env vars and validates required ones.
 * Throws on first call if a required var is missing — see .env.example.
 */
export function getPublicEnv(): PublicEnv {
  const missing = REQUIRED.filter((key) => !process.env[key])
  if (missing.length > 0) {
    throw new Error(`Missing required public env vars: ${missing.join(", ")}. See .env.example.`)
  }
  return {
    appName: process.env.NEXT_PUBLIC_APP_NAME as string,
    apiUrl: process.env.NEXT_PUBLIC_API_URL,
  }
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm test -- lib/env.test.ts`
Expected: PASS — 3 tests.

---

## Task 6: 更新 CI quality.yml

**Files:**

- Modify: `.github/workflows/quality.yml`

- [ ] **Step 1: Read current `.github/workflows/quality.yml`**

Use Read tool to see the existing structure (steps order, job name).

- [ ] **Step 2: Add `format:check` and `typecheck` steps**

After the existing ESLint step, insert two new steps (preserving the existing structure):

```yaml
- name: Check formatting (Prettier)
  run: pnpm format:check

- name: Type check
  run: pnpm typecheck
```

Place them immediately after the ESLint step and before any `npm audit` / `outdated` step (which currently use `continue-on-error: true`).

- [ ] **Step 3: Verify YAML still parses**

Run: `pnpm exec --package=js-yaml -- js-yaml .github/workflows/quality.yml > /dev/null` (or any YAML linter you have). If no YAML linter is available locally, validate by inspection — indentation and `-` alignment must match surrounding steps.

---

## Task 7: Segment 1 验收 + commit

- [ ] **Step 1: Full local verification**

Run, in order:

- `pnpm install` — Expected: clean install (already ran during Tasks 2/3, but rerun to confirm lockfile clean).
- `pnpm lint` — Expected: PASS.
- `pnpm format:check` — Expected: PASS.
- `pnpm typecheck` — Expected: PASS.
- `pnpm test` — Expected: PASS (existing tests + new `lib/env.test.ts`).

- [ ] **Step 2: Commit Segment 1**

```bash
git add .prettierrc.json .prettierignore .husky/ commitlint.config.cjs .lintstagedrc.json .nvmrc .env.example env.d.ts lib/env.ts lib/env.test.ts eslint.config.mjs package.json pnpm-lock.yaml .github/workflows/quality.yml
git commit -m "chore: add DX foundation (Prettier, Husky, commitlint, env validation)

- Prettier 3 + .prettierrc/.prettierignore + ESLint integration
- Husky 9 + lint-staged + commitlint (Conventional Commits enforced)
- .nvmrc, packageManager, engines fields
- .env.example + env.d.ts + lib/env.ts (typed runtime env validation)
- CI quality.yml gains format:check and typecheck steps"
```

Note: the commit message itself uses Conventional Commits, so the `commit-msg` hook will pass.

---

# Segment 2 — 治理 & 文档一致性

## Task 8: 创建治理文件

**Files:**

- Create: `SECURITY.md`
- Create: `CODE_OF_CONDUCT.md`
- Create: `.github/CODEOWNERS`

- [ ] **Step 1: Create `SECURITY.md`**

```markdown
# Security Policy

## Supported Versions

The latest `master` branch and the most recent tagged release receive security updates.

| Version  | Supported          |
| -------- | ------------------ |
| latest   | :white_check_mark: |
| < latest | :x:                |

## Reporting a Vulnerability

**Do not report vulnerabilities via public GitHub issues.**

Please use one of:

1. **GitHub Security Advisories** (preferred): open a private advisory at
   https://github.com/AstroAir/react-quick-starter/security/advisories/new
2. **Email**: send details to `astro_air@126.com` with subject prefix `[security]`.

Include:

- A description of the vulnerability and its impact
- Steps to reproduce
- Affected versions / commit SHA

We aim to acknowledge reports within 7 days and to disclose / patch within 90 days. Critical issues may be fast-tracked.
```

- [ ] **Step 2: Create `CODE_OF_CONDUCT.md`** with Contributor Covenant 2.1

Use the official text from https://www.contributor-covenant.org/version/2/1/code_of_conduct/code_of_conduct.md verbatim. Replace the contact placeholder near the bottom with `astro_air@126.com`.

(If the engineer cannot fetch the URL: the canonical text is ~120 lines, public domain CC0. Fetch via `curl -fsSL https://www.contributor-covenant.org/version/2/1/code_of_conduct/code_of_conduct.md -o CODE_OF_CONDUCT.md` and then sed-replace the `[INSERT CONTACT METHOD]` placeholder with the email above.)

- [ ] **Step 3: Create `.github/CODEOWNERS`**

```
# Default owners — every PR requests review from these accounts.
* @AstroAir @MaxQian888

# Example: scope-specific owners (uncomment + edit when growing the team).
# /src-tauri/  @AstroAir @MaxQian888
# /docs/       @AstroAir
```

---

## Task 9: 同步 README + README_zh

**Files:**

- Modify: `README.md`
- Modify: `README_zh.md`

- [ ] **Step 1: Edit `README.md` — Project Structure section**

Find the "Project Structure" tree (around line 153). Remove the line referencing `tailwind.config.ts` (it does not exist; Tailwind v4 doesn't need it). The corrected tree segment around root files should read:

```
├── components.json          # shadcn/ui configuration
├── next.config.ts          # Next.js configuration
├── tsconfig.json           # TypeScript configuration
├── eslint.config.mjs       # ESLint configuration
└── package.json            # Node.js dependencies and scripts
```

(No `tailwind.config.ts` line.)

- [ ] **Step 2: Edit `README.md` — Available Scripts table**

Find the "### Frontend Scripts" table. Replace the table body with:

```markdown
| Command              | Description                                                    |
| -------------------- | -------------------------------------------------------------- |
| `pnpm dev`           | Start Next.js development server on port 3000                  |
| `pnpm build`         | Build Next.js app for production (outputs to `out/` directory) |
| `pnpm start`         | Start Next.js production server (after `pnpm build`)           |
| `pnpm lint`          | Run ESLint to check code quality                               |
| `pnpm lint:fix`      | Auto-fix ESLint issues                                         |
| `pnpm format`        | Format all files with Prettier                                 |
| `pnpm format:check`  | Check formatting without writing                               |
| `pnpm typecheck`     | Run TypeScript type-check (no emit)                            |
| `pnpm test`          | Run Jest unit tests                                            |
| `pnpm test:watch`    | Run Jest in watch mode                                         |
| `pnpm test:coverage` | Run Jest with coverage report                                  |
```

- [ ] **Step 3: Edit `README.md` — Best Practices section**

Find "Best Practices" → "Commits" line. Change:

> - **Commits**: Use conventional commits (feat:, fix:, docs:, etc.)

to:

> - **Commits**: Conventional Commits are enforced via the `commit-msg` hook (commitlint). After cloning, run `pnpm install` once — the `prepare` script auto-installs the hooks.

- [ ] **Step 4: Edit `README.md` — Environment Variables section**

In "Configuration → Environment Variables", change the example block intro from "Create a `.env.local` file" to:

> Copy `.env.example` to `.env.local` to start:
>
> ```bash
> cp .env.example .env.local
> ```
>
> Then edit `.env.local` to fill in your values. The `lib/env.ts` module validates required vars at first access.

(Keep the existing "Important" callouts.)

- [ ] **Step 5: Apply identical 4 fixes to `README_zh.md`**

The Chinese README has the same structure. Translate each correction to match the existing tone:

1. Project Structure 段落删 `tailwind.config.ts`
2. Available Scripts 表补全 `lint:fix`/`format`/`format:check`/`typecheck`/`test`/`test:watch`/`test:coverage`
3. Best Practices > Commits 改为"通过 commit-msg 钩子 (commitlint) 强制 Conventional Commits。clone 后运行一次 `pnpm install`，`prepare` 脚本会自动安装钩子。"
4. Environment Variables 改为"将 `.env.example` 复制为 `.env.local` 开始：`cp .env.example .env.local`。然后编辑 `.env.local` 填入实际值。`lib/env.ts` 会在首次访问时校验必需变量。"

---

## Task 10: 同步 CLAUDE / AGENTS / CONTRIBUTING / TESTING

**Files:**

- Modify: `CLAUDE.md`
- Modify: `AGENTS.md`
- Modify: `CONTRIBUTING.md`
- Modify: `TESTING.md`

- [ ] **Step 1: Edit `CLAUDE.md`**

Find the "Architecture > Frontend Structure" bullet list. Remove the line:

> - `__tests__/` - Jest tests with React Testing Library

(Tests are collocated as `*.test.tsx`, no `__tests__/` directory exists.)

In "Development Commands", replace the existing block with:

```bash
# Frontend
pnpm dev              # Start Next.js dev server
pnpm build            # Build for production (outputs to out/)
pnpm lint             # Run ESLint
pnpm lint:fix         # Auto-fix ESLint issues
pnpm format           # Format with Prettier
pnpm format:check     # Check formatting without writing
pnpm typecheck        # TypeScript --noEmit

# Testing
pnpm test             # Run Jest tests
pnpm test:watch       # Run tests in watch mode
pnpm test:coverage    # Run tests with coverage report

# Desktop (Tauri)
pnpm tauri dev        # Dev mode with hot reload
pnpm tauri build      # Build desktop installer
pnpm tauri info       # Check Tauri environment

# Add shadcn/ui components
pnpm dlx shadcn@latest add <component-name>
```

In "Code Patterns", append (preserving existing patterns):

```tsx
// Calling Rust from the frontend (Tauri only) — see lib/tauri.ts
import { greet, isTauri } from "@/lib/tauri"
if (isTauri()) {
  greet("World").then((msg) => console.log(msg))
}
```

- [ ] **Step 2: Edit `AGENTS.md`**

Replicate the Development Commands block from CLAUDE.md (so both AI entry points stay aligned).

- [ ] **Step 3: Edit `CONTRIBUTING.md`**

In "Coding Standards" (or equivalent), insert before the existing list:

> **Tooling enforcement** (auto-runs on commit):
>
> - **Prettier** formats staged files via `lint-staged`
> - **ESLint --fix** runs on staged TS/JS files
> - **commitlint** validates commit messages against Conventional Commits
>
> First-time setup: `pnpm install` — the `prepare` script installs git hooks via Husky. If hooks don't fire, run `pnpm exec husky` manually.

Find any reference to "Code of Conduct" — change a placeholder/dead-link reference into:

> See [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md).

- [ ] **Step 4: Edit `TESTING.md`**

Add (or extend) a "Test File Organization" section near the top:

> ### Test File Organization
>
> Tests are **collocated** with their source files:
>
> - `app/page.tsx` → `app/page.test.tsx`
> - `lib/utils.ts` → `lib/utils.test.ts`
> - `components/ui/button.tsx` → `components/ui/button.test.tsx`
>
> There is **no** `__tests__/` directory. Jest discovers `*.test.{ts,tsx}` anywhere under `app/`, `components/`, and `lib/` (see `testMatch` in `jest.config.ts`).

---

## Task 11: Segment 2 commit

- [ ] **Step 1: Verify nothing else changed**

Run: `git status --short`
Expected: only the 9 files modified/created in Tasks 8–10 are listed.

- [ ] **Step 2: Stage and commit**

```bash
git add SECURITY.md CODE_OF_CONDUCT.md .github/CODEOWNERS README.md README_zh.md CLAUDE.md AGENTS.md CONTRIBUTING.md TESTING.md
git commit -m "docs: add governance files and reconcile doc inconsistencies

- SECURITY.md (vuln disclosure policy)
- CODE_OF_CONDUCT.md (Contributor Covenant 2.1)
- .github/CODEOWNERS
- README + README_zh: drop nonexistent tailwind.config.ts, complete script
  table, point env-var section at .env.example, note commitlint
  enforcement
- CLAUDE.md + AGENTS.md: drop __tests__/ reference, refresh command
  table, add IPC pattern example
- CONTRIBUTING.md: document tooling enforcement, fix CoC link
- TESTING.md: document collocated test convention"
```

---

# Segment 3 — Tauri 安全 & 元数据

## Task 12: Cargo.toml 元数据 + 新增 deps

**Files:**

- Modify: `src-tauri/Cargo.toml`

- [ ] **Step 1: Replace `[package]` block**

```toml
[package]
name = "react-quick-starter"
version = "0.1.0"
description = "React + Tauri 16/2.9 quick-starter desktop application"
authors = ["AstroAir <astro_air@126.com>"]
license = "MIT"
repository = "https://github.com/AstroAir/react-quick-starter"
edition = "2021"
rust-version = "1.77.2"
```

- [ ] **Step 2: Confirm `[lib]` block remains untouched**

Verify it still reads:

```toml
[lib]
name = "app_lib"
crate-type = ["staticlib", "cdylib", "rlib"]
```

(`[lib].name = "app_lib"` is what `lib.rs`/Tauri internals reference; do not rename.)

- [ ] **Step 3: Add `thiserror` and `tauri-plugin-updater` to `[dependencies]`**

Append to the `[dependencies]` block:

```toml
thiserror = "2"
tauri-plugin-updater = "2"
```

- [ ] **Step 4: Verify Cargo can resolve**

Run: `cd src-tauri && cargo check`
Expected: PASS (downloads new crates, no compile errors). Then `cd ..`.

If `cargo check` fails because of the package rename, run `cd src-tauri && cargo clean && cargo check`.

---

## Task 13: tauri.conf.json — CSP + updater 占位

**Files:**

- Modify: `src-tauri/tauri.conf.json`

- [ ] **Step 1: Replace `app.security.csp` value**

Find:

```json
"security": {
  "csp": null
}
```

Replace with:

```json
"security": {
  "csp": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' ipc: http://ipc.localhost; object-src 'none'; frame-src 'none'; base-uri 'self'; form-action 'self'"
}
```

- [ ] **Step 2: Add `plugins.updater` placeholder block**

After the `bundle` object (and before the closing `}` of the root), insert:

```json
,
"plugins": {
  "updater": {
    "active": false,
    "endpoints": [],
    "pubkey": ""
  }
}
```

(Note the leading comma if `bundle` was the previous final key.)

- [ ] **Step 3: Validate JSON syntax**

Run: `node -e "JSON.parse(require('fs').readFileSync('src-tauri/tauri.conf.json','utf8'))"`
Expected: no output (silent success). Any SyntaxError means a missing/extra comma — fix and re-run.

- [ ] **Step 4: Add a CSP-awareness comment to `app/layout.tsx`**

At the very top of the file (above the imports), insert:

```tsx
// NOTE: The Tauri production CSP is set in src-tauri/tauri.conf.json.
// If you call an external API from the browser, add its origin to the
// `connect-src` directive there, otherwise the request will be blocked.
```

(Web-mode `pnpm dev` is unaffected — the CSP applies only to the Tauri-bundled webview.)

---

## Task 14: capabilities/desktop.json 骨架

**Files:**

- Create: `src-tauri/capabilities/desktop.json`

- [ ] **Step 1: Create the file**

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "desktop-extras",
  "description": "Desktop-only permissions. Uncomment entries below as you adopt plugins (e.g., clipboard-manager, fs, dialog). Keep default.json minimal; put feature-scoped permissions here.",
  "platforms": ["linux", "macOS", "windows"],
  "windows": ["main"],
  "permissions": []
}
```

(Note: JSON does not support comments, so the example permission strings live in the description and in `UPDATER.md`. The empty `permissions` array is the actual skeleton.)

- [ ] **Step 2: Verify JSON syntax**

Run: `node -e "JSON.parse(require('fs').readFileSync('src-tauri/capabilities/desktop.json','utf8'))"`
Expected: silent success.

- [ ] **Step 3: Verify Tauri build still picks up capabilities**

Run: `cd src-tauri && cargo check && cd ..`
Expected: PASS.

---

## Task 15: lib.rs 注册 updater plugin

**Files:**

- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Replace `lib.rs` contents**

```rust
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let mut builder = tauri::Builder::default();

  #[cfg(desktop)]
  {
    builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
  }

  builder
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
```

- [ ] **Step 2: Verify Rust compiles**

Run: `cd src-tauri && cargo check && cd ..`
Expected: PASS.

---

## Task 16: UPDATER.md

**Files:**

- Create: `src-tauri/UPDATER.md`

- [ ] **Step 1: Create the file**

````markdown
# Tauri Updater Setup

This template ships the `tauri-plugin-updater` plugin **disabled** (`tauri.conf.json` → `plugins.updater.active = false`). Follow these steps to enable in-app updates.

## 1. Generate a signing key pair

```bash
pnpm tauri signer generate -w ~/.tauri/react-quick-starter.key
```
````

You'll be prompted for a password (optional but recommended). The command writes:

- `~/.tauri/react-quick-starter.key` — **PRIVATE KEY**, never commit
- `~/.tauri/react-quick-starter.key.pub` — public key

## 2. Wire the public key into config

Copy the **single-line** content of `~/.tauri/react-quick-starter.key.pub` into
`src-tauri/tauri.conf.json` → `plugins.updater.pubkey`.

## 3. Configure the update endpoint

GitHub Releases is the simplest host. Set:

```json
"plugins": {
  "updater": {
    "active": true,
    "endpoints": [
      "https://github.com/AstroAir/react-quick-starter/releases/latest/download/latest.json"
    ],
    "pubkey": "<paste public key here>"
  }
}
```

The `latest.json` file format is documented at https://v2.tauri.app/plugin/updater/.

## 4. Sign builds in CI

Set the following GitHub Actions secrets:

- `TAURI_PRIVATE_KEY` — base64-encoded contents of your private key file
- `TAURI_KEY_PASSWORD` — the password (empty string if you skipped one)

The existing `.github/workflows/release.yml` references these env vars in the
Tauri build step (currently behind comments — uncomment when ready).

## 5. Flip `active` to `true` and ship

```diff
- "active": false,
+ "active": true,
```

Tag a release. The updater will check the configured endpoint on app startup.

````

---

## Task 17: Segment 3 验收 + commit

- [ ] **Step 1: Smoke check — no Tauri build break**

Run: `cd src-tauri && cargo check && cd ..`
Expected: PASS.

(Optional, only if Tauri toolchain installed locally and you have time:
`pnpm tauri build --bundles none` — verifies CSP doesn't break the bundle.
Skip if it would take >5 minutes; CI will catch.)

- [ ] **Step 2: Commit Segment 3**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json src-tauri/capabilities/desktop.json src-tauri/src/lib.rs src-tauri/UPDATER.md app/layout.tsx
git commit -m "feat(tauri): harden security and metadata, add updater placeholder

- Cargo.toml: real package metadata (name, license, repo, authors)
- Cargo.toml: add thiserror (used by Segment 4 commands) and
  tauri-plugin-updater
- tauri.conf.json: enable a strict CSP suitable for static-export
  Next.js + Tauri 2 IPC; previously csp: null
- tauri.conf.json: plugins.updater placeholder, active=false
- capabilities/desktop.json: empty skeleton for desktop-scoped
  permissions (default.json stays minimal)
- lib.rs: register updater plugin under #[cfg(desktop)]
- UPDATER.md: 5-step guide for key gen + endpoint + CI signing"
````

---

# Segment 4 — Tauri IPC 类型化桥

## Task 18: Rust commands.rs（TDD）

**Files:**

- Create: `src-tauri/src/commands.rs`

- [ ] **Step 1: Write the file with command + tests in one shot**

```rust
use serde::Serialize;

#[derive(Debug, thiserror::Error, Serialize)]
pub enum AppError {
  #[error("name cannot be empty")]
  EmptyName,
}

#[tauri::command]
pub fn greet(name: &str) -> Result<String, AppError> {
  if name.trim().is_empty() {
    return Err(AppError::EmptyName);
  }
  Ok(format!("Hello, {name}! Welcome to Tauri 2."))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn greet_with_name() {
    assert_eq!(greet("World").unwrap(), "Hello, World! Welcome to Tauri 2.");
  }

  #[test]
  fn greet_empty_errors() {
    assert!(matches!(greet("").unwrap_err(), AppError::EmptyName));
  }

  #[test]
  fn greet_whitespace_errors() {
    assert!(matches!(greet("   ").unwrap_err(), AppError::EmptyName));
  }
}
```

- [ ] **Step 2: Run Rust tests in isolation (will fail without lib.rs wiring)**

Run: `cd src-tauri && cargo test --lib commands && cd ..`
Expected: FAIL — `error[E0583]: file not found for module commands` (or similar; commands.rs isn't yet declared in lib.rs).

This is the failing-test step.

---

## Task 19: lib.rs — 注册 commands

**Files:**

- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add `mod commands;` and the `invoke_handler`**

Replace the contents of `lib.rs` with:

```rust
mod commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let mut builder = tauri::Builder::default();

  #[cfg(desktop)]
  {
    builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
  }

  builder
    .invoke_handler(tauri::generate_handler![commands::greet])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
```

- [ ] **Step 2: Run cargo test to verify it passes**

Run: `cd src-tauri && cargo test --lib commands && cd ..`
Expected: PASS — 3 tests in `commands::tests`.

---

## Task 20: 加 @tauri-apps/api dep + Jest mock 接线

**Files:**

- Modify: `package.json` (add dependency)
- Create: `__mocks__/tauri-api.js`
- Modify: `jest.config.ts`

- [ ] **Step 1: Add `@tauri-apps/api` as a runtime dependency**

Run: `pnpm add @tauri-apps/api@^2`
Expected: package added to `dependencies` (NOT devDependencies — used at runtime).

- [ ] **Step 2: Create `__mocks__/tauri-api.js`**

```js
module.exports = {
  invoke: jest.fn(),
}
```

- [ ] **Step 3: Add moduleNameMapper to `jest.config.ts`**

Read `jest.config.ts` first to see the current `moduleNameMapper` block (it likely has entries for CSS/asset mocks). Add a new key inside the existing object:

```ts
"^@tauri-apps/api/core$": "<rootDir>/__mocks__/tauri-api.js",
```

(If `moduleNameMapper` doesn't exist yet, add the whole object inside the Jest config:)

```ts
moduleNameMapper: {
  // ... existing entries ...
  "^@tauri-apps/api/core$": "<rootDir>/__mocks__/tauri-api.js",
},
```

- [ ] **Step 4: Verify existing tests still pass**

Run: `pnpm test`
Expected: PASS (including the previously-passing tests; nothing should break from the mock addition).

---

## Task 21: lib/tauri.ts (TDD)

**Files:**

- Create: `lib/tauri.ts`
- Test: `lib/tauri.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { invoke } from "@tauri-apps/api/core"
import { greet, isTauri } from "./tauri"

jest.mock("@tauri-apps/api/core")

const mockedInvoke = invoke as jest.MockedFunction<typeof invoke>

describe("lib/tauri", () => {
  beforeEach(() => {
    mockedInvoke.mockReset()
  })

  describe("isTauri", () => {
    it("returns false in jsdom (no Tauri marker)", () => {
      expect(isTauri()).toBe(false)
    })

    it("returns true when __TAURI_INTERNALS__ is on window", () => {
      ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
      expect(isTauri()).toBe(true)
      delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
    })
  })

  describe("greet", () => {
    it("invokes the greet command with the name argument", async () => {
      mockedInvoke.mockResolvedValue("Hello, X!")
      const result = await greet("X")
      expect(mockedInvoke).toHaveBeenCalledWith("greet", { name: "X" })
      expect(result).toBe("Hello, X!")
    })

    it("propagates rejection from invoke", async () => {
      mockedInvoke.mockRejectedValue(new Error("boom"))
      await expect(greet("X")).rejects.toThrow("boom")
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- lib/tauri.test.ts`
Expected: FAIL — `Cannot find module './tauri'`.

- [ ] **Step 3: Implement `lib/tauri.ts`**

```ts
import { invoke } from "@tauri-apps/api/core"

/**
 * Detects whether the app is running inside a Tauri webview.
 * Use this to gate any code that calls `invoke` so the same component
 * works in both `pnpm dev` (web) and `pnpm tauri dev` (desktop).
 */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
}

// Type-safe wrappers for Rust commands defined in src-tauri/src/commands.rs.
// Keep this file as the SOLE caller of `invoke` — business code imports
// named functions from here, never `invoke` directly.

export async function greet(name: string): Promise<string> {
  return invoke<string>("greet", { name })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- lib/tauri.test.ts`
Expected: PASS — 4 tests.

---

## Task 22: tauri-demo 组件 + 接入 page.tsx

**Files:**

- Create: `components/tauri-demo.tsx`
- Modify: `app/page.tsx`

- [ ] **Step 1: Create `components/tauri-demo.tsx`**

```tsx
"use client"

import { useState } from "react"
import { greet, isTauri } from "@/lib/tauri"
import { Button } from "@/components/ui/button"

export function TauriDemo() {
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  if (!isTauri()) return null

  async function handleClick() {
    setError(null)
    try {
      setMessage(await greet("World"))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="mt-8 flex flex-col items-center gap-2">
      <Button onClick={handleClick}>Call Rust greet()</Button>
      {message && <p className="text-sm">{message}</p>}
      {error && <p className="text-sm text-red-500">{error}</p>}
    </div>
  )
}
```

- [ ] **Step 2: Wire it into `app/page.tsx`**

Read `app/page.tsx` first. At the top, add the import:

```tsx
import { TauriDemo } from "@/components/tauri-demo"
```

Find the closing tag of the outermost wrapper `<div>` / `<main>` of the page, and just before it insert:

```tsx
{
  /* Remove this and lib/tauri.ts when not using Tauri IPC */
}
;<TauriDemo />
```

- [ ] **Step 3: Verify Jest still passes (TauriDemo renders null in jsdom)**

Run: `pnpm test`
Expected: PASS — all existing `app/page.test.tsx` cases continue to pass because `isTauri()` returns false in jsdom and `TauriDemo` returns `null`.

If any `page.test.tsx` test fails because it asserts on the exact DOM tree shape, edit it to add the rendered `null` case (no extra elements appear, so most assertions should be unaffected).

- [ ] **Step 4: Verify static build still works**

Run: `pnpm build`
Expected: PASS — produces `out/` directory. Confirms TauriDemo doesn't break SSG.

---

## Task 23: 文档 — IPC 章节

**Files:**

- Modify: `README.md`
- Modify: `README_zh.md`

- [ ] **Step 1: Add "Calling Rust from JavaScript" section to `README.md`**

Find the "Desktop Application Development" section. After "Tauri Development Files", insert:

````markdown
### Calling Rust from JavaScript

The template ships a typed IPC bridge demo. Pattern:

1. **Add a Rust command** in `src-tauri/src/commands.rs`:
   ```rust
   #[tauri::command]
   pub fn my_command(arg: &str) -> Result<String, AppError> {
     Ok(format!("got {arg}"))
   }
   ```
````

2. **Register it** in `src-tauri/src/lib.rs`:

   ```rust
   .invoke_handler(tauri::generate_handler![commands::greet, commands::my_command])
   ```

3. **Add a typed wrapper** in `lib/tauri.ts`:
   ```ts
   export async function myCommand(arg: string): Promise<string> {
     return invoke<string>("my_command", { arg })
   }
   ```

`lib/tauri.ts` is the single point that calls `invoke()` — business code imports named functions from it. Use `isTauri()` to gate any code path that depends on the desktop runtime.

````

- [ ] **Step 2: Translate the same section into `README_zh.md`**

Add the equivalent under the Chinese "桌面应用开发" section. Keep code blocks identical to the English version.

---

## Task 24: Segment 4 验收 + commit

- [ ] **Step 1: Final verification**

Run, in order:
- `pnpm lint` — Expected: PASS
- `pnpm format:check` — Expected: PASS
- `pnpm typecheck` — Expected: PASS
- `pnpm test` — Expected: PASS (all suites: existing + env + tauri)
- `cd src-tauri && cargo test && cd ..` — Expected: PASS (3 greet tests)

- [ ] **Step 2: Optional manual smoke test (Tauri toolchain required)**

Run: `pnpm tauri dev`
Expected behavior:
1. Tauri window opens
2. The page shows the existing landing layout
3. The "Call Rust greet()" button is visible (only when `isTauri()` returns true)
4. Clicking it shows `Hello, World! Welcome to Tauri 2.`
5. Webview devtools (`Ctrl+Shift+I`) Console shows no CSP violation errors

Then run: `pnpm dev` (web mode)
Expected:
- Page loads at http://localhost:3000
- "Call Rust greet()" button is **not** rendered (TauriDemo returns null)

Skip this step if the Tauri toolchain isn't installed locally; CI will catch issues.

- [ ] **Step 3: Commit Segment 4**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs lib/tauri.ts lib/tauri.test.ts components/tauri-demo.tsx app/page.tsx __mocks__/tauri-api.js jest.config.ts package.json pnpm-lock.yaml README.md README_zh.md
git commit -m "feat(tauri): add typed IPC bridge with greet() demo

- src-tauri/src/commands.rs: example greet command with AppError enum,
  serde::Serialize derive, and 3 unit tests
- lib.rs: register commands::greet via invoke_handler
- lib/tauri.ts: single point of invoke() calls; exports isTauri() and
  typed wrappers (greet for now). Convention: business code imports
  named functions, never invoke directly.
- components/tauri-demo.tsx: client component, renders null in web mode
- app/page.tsx: append <TauriDemo />
- __mocks__/tauri-api.js + jest.config.ts: mock @tauri-apps/api/core
  for unit tests
- README + README_zh: 'Calling Rust from JavaScript' how-to section"
````

---

# Final Validation Checklist

After Task 24, the repo should pass every item in the spec's acceptance criteria:

- [ ] `pnpm install` triggers `prepare` → Husky hooks active in `.husky/_/`
- [ ] `pnpm format:check` passes
- [ ] `pnpm lint` passes
- [ ] `pnpm typecheck` passes
- [ ] `pnpm test` passes (all suites including new `lib/env.test.ts` + `lib/tauri.test.ts`)
- [ ] `cd src-tauri && cargo test` passes 3 greet tests
- [ ] A non-conventional commit message is rejected by `commit-msg` hook
- [ ] An unformatted `*.ts` file gets `prettier --write` applied during `git commit`
- [ ] `pnpm tauri dev` shows demo button; clicking returns `Hello, World! Welcome to Tauri 2.`
- [ ] `pnpm dev` (web) hides the demo button (`isTauri()` false)
- [ ] CI's `quality.yml` runs `format:check` + `typecheck` on PRs
- [ ] No reference to `__tests__/` or `tailwind.config.ts` remains in any doc
- [ ] `SECURITY.md`, `CODE_OF_CONDUCT.md`, `.github/CODEOWNERS` exist
- [ ] `src-tauri/UPDATER.md` exists; `plugins.updater.active` is `false`
- [ ] No stray uncommitted changes
