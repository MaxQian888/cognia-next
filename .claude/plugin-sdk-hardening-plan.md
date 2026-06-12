# Plugin SDK Hardening Plan (feat/plugin-sdk-hardening)

Origin: 5-stream completeness audit + reference benchmarking (VS Code / Raycast / Zed / Figma / Chrome).
User chose ALL FOUR buckets (A security, B honest API, C governance, D reference-enhancements) +
"implement real backends" for dead APIs. i18n leak (E) fixed unconditionally.

Verdict from audit: imperative runtime + UI + permission parity are MATURE. Real gaps below.
Rules: every new file co-located test, ≥90% cov, i18n parity (en+zh-CN), NO simplifications, TDD.
Each slice → its own commit. Verify before "done": jest / cargo / tsc / eslint / lint:i18n.

## Status legend: [ ] todo · [~] in progress · [x] done+committed

### PROGRESS (feat/plugin-sdk-hardening)

- [x] E — i18n leak fixed — commit a34da38f
- [x] C-1 — filesystem-backed contract proof-path gate (self-ratcheting allowlist, 43 known) — 883e095f
- [x] A-S2 — marketplace archive integrity (checksum + ed25519 + require-sig policy) — 61652ce8 ← the real P0
- [x] B-1 — WASM ai.generate_text honest-fail (was returning plausible FAKE text) — 228a90eb
- [x] B-3 — real network download/upload streamed to plugin sandbox (egress-allowlist + path-scope) — 404d9a2d
- [x] B-2 — ctx.shell real backend: declarative command allowlist (deny-by-default) + open/showInFolder
      via opener; env-cleared exec + wait_timeout; shell:execute consent-gated. NEEDS tauri-smoke
      (live exec, opener ACL for reveal_item_in_dir). — committing
- REASSESSED: **A-S1 is fail-CLOSED**, not wide-open. The require-hook gates fs/child_process/net;
  `permission:request` has NO renderer handler → sidecar gets -32601 → returns "deny". So sensitive
  modules are DENIED today (secure but non-functional). Real work = make the gate functional + make
  Rust the authoritative answerer (medium, needs sidecar smoke). NOT an active breach. Re-ranked P0→P2.
- REASSESSED: **A-S3** — the `tar` crate's `Archive::unpack` already guards `..`/absolute traversal,
  and the backup is host-created. Low value; defer.
- Concurrent session active in tree (agent-team/dispatch TS files) — pathspec-only commits, src-tauri safe.

---

### E — i18n leak (P1, hard rule-4 violation) — QUICK

- [ ] `components/plugins/detail/plugin-config-form.tsx:269-299` — 8 hardcoded English validation
      strings escape lint:i18n (returned from non-JSX `validateField`). Move to
      `plugins.configForm.validation.*` keys (en.json + zh-CN.json), thread `t` into validators.
      Verify: jest config-form + lint:i18n.

### A — Security holes

- [ ] **A-S1 (P0)** VS Code capability enforcement. `vscode/commands.rs:280 plugin_invoke_vscode_rpc`
      forwards arbitrary method+payload to full-Node sidecar with NO gate. Wire the dead
      `capabilities/{file,network,process}.rs` (`check_path/check_host/check_spawn`) + `CapabilityStore`:
      add `CapabilityStore` to `VscodeExtensionState` (vscode/mod.rs:44), seed from manifest capabilities
      at install/load, and gate fs/net/spawn RPC methods in the dispatch. Reject denials.
      Tests: cargo capability gate unit + denial path.
- [ ] **A-S2 (P1)** Marketplace signature verify. `marketplace.rs:200 plugin_download_version` installs
      with no verify. Add signature_url + expected_public_key (manifest-pinned or param) → call
      `signature::verify_detached` before `install_archive_into_plugin_dir` (mirror wasm/installer.rs:183).
      Decide mandatory-vs-opt-in (default: verify when key present, warn-or-block when absent per setting).
      Tests: cargo verify-pass / tamper-fail.
- [ ] **A-S3 (P2)** backup restore traversal guard. `backup.rs:96 archive.unpack` → use the
      component-stripping extractor like marketplace.rs:112. Test: malicious entry rejected.

### B — Honest API surface (implement real backends per user choice)

- [ ] **B-1 (P1)** WASM `ai.generate_text` fake text (`wasm/wit/since_v0_1.rs:252`) → wire real provider
      via host IPC-to-TS, OR honest-fail if infeasible this slice. WASM clipboard read/write stubs
      (`:233-245`) → real via tauri-plugin-clipboard-manager (reuse api_bridge.rs:624). notification/
      workflow.emit_event log-only → wire to runtime. Tests: cargo.
- [ ] **B-2 (P1)** `ctx.shell` real backend. Add `handle_shell` in api_bridge.rs (execute/open/
      showInFolder) gated by `shell:execute` + consent; spawn via process_ops with env_clear+timeout.
      TS `context.ts:1540` shell wrappers already exist. Tests: cargo + context.test.
- [ ] **B-3 (P1)** `network.download`/`upload` host wiring (`api_bridge.rs:761`) → stream to plugin
      sandbox data dir reusing fs handler scope. TS context.ts:1208/1247. Tests: cargo + context.test.

### C — Governance integrity

- [ ] **C-1 (P1)** Real contract path guard. `plugin-capabilities.ts:952 auditPluginCapabilityContracts`
      only checks `!entry.trim()`. Add fs.existsSync(repoRoot+stripAnchor(path)) per path field →
      push `missing_proof`. New test asserts phantom.length===0 (will RED first → drives C-2).
- [ ] **C-2 (P1)** Prune/fix 43 phantom paths: `plugin-sdk/python/*` (absent), 16 typescriptSdk,
      12 builtinContributionPaths (`plugins/*-tools`,`*-agent`), `docs/features/plugin-development.md`.
      Rewrite to real paths OR create the missing artifacts (Python SDK ties into D-4).
- [ ] **C-3 (P2)** union drift: add contracts for `automation`+`companion` capabilities (or remove from
      union). `getContributionsForCapability` add cli-tools/tray/chat-middleware cases. Tests + parity.

### D — Reference-inspired enhancements (net-new)

- [ ] **D-1** Declarative `networkAccess.allowedDomains` egress allowlist (Figma). Manifest field →
      static per-plugin domain allowlist enforced in network guard + Rust api_bridge network arm + shown
      in consent prompt. Deny-by-default; `["*"]`+reasoning.
- [ ] **D-2** required vs optional permission split + gesture-bound JIT consent (Chrome). Manifest
      `optionalPermissions`; request at first feature-use within a user gesture; ledger introspection +
      revoke UI (already partly exists in permission-review).
- [ ] **D-3** Typed/versioned WASM boundary (Zed WIT-style) — replace single stringly
      `callWasmExport("tool-execute",{kind})` with per-capability typed methods + manifest schema_version.
- [ ] **D-4** Plugin-author DX: real Python SDK tree, scaffold (`cognia plugin create` template +
      hot-reload), manifest→codegen typed config accessors (Raycast), re-export the extra define\* helpers
      from the SDK barrel. (Largest; may split.)

---

## Execution order (dependency + risk)

1. E (warmup, validates harness) 2. C-1 (exposes phantom list, TS-only) 3. A-S1→S2→S3 (security, Rust)
2. B-2→B-3→B-1 (real backends) 5. C-2→C-3 (cleanup using C-1 output) 6. D-1→D-2→D-3→D-4 (enhancements)

Commit per slice. Tauri-smoke items flagged where Rust runtime needed (CI/desktop).
