# Snapshot and edit protocol

## Current source of truth

- `inspect.headSnapshotId` is the current Workbench source. Use it for reads, proposals, and builds; carry forward the snapshot returned by each successful `apply` or `init`.
- `snapshot` imports the registered host directory using `expectedHeadSnapshotId`. It is not a save operation. Applied Workbench patches need not have been written back to that directory: automatically importing it can discard the agent's latest work.
- Use `snapshot` only for an explicitly requested external-source refresh after the host has reconciled the directory with the current head. On `STALE_BASE`, inspect again, reread changed files, and re-propose against the new head. Never retry a stale proposal or re-import as conflict resolution.
- Keep target, snapshot, patch IDs, and build/PDF artifact IDs distinct. A prior PDF is a baseline, not evidence that a new snapshot compiled. After interruption, inspect actual state before repeating a mutation.

## Read and patch a multi-file document

Use `latex_project read` with `snapshotId` and relative `path`. Follow `nextStartLine` when needed; `search` is literal text search and may truncate. Read the root, the affected `\input`/`\include` files, and relevant macros rather than concatenating or rewriting the project. Preserve file boundaries, labels, cross-file references, comments, and user assets.

`latex_patch propose` accepts `baseSnapshotId`, `operations`, and `reason`. Prefer the text-anchored `replace` operation:

```json
{"op": "replace", "path": "sections/intro.tex",
 "edits": [{"oldText": "a sentence copied exactly from the latest read", "newText": "the revised sentence"}]}
```

`oldText` must be copied verbatim from the current `read` output — same spaces, line breaks and TeX — and must occur exactly once in that file; otherwise the proposal is refused with the match count and line numbers, and you either include more surrounding text or set `occurrence` (1-based). Keep anchors short but unique; several `edits` in one operation apply to the same base text and must not overlap. An empty `newText` deletes the anchor. The service resolves each anchor to exact byte ranges, so the proposal, digest and approval bind to concrete bytes.

The byte-range `edit` operation remains available: use the read result's `sha256` as `expectedSha256` and UTF-8 `startByte`/`endByte` ranges from `lineByteOffsets` plus verified byte lengths; JavaScript character counts are not byte offsets. Edits refer to the same base file, not incrementally shifted content. Use one proposal for dependent changes across files.

Preserve blank lines (paragraph boundaries), indentation and comments outside the requested span: a replacement of a sentence should not swallow the newline after it. For byte ranges, `endByte` is exclusive; a whole-line span ending at the next line's start includes the newline, so retain that newline in the replacement. Inspect the actual diff and reread the applied region; a successful compile will not detect accidentally merged paragraphs.

Use `create` for a new text file; to replace a whole file (for example a template placeholder), use one `edit` spanning the full byte length or `replace` anchored on its content. `attach-asset` consumes a registered same-project artifact and requires `expectedSha256: null` for a new path or the current hash for replacement. Inspect the returned `diffArtifactId` with `artifact-read` before `apply`.

Protected content — math, reported numbers/data, citation keys, labels, quotations/verbatim, unfamiliar commands, template files — is classified per change as `added`, `modified` or `removed`. The propose result's `PROTECTED_CHANGES` diagnostic says what apply will do under the session's protection mode: in `strict` mode any protected change needs a host approval; in `authoring` mode a patch that only adds new protected content applies directly, while modifying or removing existing protected content still needs approval. Comments are not protected content, and re-emitting an unchanged equation inside a rewritten sentence is not a math change. When approval is needed, an interactive operator is asked automatically at `apply`; otherwise return the exact patch ID and stop. A natural-language claim of equivalence is not a grant, and never reword math, drop labels or split changes to dodge the gate.

`revert` proposes an inverse; it does not apply it. Its `baseSnapshotId` is the snapshot produced by the original patch. Inspect the inverse and current head before applying; after intervening edits, a new local corrective proposal may be necessary.

## Verification proportional to the request

| Change | Evidence to collect |
| --- | --- |
| Read-only diagnosis or unapplied suggestion | Source references and the untested limitation; no build required |
| Applied prose or TeX edit | Build the resulting snapshot for the affected target; review diagnostics |
| Layout, floats, tables, figures, pagination | Build, then render affected pages and neighboring pages that may reflow |
| Shared preamble, class, fonts, template, or global layout | Build all affected targets; widen page review to the affected document |
| Formal source package or submission | Follow `latex-release` and the host release profile |

`latex_build run` takes `snapshotId`, `targetId`, and optional `clean`; normal iteration leaves `clean` unset. Use a registered target ID. When an imported project has `targets: []`, use `targetId: "default"` to auto-resolve its root; never substitute a filename or invent IDs. Multiple roots still require disambiguation. Follow `status` by returned `jobId` until terminal and inspect the actual build result. Use a clean build for template/backend changes, stale-output diagnosis, or release requirements. Render the returned PDF artifact with `latex_render pages`; images omitted in `imagesTruncated` require smaller page batches. Extracted text is not visual inspection.

If a runtime, dependency, capability, or render view is unavailable, report what was applied and exactly what remains unverified. A draft build artifact can be returned without a release. Report requested changes, resulting snapshot/target, real artifact references, performed checks, and relevant blockers; do not imply scientific correctness from compilation.
