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
// Side-effect import: registers the built-in + desktop + terminal executors.
import "./built-ins"
import { listRegisteredKinds } from "./registry"
import { WORKFLOW_NODE_KINDS, type WorkflowNodeKind } from "@/types/workflow/visual"

// Kinds that legitimately have NO host executor:
//  • externally-fired triggers — started by the Rust router / TS bridges,
//    never executed as a graph step;
//  • annotations — pure canvas decoration;
//  • github actions — contributed by the github-delivery plugin, not the host.
const KINDS_WITHOUT_HOST_EXECUTOR: ReadonlySet<WorkflowNodeKind> = new Set<WorkflowNodeKind>([
  "trigger.cron",
  "trigger.connector.inbound",
  "trigger.chat.message",
  "trigger.webhook",
  "trigger.github.webhook",
  "annotation.note",
  "annotation.group",
  "action.github.openPr",
  "action.github.closePr",
  "action.github.mergePr",
  "action.github.reviewPr",
  "action.github.reviewPrInline",
  "action.github.commentPr",
  "action.github.commentIssue",
  "action.github.labelIssue",
  "action.github.closeIssue",
  "action.github.createRelease",
  "action.github.generateChangelog",
  "action.github.pushTag",
  "action.github.runIssueLoop",
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
    // kind in the allowlist. The github-delivery plugin is not loaded here, so
    // its action kinds are correctly absent.
    const registered = new Set(listRegisteredKinds())
    const wronglyExcluded = [...KINDS_WITHOUT_HOST_EXECUTOR].filter((k) => registered.has(k))
    expect(wronglyExcluded).toEqual([])
  })
})
