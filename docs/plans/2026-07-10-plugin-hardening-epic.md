# Plugin System & Inter-Plugin Communication — Hardening Epic (agent-executable plan)

> **Audience:** implementation agents. Each work item below is self-contained and parcelable to one agent. Anchor on **symbol names + file paths** (line numbers drift — grep for the symbol). Read this whole "How to work here" section before touching code.

---

## 0. Context & goal

A four-agent adversarial audit of the plugin subsystem (`lib/plugin/**`, `packages/plugin-sdk`, `plugins/**`, `src-tauri/src/plugin_api/**`) found the surface is broad and well-tested, but its **security & governance model is largely advisory, not enforced**, and the governance/audit layer that should catch this only verifies that strings/files _exist_, not that code is _reachable_. Four root causes generate ~80% of the findings:

1. **Frontend plugins run unsandboxed** in the main renderer realm — every permission gate below is advisory. (Fixed in Wave 1.2, see §2.)
2. **The signature layer is self-defeating**: `requireSignatures` defaults `true` but `PluginSignatureVerifier.verify()` can never return `valid:true` (the crypto path was removed), so no non-builtin plugin loads; turn it off and `plugin_install` verifies nothing.
3. **The permission mapping is broken both ways** — `permissionMapping` (`lib/plugin/api/permission-api.ts`) silently drops legit permissions (killing `agent.dispatchSubagent`/`runTeam`/`readSharedMemory`/`queryTwinMemory`) while `ctx.ai`/`ctx.vector`/`ctx.project` are ungated (quota theft, project deletion, unredacted LLM sends).
4. **Audits verify presence, not reachability** — why three VS Code contribution bridges (grammars/icons/snippets) and several "supported" hooks (`onPreToolUse`/`onPostToolUse`, …) are dormant while reporting healthy.

**Confirmed product decisions (do not re-litigate):**

- **Isolation = pragmatic trust model.** First-party (`builtin`) and developer (`dev`) frontend plugins are trusted code; untrusted (`local`/`marketplace`/`git`) frontend plugins must run through the WASM host **or** be explicitly user-trusted. A full renderer membrane (iframe/Worker) is **out of scope**.
- **Tool-use hooks = full wiring.** The chat path must supply `onPermissionRequest`/`onToolResultReview` responders (reusing the `agent-executor` pattern) so `onPreToolUse`/`onPostToolUse` truly intercept sidecar tool execution, incl. `mcp__` tools.

**Outcome:** the trust boundary becomes real and honest; declared capabilities == runtime behavior; inter-plugin comms are scoped and leak-free; dormant surfaces are wired or truthfully downgraded; a reachability gate prevents regressions.

---

## 1. How to work in this repo (READ FIRST — every item depends on this)

### 1.1 Hard rules (from `CLAUDE.md`, non-negotiable)

- **Research before implementing.** Grep for an existing util/hook/component before writing new; reuse. The audit already located the reuse targets — they're cited per item.
- **No simplifications.** No stubs/mock-outs/"TODO later" on production paths; don't strip error handling/validation/edge cases. If genuinely blocked, surface it.
- **Every new/changed file under `components/**`, `hooks/**`, `lib/**`, `stores/**`, `src-tauri/src/**` ships a co-located test** (`*.test.ts(x)`, or in-file `#[cfg(test)]` for Rust). Exceptions: `components/ui/`, `components/ai-elements/`. Coverage ≥90% lines/branches/functions on changed files.
- **i18n:** no hard-coded user-facing strings in `.tsx` (incl. aria labels, placeholders, toasts, errors). Add keys to **both** `i18n/messages/en/<ns>/…json` and `i18n/messages/zh-CN/<ns>/…json`, then run `pnpm i18n:build`. The generated `en.json`/`zh-CN.json` are **never hand-edited**.
- **Language:** code/comments/commits in **English**; the split-source i18n values are the only place for user-facing text.

### 1.2 Repo-specific traps (each cost a real incident)

- **Jest project split:** pure `.ts` under `lib/stores/cli/packages/types/plugins/i18n` **and `lib/plugin/**`** run in the **node** env (no `window`/`localStorage`/IndexedDB). Everything else (and any `.ts` needing Dexie/`localStorage`/`window`) runs in **jsdom** and must carry a `/** @jest-environment jsdom */` docblock. → In node-env plugin suites, mock modules that read `window.localStorage`, or force jsdom.
- **Pre-existing broken baselines — gate on "no NEW failures," not repo-green:**
  - `pnpm typecheck`: has pre-existing errors (needs ~12GB heap: `NODE_OPTIONS=--max-old-space-size=12288`).
  - `pnpm lint` (`eslint .`): fails repo-wide. Lint only your changed files: `pnpm exec eslint <files>`.
  - `lib/plugin/core/manager.test.ts`: **6 pre-existing failures** (`getDb() called on the server` — node env, no IndexedDB). Verify your diff adds **0 new** failures (stash-and-compare if unsure).
  - `cargo test`: some pre-existing failures; RTK/tee can mask cargo's exit code — **read the tee log**, don't trust `$?`. Rust toolchain pinned 1.93.0, edition 2021, MSRV 1.89.0.
  - `i18n:sort:check` fails pre-existing; keep keys alphabetically sorted anyway.
