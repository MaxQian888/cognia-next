/**
 * @jest-environment jsdom
 */
/**
 * Coverage parity: every *executable* node kind must have a registered host
 * executor. This closes the second unenforced drift (the first — the kinds
 * array — is pinned in `params-schemas.test.ts`): a kind can be added to the
 * union and its compile-enforced schema/catalog entries, yet have no executor
 * wired, which would only surface at run time as "no executor registered".
 */
import "fake-indexeddb/auto"
// Side-effect import: registers the built-in + desktop + terminal + git + ocr
// executors.
import "./built-ins"
// Side-effect import: registers the six ultracode `pattern.*` host executors.
// They live under `lib/ai/agent/team/patterns` (imported lazily by
// `runTeamLifecycle` before an ultracode run) but register under
// `BUILTIN_PLUGIN_ID` — i.e. they ARE host executors, just authored in a
// sibling module. Import them here so the parity check sees the full host set.
import "@/lib/ai/agent/team/patterns"
import { listRegisteredKinds } from "./registry"
import { WORKFLOW_NODE_KINDS, type WorkflowNodeKind } from "@/types/workflow/visual"

// Kinds that legitimately have NO host executor: annotations are pure canvas
// decoration. Marketplace action kinds are dynamic and therefore do not
// appear in the host's static WORKFLOW_NODE_KINDS list.
const KINDS_WITHOUT_HOST_EXECUTOR: ReadonlySet<WorkflowNodeKind> = new Set<WorkflowNodeKind>([
  "annotation.note",
  "annotation.group",
])

describe("executor coverage parity", () => {
  it("registers a host executor for every executable kind", () => {
    const registered = new Set(listRegisteredKinds())
    const missing = WORKFLOW_NODE_KINDS.filter(
      (k) => !KINDS_WITHOUT_HOST_EXECUTOR.has(k) && !registered.has(k)
    )
    expect(missing).toEqual([])
  })

  it("keeps the allowlist honest — no excluded kind actually has a host executor", () => {
    // Guards against weakening the test above by parking a still-executable
    // kind in the allowlist.
    const registered = new Set(listRegisteredKinds())
    const wronglyExcluded = [...KINDS_WITHOUT_HOST_EXECUTOR].filter((k) => registered.has(k))
    expect(wronglyExcluded).toEqual([])
  })
})
