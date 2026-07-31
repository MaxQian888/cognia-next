---
name: cognia-user-path-mindmap
description: >-
  Maintain Cognia's source-controlled user-path and critical-user-journey mindmap plus its generated and shared
  artifacts. Use to add, remove, rename, classify, or verify a product path/module/function; edit a journey `tree.json`;
  maintain P0/P1/P2 or repository-defined priorities and owning `spec` mappings; describe loops, retries, queues, or turn
  semantics; regenerate diagram/OpenAPI artifacts; audit E2E coverage against journeys; synchronize an approved Lark
  whiteboard; or update companion overview, E2E-governance, gap-ledger, and tracking documents. Trigger on phrases such as
  “操作路径 / 用户路径 / CUJ / 脑图 / tree.json / 加节点或模块 / 回环 / 同步画板 / 治理文档” and equivalent English.
  Apply to a repository-owned source pipeline; never reconstruct missing source from generated or remote artifacts.
---

# Cognia User-path Mindmap

Maintain one source-controlled pipeline:

```text
tree.json ── generator ──> diagram.json ── whiteboard-cli ──> openapi.json ──> shared whiteboard
    └── priority/spec ──> repository journey validator ──> governance checks and reports
```

Treat `tree.json` as the only hand-edited path source. Treat generated JSON, previews, whiteboards, reports, and coverage exports as derived artifacts. Never repair or reverse-engineer source from a derived artifact.

Resolve:

- `SKILL_DIR`: directory containing this `SKILL.md`.
- `REPO_ROOT`: `git rev-parse --show-toplevel`.
- `MINDMAP_DIR`: user-provided path, `COGNIA_MINDMAP_DIR`, or `<repo-root>/docs/cognia-user-path-mindmap`.

## Start with preflight

1. Resolve the active repository; do not assume username, checkout, worktree, or branch.
2. Read applicable `AGENTS.md`, the mindmap README if present, generator, and repository-owned validator.
3. Check `git status --short`; preserve unrelated and untracked work.
4. Require `tree.json`, a supported generator (`gen.cjs`, `gen.mjs`, or repository-declared equivalent), and a repository-owned validator.
5. Confirm source files with `git ls-files`; generated artifacts may be ignored, but source must not be silently reconstructed.
6. If source or validator is absent, stop and ask which branch/worktree/path is authoritative. Do not copy from history, switch branches, or create a replacement data model without explicit authorization.

Read [`references/tree-schema.md`](references/tree-schema.md) before changing topology, roles, loops, retry/turn semantics, priorities, or owning tests.

## Classify the requested change

| Change | Edit source | Rebuild local artifacts | Push whiteboard | Update documents |
|---|---:|---:|---:|---:|
| priority/spec metadata only | yes | optional if visuals ignore metadata | no visual change | only if governance facts changed |
| label, chain, flow, role, loop, module | yes | yes | only after explicit approval | when explanation or ledger becomes stale |
| validator/governance contract | repository script + tests | usually no | no | yes |
| whiteboard-only sync | no | rebuild first | only after explicit approval | no unless requested |
| companion document edit | only if journey truth changes | as needed | as needed | yes |

Keep changes surgical. Editing one path does not authorize taxonomy cleanup, E2E implementation, remote document rewrites, commits, or branch changes.

## Edit the source

1. Locate the owning module and function/journey.
2. Verify user-visible behavior against current code and current E2E. Recheck intervals, timeouts, state transitions, retry boundaries, and native/platform differences at implementation sites.
3. Patch the smallest JSON region. Preserve stable IDs unless identity changes. Do not reformat the entire file.
4. Use `chain` for one linear route and `flow` for branching/merging behavior. Keep anchors and loop targets within one journey unless the repository schema explicitly supports cross-journey edges.
5. Use repository-defined priority and spec fields. Resolve spec paths through the current validator rather than assuming one test root.
6. If behavior changed without an owning test, report the gap. Add tests only when the user also requested implementation or coverage.

Never freeze volatile module/function/priority/spec counts in prose. Derive them each run.

## Validate with repository-owned rules

Prefer the repository entry point. The bundled script discovers common generator/validator names without duplicating their contract:

```bash
rtk bash "$SKILL_DIR/scripts/sync-mindmap.sh" lint "$MINDMAP_DIR"
```

Validation must cover, when supported by the repository:

- valid tree structure and globally unique stable IDs;
- legal role and priority values plus any P0 budget;
- valid loop/anchor references;
- `spec` type, source-control status, and existence across supported roots;
- an owning test for every repository-required critical journey;
- optional P0/P1 execution status when Playwright JSON is supplied.

For topology or label changes:

```bash
rtk bash "$SKILL_DIR/scripts/sync-mindmap.sh" build "$MINDMAP_DIR"
```

Report generator module/function/connector counts and validator summary. Compare with the intended delta, never a hard-coded historical total.

## Sync a shared Lark whiteboard

Before any Lark whiteboard action, invoke the available `lark-whiteboard` skill and follow its current auth/update instructions.

Use this gated sequence:

1. Run repository validation and local build.
2. Show source diff, intended topology delta, generated counts, and target document/whiteboard identity.
3. Obtain explicit confirmation for destructive whole-board replacement.
4. Resolve the token from explicit argument or the authoritative companion document using `scripts/whiteboard-token.sh`; never trust an old copied token without read-back.
5. Run:

   ```bash
   rtk bash "$SKILL_DIR/scripts/sync-mindmap.sh" push "$MINDMAP_DIR" [whiteboard-token]
   ```

6. Require a successful response and node/connector summary, then re-query or visually inspect after preview caching clears.

Write the graph once with `--overwrite`. Appending connectors separately can create dangling references. A source-edit request is not approval to replace a shared board.

## Update companion documents

Read [`references/companion-docs.md`](references/companion-docs.md) to discover document ownership and affected sections. Before editing, invoke `lark-doc`; use `lark-shared` for authentication or permission failures. Read [`references/feishu-doc-edits.md`](references/feishu-doc-edits.md) before writing.

Prefer `str_replace`, `block_replace`, or `block_insert_after`. Fetch the edited section afterward and verify rendered structure. Full-document overwrite is destructive and needs separate explicit confirmation.

Update source-controlled ledgers or design docs only when their facts changed. Treat dated snapshots as history: append a dated reconciliation or regenerate through the owning workflow instead of rewriting past evidence.

## Completion gate

Provide evidence for every performed action:

- repository validator passed;
- generator and OpenAPI conversion passed when topology changed;
- source diff matches requested journey delta;
- generated artifact was not hand-edited or accidentally staged;
- remote board update returned success, if approved;
- remote document sections were fetched back and checked, if edited;
- `git status --short` contains only intended paths from this task.

Report separately: source changes, validation, generated local artifacts, remote writes, coverage/governance gaps, and blocked platform/environment checks.

## Resources

- [`references/tree-schema.md`](references/tree-schema.md): generic schema, roles, chain/flow, loops, retry/turn semantics, and governance fields.
- [`references/companion-docs.md`](references/companion-docs.md): document discovery, ownership, and update triggers.
- [`references/feishu-doc-edits.md`](references/feishu-doc-edits.md): safe Lark Docx block editing and verification.
- `scripts/sync-mindmap.sh`: discover repository validator/generator, validate, build, convert, and optionally replace a confirmed board.
- `scripts/whiteboard-token.sh`: read-only discovery of a board token from an explicitly configured companion document section.