- **i18n split sources are per-area directories**, not one file per namespace: e.g. the `plugins.detail` namespace lives in `i18n/messages/{en,zh-CN}/plugins/detail.json`. A `PostToolUse` hook enforces en/zh key parity on every edit to a message file — it will block the edit if you add a key to only one locale.
- **Adding/renaming a manifest capability touches ~9 places**, incl. **two Rust parity lists in `src-tauri/src/plugin_api/cmd_lint.rs`** plus `lib/plugin/contracts/{module-bridge-map,capability-bridge-map,plugin-capabilities,plugin-points}.ts`, `validation.ts` `VALID_PERMISSIONS`, and `extension-point-consumers.md`. Run `pnpm audit:slots` + the contract Jest suites after any such change.
- **Dexie schema bumps** (if any item needs a new table/index): use the true native `nextSchemaVersion`, **never** `db.verno+1`; follow the `dexie-migration` skill.
- **Static export:** `app/api/` does not exist at runtime; anything needing an HTTP server lives in Tauri Rust (axum). Node built-ins are stubbed on web/mobile via `NODE_ONLY_MODULES` in `next.config.ts`.
- **Secrets/keyring:** all keyring access goes through `src-tauri` `secret_store`; never create a new `keyring::Entry`.
- **Concurrent tree:** other agent sessions may share the branch. Before any git stage/commit, follow the `concurrent-tree-safety` skill. Prefer per-item commits; do not batch waves into one mega-diff.

### 1.3 Verification commands (per item + per wave)

```bash
pnpm test -- <changed test files>              # jest, single/multi file
pnpm test:coverage:changed -- --strict         # ≥90% on changed files (gates)
pnpm exec eslint <changed files>               # lint only your files
NODE_OPTIONS=--max-old-space-size=12288 pnpm typecheck   # gate: no NEW errors
pnpm i18n:build && pnpm lint:i18n              # after any message edit
pnpm sidecar:test                              # node --test on sidecar/ (Wave 3 hook wiring)
cargo test --manifest-path src-tauri/Cargo.toml <filter>   # Rust; READ THE LOG
pnpm check:all                                 # aggregate gate (typecheck·lint·lint:i18n·i18n:build:check·skills:check·audit:slots·…)
pnpm tauri dev                                 # drive the real app (see per-wave "Verify")
```

### 1.4 Definition of done (every item)

1. Behavior implemented fully (no stubs). 2. Co-located test(s) added, green. 3. `test:coverage:changed --strict` passes for changed files. 4. `eslint` clean on changed files. 5. `typecheck` adds no new errors. 6. If i18n touched: `i18n:build` + `lint:i18n` green. 7. If Rust touched: `cargo test` filter green (read log). 8. PR-sized, one item (or one wave) per branch.

---

## 2. STATUS — already done (do NOT redo)

### ✅ Wave 1.2 — Frontend trust boundary (COMPLETE, verified, 0 regressions)

Root cause #1. Shipped changes (reference implementation for the pattern — mirror its rigor):

- **Deleted the dead `PluginSandbox`**: removed `lib/plugin/core/sandbox.ts` + `sandbox.test.ts`, its `export { PluginSandbox }` in `lib/plugin/core/index.ts`, and the `"PluginSandbox"` entry in `index.test.ts`. (It was never instantiated in the load path; it overstated the posture.)
- **Trusted-frontend allowlist** in `lib/plugin/core/plugins-policy-storage.ts`: `TRUSTED_FRONTEND_STORAGE_KEY` (`cognia.plugins.trusted-frontend`), `isInherentlyTrustedFrontendSource(source)` (true for `builtin`/`dev`), `readTrustedFrontendPlugins()`, `isFrontendPluginTrusted(id)`, `setFrontendPluginTrusted(id, on)`. Tested in `plugins-policy-storage.test.ts`.
- **Gate** in `lib/plugin/core/manager.ts`: `PluginFrontendTrustError` (exported), `requiresExplicitFrontendTrust(type, source, pluginId)` (true iff type∈{frontend,hybrid} ∧ !inherentlyTrusted ∧ !userTrusted), thrown in `loadPlugin` **right after** the signature gate; public `setFrontendTrust(id, on)` / `isFrontendTrusted(id)`. Tested in `manager.test.ts` (mock `@/lib/plugin/core/plugins-policy-storage` with an in-memory allowlist because that suite is node-env).
- **UI:** `components/plugins/detail/plugin-frontend-trust-card.tsx` (+ test), rendered in `plugin-detail-permissions.tsx` (above the table + in the empty branch). Compute `applicable` **before** the `useState` initializer so `getPluginManager()` is only touched when the card renders.
- **i18n:** `plugins.detail.frontendTrust.{title,description,switchAria,blockedHint}` in `i18n/messages/{en,zh-CN}/plugins/detail.json`.
- **Docs:** `docs/content/docs/en/adr/0013-wasm-plugins.md` "Frontend trust boundary" section.

**Everything below is TODO.**

---

## 3. Work items

> Format per item — **ID · Severity · Goal · Evidence (finding + anchors) · Approach (reuse-first) · Files · Tests · Acceptance · Depends on.**

### WAVE 1 — Trust & sandbox boundary (remaining)

#### W1.1 · High · Signature: verify host-side + persist a receipt the load gate consults

- **Evidence:** `PluginSignatureVerifier.verify()` (`lib/plugin/security/signature.ts`) unconditionally returns `{valid:false,reason:"Signature required but not found"}` when `requireSignatures` (default `true` via `plugins-policy-storage.ts DEFAULT_POLICY.signatureRequired` and `stores/plugin-runtime` `PLUGIN_POLICY_DEFAULTS`). So `manager.verifyPluginSignature` (short-circuits `true` only when `!requireSignatures && allowUntrusted`) → install gate (`registerBackendInstall`) and load gate (`loadPlugin`) throw for every non-`builtin` plugin. Meanwhile the **real** crypto already runs host-side but is discarded: `src-tauri/src/plugin_api/marketplace.rs::verify_download_integrity` (checksum + Ed25519 over `<id>:<ver>:<bytes>`) is called by `install_archive_into_plugin_dir` (marketplace/github) and returns `Result<()>` with **no persisted flag**. `src-tauri/src/plugin_api/lifecycle.rs::plugin_install` does **no** signature check and `PluginRuntimeSnapshot` has no verified field.
- **Approach (reuse the existing crypto; add a receipt):**
  1. Rust: after a successful `verify_download_integrity` in `install_archive_into_plugin_dir`, write a receipt file `<plugin_dir>/.cognia-verification.json` = `{ verifiedVia: "signature"|"checksum", version, verifiedAt }` (`signature` when sig+key were present, else `checksum` when only a checksum was present; write nothing when neither). Add a Tauri command `plugin_read_verification(plugin_id) -> Option<{verifiedVia,version,verifiedAt}>` reading that file; **register it** in the `generate_handler!` list (grep `plugin_download_version` to find the list) and add any ACL/capability entry (`tauri-rust-reviewer` traps).
  2. TS: `signature.ts verify(pluginPath)` — when `requireSignatures`, call the new command (derive id via the existing `extractPluginId`); pass iff `verifiedVia === "signature"`; keep the `!requireSignatures` branch. Keep `builtin` exemption at the call sites (already there in `loadPlugin`/scan). Fix the stale "default is false" comment near `manager.verifyPluginSignature`.
- **Files:** `src-tauri/src/plugin_api/marketplace.rs`, `lifecycle.rs`, `mod.rs` (command list/ACL), `lib/plugin/security/signature.ts`, `lib/plugin/core/manager.ts`.
- **Tests:** Rust `#[cfg(test)]`: receipt written on signed vs checksum-only install; `plugin_read_verification` reads it; absent → `None`. TS: `signature.test.ts` — signed receipt → pass under `requireSignatures`; checksum-only/absent → reject; `!requireSignatures` → pass with warning. Mock the invoke.
- **Acceptance:** a correctly Ed25519-signed marketplace/github install loads under default policy; an unsigned local install is refused under default policy but loads when the user sets `signatureRequired:false`; builtins always load.
- **Depends on:** none.

#### W1.3 · Medium · Network egress default-deny when no allowlist declared

- **Evidence:** `src-tauri/src/plugin_api/mod.rs::network_host_allowed` returns `true` (unrestricted) when a plugin granted `network:fetch` has no `networkAccess.allowedDomains`; `lib/plugin/security/webview-csp.ts` emits `connect-src *` for the same case. Default posture is `balanced` (`lib/plugin/security/security-posture.ts`).
- **Approach:** under the default `balanced` posture, a plugin with `network:fetch` **and no allowlist** → deny (or prompt) instead of `*`. Only `strict` already closes this; make the undeclared-allowlist case fail-closed in `balanced`. Keep an explicit allowlist working.
- **Files:** `src-tauri/src/plugin_api/mod.rs`, `lib/plugin/security/webview-csp.ts` (+ tests both sides).
- **Tests:** Rust: allowlisted host allowed, non-listed denied, empty-allowlist denied under balanced. TS: CSP string omits `*` for empty-allowlist under balanced.
- **Acceptance:** a `network:fetch` plugin with no declared domains cannot reach arbitrary hosts by default.
- **Depends on:** none.

#### W1.4 · Medium · WASM stub capabilities → typed not-implemented + hidden in grant UI; reject missing api-version section

- **Evidence:** `src-tauri/src/plugin_api/wasm/wit/since_v0_1.rs` — `notification` only `log::info!`s, `clipboard.read_text` returns `""`, `clipboard.write_text` no-ops, `ai.generate_text` errors — yet the grant sheet still offers them. `wasm/host.rs::load` falls back to the manifest-declared (attacker-controlled) api-version when the `cognia:api-version` custom section is absent (ADR-0013 says treat as malformed).
- **Approach:** return a typed `not-implemented` result the guest can branch on (don't silently return empty/log); hide/gray the unimplemented caps in the grant UI (`components/plugins/**` permission/grant sheet) with i18n; make `parse_plugin_api_version` reject a binary missing the custom section.
- **Files:** `src-tauri/src/plugin_api/wasm/wit/since_v0_1.rs`, `wasm/host.rs`, the grant-sheet component under `components/plugins/`, i18n.
- **Tests:** Rust: missing api-version section → load error; stubbed caps return the typed not-implemented. Component: unimplemented caps rendered disabled.
- **Acceptance:** granting a stubbed cap no longer implies a working capability; tampered/missing api-version rejected.
- **Depends on:** none.

### WAVE 2 — Permission model unification

#### W2.1 · High · Fix `permissionMapping` + add drift-guard test

- **Evidence:** `lib/plugin/api/permission-api.ts` `permissionMapping` (identity group) **omits** `agent:dispatch`, `agent:shared-memory:read`, `twin:read`, `canvas:run`, `canvas:collaborate`; and the legacy alias maps `secrets → ["settings:read","settings:write"]` (should be `secrets:*`). `initializePluginPermissions` silently drops any manifest permission absent from `permissionMapping`, so declaring those in a manifest is a no-op → `ctx.agent.dispatchSubagent`/`runTeam` and `ctx.agent.context.readSharedMemory`/`queryTwinMemory` (gated by `pluginHasApiPermission` in `lib/plugin/core/context.ts`) always throw. All five are valid members of the `PluginAPIPermission` union (`types/plugin/plugin.ts` ~4415-4451) and `PluginPermission` (~364-440) and in `validation.ts VALID_PERMISSIONS`.
- **Approach:** add the five identity mappings; fix the legacy `secrets` alias. Add an **exhaustiveness test** asserting every `PluginAPIPermission` value round-trips through `permissionMapping` (extend the enumerated list in `permission-api.test.ts`).
- **Files:** `lib/plugin/api/permission-api.ts` (+ `permission-api.test.ts`), possibly `lib/plugin/core/context.test.ts` for positive gate tests.
- **Tests:** declaring `agent:dispatch` → `pluginHasApiPermission(id,"agent:dispatch")` true and `dispatchSubagent` succeeds; legacy `secrets` → `secrets:read/write` reachable; exhaustiveness test fails if a future `PluginAPIPermission` is unmapped.
- **Acceptance:** the four dead SDK entry points work when declared; no `PluginAPIPermission` is silently droppable.
- **Depends on:** none.

#### W2.2 · High · Unify introspection with the enforcement guard

- **Evidence:** two disjoint stores — enforcement `PermissionGuard` (`lib/plugin/security/permission-guard.ts`, seeded raw from manifest) vs introspection `grantedPermissions` (`permission-api.ts`, seeded via `permissionMapping`). `ctx.permissions.hasPermission("git:write")` returns `false` even when `ctx.git.commit()` is allowed, because `git:*`/`terminal:*`/native perms aren't in `permissionMapping`.
- **Approach:** make `ctx.permissions.hasPermission`/`getGrantedPermissions` (`permission-api.ts`) also consult `getPermissionGuard().check(pluginId, perm)` for `PluginPermission`-typed perms, so introspection agrees with enforcement.
- **Files:** `lib/plugin/api/permission-api.ts` (+ tests).
- **Tests:** a plugin with `git:write` → `hasPermission("git:write")` true; `getGrantedPermissions` includes guard-enforced perms.
- **Depends on:** W2.1 (same file).

#### W2.3 · High · Gate the ungated sensitive APIs

- **Evidence:** `lib/plugin/core/context.ts` (`createFullPluginContext`, the `contextAPI` block) creates `ctx.ai`, `ctx.vector`, `ctx.project`, `ctx.canvas`, `ctx.artifact`, `ctx.theme`, `ctx.media`, `ctx.export`, `ctx.import` **raw** (no guard); their `*-api.ts` factories have zero permission checks. Any loaded plugin can spend the user's LLM quota (`ctx.ai.chat`), embed (`ctx.vector`), or **delete any project** (`ctx.project` → `useProjectStore.getState().deleteProject`).
- **Approach:** wrap each factory with `createGuardedAPI(pluginId, api, { method: "perm" })` against its already-declared permission, mirroring the working guarded siblings — canonical example `lib/plugin/api/git-api.ts` (maps each method to `git:read`/`git:write`). Map: ai→`ai:chat`/`ai:embed`; vector→`vector:read`/`vector:write`; project→`project:read`/`project:write`/`project:delete`; canvas/artifact/theme/media/export/import similarly.
- **Files:** `lib/plugin/api/{ai-provider,vector,project,canvas,artifact,theme-api,media,export,import}-api.ts` (+ tests), `lib/plugin/core/context.ts` if wrapping happens there.
- **Tests:** each API — undeclared perm → `PermissionError`; declared → passes (mirror `context.test.ts` native-boundary block).
- **Depends on:** W2.1 (mappings must exist first for consistency).

#### W2.4 · Medium · PII redaction for plugin model calls

- **Evidence:** `ctx.ai.chat/embed` (`ai-provider-api.ts`) and `ctx.vector.embed` (`vector-api.ts`) send to the model/embedder with no redaction, diverging from the app's cross-cutting gate `lib/twin/ingest/redact.ts::hasNoLeakingPii` (used by Twin/Goal/Connector via `lib/connectors/ai-loop/safe-send-prompt.ts`).
- **Approach:** route plugin AI/embed content through `hasNoLeakingPii` (reuse `safe-send-prompt` pattern) before dispatch.
- **Files:** `lib/plugin/api/ai-provider-api.ts`, `vector-api.ts` (+ tests). Re-run the `pii-gate-auditor` agent after.
- **Depends on:** W2.3 (same files).

#### W2.5 · Medium · `setSecure` real confidentiality

- **Evidence:** `lib/plugin/api/crypto-helpers.ts::deriveKey(pluginId)` derives the key solely from the **public** pluginId → anyone with the localStorage blob or a backup export + pluginId decrypts. Consumed by `storage-api.ts setSecure`.
- **Approach:** derive from the per-install master/backup key (reuse `secrets-api`'s `getDefaultBackupPassphrase`), or deprecate `setSecure` and route real secrets through `ctx.secrets`.
- **Files:** `lib/plugin/api/crypto-helpers.ts`, `storage-api.ts` (+ tests).
- **Depends on:** none.

### WAVE 3 — Inter-plugin communication hardening (user's priority)

#### W3.1 · High · Full-wire `onPreToolUse`/`onPostToolUse`

- **Evidence:** `dispatchPreToolUse`/`dispatchPostToolUse` (`lib/claude/adapter-hooks.ts` → `lib/plugin/messaging/hooks-system.ts`) have **0 production callers**; `extension-point-consumers.md` falsely claims "wired in M3". Actual tool execution is **sidecar-side**: AI-SDK channel `sidecar/dispatch/ai-sdk.mjs` (`reviewToolOutput`, `applyOutputReview` in `ai-sdk-tools.mjs`, gated by `sendOptions.toolResultReviewEnabled`); Anthropic channel `sidecar/dispatch/anthropic.mjs` (`canUseTool`, `agent-hooks.mjs`). The renderer bridges via `lib/claude/run-and-capture.ts` responders `onPermissionRequest` (pre) + `onToolResultReview` (post → `toolResultDecision` in `lib/claude/ipc.ts`) — currently supplied **only** by `lib/ai/agent/agent-executor.ts` (`toolResultReviewResponderFor`, sets `toolResultReviewEnabled=true`), not by the chat path. Chat's `hooks/chat/use-claude-chat.ts` only reacts to `permission_request` (~`case "permission_request"`, auto-approve) and does not dispatch plugin hooks.
- **Approach:** in `use-claude-chat.ts`, supply `onPermissionRequest` (call `dispatchPreToolUse`; honor deny/modify) and `onToolResultReview` (reuse `toolResultReviewResponderFor` from `agent-executor.ts`; set `toolResultReviewEnabled=true`), threaded through the capture runner. Wire the responders to `dispatchPreToolUse`/`dispatchPostToolUse`. Update `extension-point-consumers.md` to the real caller.
- **Files:** `hooks/chat/use-claude-chat.ts`, `lib/claude/run-and-capture.ts` (if threading needed), `lib/claude/adapter-hooks.ts`, `lib/plugin/contracts/extension-point-consumers.md` (+ tests).
- **Tests:** integration — a plugin `onPreToolUse` returning `deny` blocks a Bash/Write tool in a real chat run (keep adapter+store real, fake only `@/lib/claude/ipc`, per `chat-main-flow-integration-test` memory); `onPostToolUse` rewrite reaches the model-visible result.
- **Acceptance:** a "tool firewall" plugin actually blocks tools, incl. model-driven `mcp__` tools.
- **Depends on:** none. **Verify with `pnpm sidecar:test` + the chat integration test.**

#### W3.2 · High · Gate chat/prompt-interception hooks behind a permission

- **Evidence:** hook registration (`manager.ts`, `validateHookDeclarations`) runs for any plugin exporting `plugin.hooks`; there is no `chat:*`/`hooks:*` permission in the union. `onUserPromptSubmit` IS wired (`use-claude-chat.ts`) and can rewrite/block **every** prompt with zero declared permission.
- **Approach:** add a high-risk permission (e.g. `hooks:chat-intercept`) to the `PluginPermission` union + `validation.ts VALID_PERMISSIONS` + descriptions; enforce it in `validateHookDeclarations` for `onUserPromptSubmit`/`onPreToolUse`/`onPostToolUse`/`onMessageSend`-family; surface at install. **Adding a permission touches the parity places in §1.2.**
- **Files:** `types/plugin/plugin.ts`, `lib/plugin/core/validation.ts`, `lib/plugin/core/manager.ts`, `permission-guard.ts` descriptions, `cmd_lint.rs` parity lists, contract files (+ tests).
- **Depends on:** coordinate with W2.1 (permission unions).

#### W3.3 · Medium · Wire or truthfully downgrade dead pipeline hooks + reconcile the doc

- **Evidence:** `dispatchOnMessageSend`/`dispatchOnMessageReceive`/`dispatchOnAssistantMessage`/`dispatchOnAgentToolCall`/`dispatchOnMessageRender` have 0 production callers; `extension-point-consumers.md` lists phantom consumers (e.g. `components/chat/message.tsx` for `onMessageRender`). `onMessageRender`/`onAgentToolCall` are already in `DEPRECATED_HOOK_POINTS` (`plugin-points.ts`).
- **Approach:** wire `onMessageReceive`/`onAssistantMessage` at the streamed-message seam (`use-claude-chat.ts` `onClaudeMessage`) and `onMessageSend` at `send()`; keep the deprecated ones demoted; correct `extension-point-consumers.md` to grep-verified callers.
- **Files:** `hooks/chat/use-claude-chat.ts`, `lib/plugin/contracts/extension-point-consumers.md`, `plugin-capabilities.ts`/`plugin-points.ts` statuses (+ tests).
- **Depends on:** W3.1 (same file/area).

#### W3.4 · High · Dispatch-reachability gate (prevents the whole class)

- **Evidence:** `runtime-proof-audit.ts` stamps `proofStatus:"verified"` from non-empty prose fields; `contract-path-audit.ts` only checks `existsSync`; `audit:slots` covers only `CANONICAL_EXTENSION_POINTS` (UI mounts), not `CANONICAL_HOOK_POINTS`/`CANONICAL_RUNTIME_POINTS` (`plugin-points.ts`). A prototype "does a live caller exist?" already exists: `runtime-proof-audit.test.ts::findCallSite` (git-ls-files + regex) — but its blind spot is matching a call **one level up** (it green-lights `onPreToolUse` because `adapter-hooks.ts` calls the dispatcher, even though the wrapper is itself dead).
- **Approach:** generalize `findCallSite` to follow the chain **dispatcher → adapter wrapper → a production (non-`adapter-hooks`, non-test) caller**, and cover `CANONICAL_HOOK_POINTS` + `CANONICAL_RUNTIME_POINTS`. Ship as a Jest suite (runs under `pnpm test`) or append a `.mjs` script to `GATES` in `scripts/gates/check-all.mjs`.
- **Files:** `lib/plugin/contracts/runtime-proof-audit.test.ts` (or a new gate script + `check-all.mjs`).
- **Tests:** the gate fails on a deliberately-unwired hook; passes once W3.1/W3.3 land.
- **Acceptance:** no "supported" hook/runtime-point can be dead. **Run this after W3.1/W3.3 to confirm they're genuinely wired.**
- **Depends on:** best landed with/after W3.1, W3.3.

#### W3.5 · Medium-High · IPC target-side ACL + gate enumeration/force-wake

- **Evidence:** `lib/plugin/messaging/ipc.ts` — `call` checks only the _caller's_ `ipc:call`; `expose` has no allowlist of permitted callers; `getExposedMethods`/`describeExposedMethods` are ungated (enumerate any plugin's surface); `tryResumeSuspendedTarget` wakes an idle target on first call.
- **Approach:** add a per-method `allowedCallers`/capability token to `expose`, checked in `call`; gate the enumeration methods; remove or gate the force-wake.
- **Files:** `lib/plugin/messaging/ipc.ts` (+ tests).
- **Tests:** unauthorized caller rejected; enumeration gated; exposed method reachable only by allowed callers.
- **Depends on:** none.

#### W3.6 · Medium · Stop cross-plugin eavesdropping

- **Evidence:** `ipc.ts` `ipc.on` is ungated on a **flat** channel namespace, so any plugin receives another's `broadcast`; `message-bus.ts getHistory` returns full payloads (500-event retention) to any `events:subscribe` plugin.
- **Approach:** namespace channels by owner or require a subscribe-scope; strip payloads from cross-plugin `getHistory`; keep the `system:*` anti-spoof guard intact.
- **Files:** `lib/plugin/messaging/ipc.ts`, `message-bus.ts` (+ tests).
- **Depends on:** W3.5 (same file).

#### W3.7 · Medium · Leaks & delivery correctness

- **Evidence:** (a) `hooks-system.ts::executeHook` builds a `setTimeout` inside `Promise.race` but never `clearTimeout`s it; `dispatchStreamChunk` calls `executeHook` **per chunk** → thousands of pending timers + unhandled rejections. (b) `ipc.ts::unregisterPlugin` clears subscriptions/methods but **not** `breakers`/`breakerStates` (survive unload; reloaded plugin short-circuited; unbounded growth). (c) `message-bus.ts` delivers synchronously with no reentrancy guard and concatenates exact→pattern→wildcard **before** the priority sort. (d) `PluginEventAPI.off(subscriptionId)` is unusable (on/once return an unsubscribe fn, not an id) and `bus.off` is owner-unaware.
- **Approach:** (a) `clearTimeout` in `finally` (or `AbortController`); (b) evict `${pluginId}::*` breakers in `unregisterPlugin`; (c) dispatch handlers in microtasks + reentrancy depth guard + fix bucket/priority order; (d) drop `off(id)` from the façade (keep the closure + `offAll`), or scope removal to the owner.
- **Files:** `lib/plugin/messaging/hooks-system.ts`, `ipc.ts`, `message-bus.ts`, `types/plugin/plugin-messaging.ts` (+ tests).
- **Tests:** no dangling timers after stream end; breakers gone after unload; reentrant emit bounded; priority respected.
- **Depends on:** can split into 4 sub-PRs; independent of each other.

### WAVE 4 — Registry & contribution conflict correctness

#### W4.1 · High · Fix A2UI split-brain registration

- **Evidence:** `lib/plugin/bridge/a2ui-bridge.ts registerComponent` overwrites the render catalog (last-wins) but the underlying `registry.ts` is first-wins + fires a "rejected" conflict → catalog renders B, registry says A owns it, conflict panel says B ignored. Disabling B deletes A's registry row while A is still enabled.
- **Approach:** route `registerComponent` through the same first-wins overlay (don't overwrite the catalog on conflict); key the catalog per-owner; fix disable to remove only the owner's row. Align catalog, registry, and conflict panel to one truth.
- **Files:** `lib/plugin/bridge/a2ui-bridge.ts`, `lib/plugin/core/registry.ts` (+ tests).
- **Tests:** two plugins registering the same A2UI `type` — deterministic winner; disabling one doesn't remove the other's.
- **Depends on:** none.

#### W4.2 · High · Namespace the agent-facing overlay registries

- **Evidence:** `lib/plugin/registries/{skill-registry,mcp-server-preset-registry,native-anthropic-tool-registry,subagent-registry}` (+ external-agent-preset) use `createOverlayRegistry` with **no keyFn / default last-wins** keyed on bare `id` → plugin B hijacks plugin A's skill/tool/preset id, and unregistering B drops A's entry. Only the pet/quick-action registries opt into namespaced first-wins.
- **Approach:** give each `keyFn: (id,_e,o) => `${o?.pluginId}:${id}`` + `first-wins-cross-plugin` (mirror the pet registries); pass `pluginId` at the registration call sites in `context.ts`.
- **Files:** those registry files, `lib/plugin/core/context.ts` (+ tests).
- **Depends on:** none.

#### W4.3 · Medium · AI provider leak on disable

- **Evidence:** `lib/plugin/api/ai-provider-api.ts` module-level `customProviders` map (pluginId-prefixed) is cleared only via the disposer the plugin holds; `manager.ts` never clears runtime-registered providers on disable → a disabled plugin's `chat()` stays reachable.
- **Approach:** add `clearCustomAIProvidersByPlugin(pluginId)`; call it from `manager.ts unregisterPluginContributions` next to the declarative `ai-providers-bridge` teardown.
- **Files:** `lib/plugin/api/ai-provider-api.ts`, `lib/plugin/core/manager.ts` (+ tests).
- **Depends on:** none.

#### W4.4 · Low-Medium · Validating registry hard errors + trigger-bridge

- **Evidence:** `lib/plugin/registries/createValidatingOverlayRegistry.ts` always registers (validation advisory only). `lib/plugin/bridge/trigger-bridge.ts findAnyTriggerVersion` brute-forces `typeVersion` 1..50 (a trigger >50 is unfindable); two modules named `trigger-bridge` (`lib/plugin/bridge/` vs `lib/workflow/runtime/`) invite wrong-import bugs.
- **Approach:** add a `hardValidate` path that rejects structurally-broken contributions (keep soft `requires` warnings). Track the registered `typeVersion` set instead of scanning; rename one `trigger-bridge` module.
- **Files:** `createValidatingOverlayRegistry.ts`, `lib/plugin/bridge/trigger-bridge.ts` (+ tests).
- **Depends on:** none.

### WAVE 5 — Dormant VS Code contribution bridges

> The three bridges (`lib/plugin/bridge/{grammars,icons,snippets}-bridge.ts`) are complete + tested but **never invoked**. Wire each by mirroring the working `languages`/`themes` path. `snippets`' read side is already live at `lib/monaco/snippets.ts` (`listSnippetsForLanguage`) — only the register side is missing.

#### W5.1 · High (user-facing) · Wire grammars / iconThemes / snippets (one PR each or one wave PR)

- **Approach (repeat per contribution):**
  1. Add the manifest field to `PluginManifest` (`types/plugin/plugin.ts`, next to `vscodeLanguages`).
  2. Project `contributes.{grammars,iconThemes,snippets}` in `lib/plugin/vscode-shim/manifest-adapter.ts` (mirror `languages` ~113-123 / `themes` ~106-111); add capability inference for grammars/snippets (the capability block only maps themes/iconThemes→`"themes"` today).
  3. Parse the JSON in `lib/plugin/vscode-shim/vsix-installer.ts` (it parses only themes today; grammar/snippet/icon files sit unparsed in `files`).
  4. Register/unregister in `lib/plugin/core/manager.ts` mirroring `registerLanguagesForPlugin` (call `registerGrammar`/`registerIconTheme`/`registerSnippetFile`; add the unregister counterparts in `unregisterPluginContributions`).
  5. Consume: **snippets** — already wired (`lib/monaco/snippets.ts:listSnippetsForLanguage`); feeding the bridge completes it. **grammars** — plug `findGrammarByScopeName` into the shiki seam (`lib/shiki/highlight-cache.ts` / `components/ai-elements/code-block.tsx`) via `shiki.loadLanguage` (bundled-langs only today). **iconThemes** — plug `resolveFileIcon` into `components/agent/workspace/editor/project-file-tree.tsx` (static lucide icons today).
  6. Fix `hasThemeOnlyContributions` (`lib/plugin/core/vscode-loader.ts`) to count grammars/iconThemes so a grammar-only/icon-only extension without `vscodeMain` isn't rejected.
- **Files:** as above (+ manifest-adapter projection test + bridge-registration tests).
- **Tests:** manifest-adapter projects each field; manager registers/unregisters; consumer reads the registered contribution.
- **Acceptance (drive real app):** load a VS Code extension (or fixture) contributing a grammar + icon theme + snippets in `pnpm tauri dev`; syntax highlighting, file icons, and snippet completions appear.
- **Depends on:** none (3 independent sub-tracks).

### WAVE 6 — Lifecycle robustness & audit completeness

Independent small items (one PR each is fine):

- **W6.1** `manager.ts loadPlugin`: wrap `definition.activate` in `withTimeout` (+ breaker), mirroring the tool-invoke seam — a hanging activate wedges lazy activation for others.
- **W6.2** `manager.ts deactivatePluginRuntime`: wrap `definition.deactivate()` in the swallow-and-record pattern (`safeDispatchLifecycleHook`) so a throw can't abort teardown and leak permissions/IPC/WASM grants.
- **W6.3** `lib/plugin/core/transport.ts` (`invokePluginApi`): only retry idempotent APIs, or have the Rust `plugin_api_invoke` handler dedupe on `requestId` — current retry can double-execute side-effecting native calls.
- **W6.4** `manager.ts`: a per-plugin async lock covering all lifecycle transitions (extend the existing `enableInFlight` map) so enable can't interleave with disable/unload/uninstall.
- **W6.5** `manager.ts`: wire `stopIdleSweep` into a dispose path; fix the misleading signature-default comment near `verifyPluginSignature`.
- **W6.6** `lib/plugin/api/dexie-api.ts`: route `table()` through `resolveTableName` (fixes the double-prefix `<id>:<id>:foo` throw + the `table()` vs `rawDb().table()` asymmetry); correct the docstring's non-existent "declared set" guarantee.
- **W6.7** `lib/plugin/contracts/diagnostics-store.ts`: ring-buffer per plugin (mirror the 100-entry cap in `tools-bridge.ts`) — currently unbounded.
- **W6.8** `lib/plugin/contracts/sdk-helper-parity.test.ts`: add reverse checks — every `define-*` export binds to a named runtime consumer, and every overlay/module-bridge capability has an SDK helper (catches dead SDK surface + undocumented host surface).

Each: co-located test proving the fix (e.g. throwing `deactivate` still unregisters everything; activate timeout; reentrant enable/disable serialized).

---

## 4. Sequencing & dependencies

| Order | Items                                                 | Notes                                                                                                              |
| ----- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 1     | **W1.1, W1.3, W1.4**                                  | Finish Wave 1 (trust). Parallelizable (different files).                                                           |
| 2     | **W2.1 → W2.2, W2.3 → W2.4; W2.5**                    | W2.2/W2.3 depend on W2.1 (mappings); W2.4 with W2.3.                                                               |
| 3     | **W3.1 → W3.3; W3.4 after; W3.2; W3.5 → W3.6; W3.7**  | W3.4 (reachability gate) verifies W3.1/W3.3 — land last in the wave. W3.2 coordinates permission unions with W2.1. |
| 4     | **W4.1, W4.2, W4.3, W4.4**                            | All independent.                                                                                                   |
| 5     | **W5.1** (grammars / icons / snippets — 3 sub-tracks) | Independent.                                                                                                       |
| 6     | **W6.1–W6.8**                                         | All independent small PRs.                                                                                         |

**Cross-wave coupling to flag to agents:** any item adding/renaming a **permission** or **capability** (W1.4 grant UI, W3.2, W2.1) must update the parity places in §1.2 and run `pnpm audit:slots` + contract suites. Waves 2–6 are largely independent once Wave 1 lands; they can run in parallel across agents.

## 5. Whole-epic verification (final gate)

1. `pnpm test` (0 NEW failures vs the pre-existing baseline — see §1.2). 2. `pnpm test:coverage:changed -- --strict`. 3. `NODE_OPTIONS=--max-old-space-size=12288 pnpm typecheck` (no new errors). 4. `pnpm check:all` — must pass `audit:slots`, contract suites, and the **new dispatch-reachability gate (W3.4)**; `pnpm lint:i18n` parity. 5. `pnpm sidecar:test` (W3.1). 6. `cargo test --manifest-path src-tauri/Cargo.toml` (W1.1/W1.3/W1.4 — read the log). 7. **Drive the real app** (`pnpm tauri dev`): builtin loads; unsigned untrusted frontend blocked (Wave 1.2, done) then loads once trusted; signed marketplace plugin loads (W1.1); a plugin `onPreToolUse` denying Bash blocks it in chat (W3.1); a VS Code extension's grammar/icons/snippets render (W5.1).

## 6. Source evidence

This plan synthesizes a four-agent audit (runtime/lifecycle, inter-plugin comms, API/permissions, wiring/dormancy) and a three-agent fix-side wiring exploration (permission model, audit-gate + hook dispatch, VS Code bridges + signature flow). Findings and anchors are embedded per item above. The original approved plan lives at `~/.claude/plans/humble-swimming-orbit.md`; this document supersedes it as the executable spec.
