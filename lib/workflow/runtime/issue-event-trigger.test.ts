/** @jest-environment jsdom */

const dispatchTrigger = jest.fn().mockResolvedValue(undefined)
jest.mock("./trigger-bridge", () => ({
  dispatchTrigger: (args: unknown) => dispatchTrigger(args),
}))
const getIssue = jest.fn(async (_id: string): Promise<unknown> => ({
  id: "i1",
  identifier: "MERC-1",
  title: "One",
  status: "todo",
  projectId: "w1",
  issueProjectId: "p1",
}))
jest.mock("@/lib/db/issues", () => ({ getIssue: (id: string) => getIssue(id) }))

import {
  _injectIssueEventForTest,
  disposeIssueEventTrigger,
  initIssueEventTrigger,
} from "./issue-event-trigger"
import { _seedTriggerSubscriptionsForTest } from "./trigger-subscriptions"
import type { IssueEvent } from "@/types/issues"
import type { WorkflowRow } from "@/types/workflow/visual"

function workflow(id: string, params: Record<string, unknown> = {}): WorkflowRow {
  return {
    id,
    nodes: [{ id: `${id}-n1`, type: "trigger.issue.event", data: { params } }],
  } as unknown as WorkflowRow
}

function event(kind: IssueEvent["kind"], over: Partial<IssueEvent> = {}): IssueEvent {
  return {
    id: "e1",
    issueId: "i1",
    kind,
    ts: 1000,
    payload: { kind } as IssueEvent["payload"],
    ...over,
  }
}

let clock = 0

beforeEach(() => {
  dispatchTrigger.mockClear()
  getIssue.mockClear()
  clock = 100_000
  initIssueEventTrigger({ now: () => clock })
})

afterEach(() => disposeIssueEventTrigger())

describe("trigger.issue.event runner", () => {
  it("fires a matching workflow with the issue's identity and the trail entry", async () => {
    _seedTriggerSubscriptionsForTest([workflow("wf1", { kinds: ["commented"] })])
    await _injectIssueEventForTest(
      event("commented", {
        payload: { kind: "commented", commentId: "c", body: "hi", by: { kind: "human" } },
      })
    )
    expect(dispatchTrigger).toHaveBeenCalledTimes(1)
    expect(dispatchTrigger).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowId: "wf1",
        kind: "trigger.issue.event",
        triggerId: "wf1-n1",
        payload: expect.objectContaining({
          kind: "commented",
          issueId: "i1",
          identifier: "MERC-1",
          issueProjectId: "p1",
          event: expect.objectContaining({ body: "hi" }),
        }),
      })
    )
  })

  it("does not read the issue when no workflow subscribes the kind", async () => {
    _seedTriggerSubscriptionsForTest([workflow("wf1", { kinds: ["created"] })])
    await _injectIssueEventForTest(event("commented"))
    expect(getIssue).not.toHaveBeenCalled()
    expect(dispatchTrigger).not.toHaveBeenCalled()
  })

  it("honours the container filter and matches every kind without one", async () => {
    _seedTriggerSubscriptionsForTest([
      workflow("other", { issueProjectId: "p2" }),
      workflow("mine", { issueProjectId: "p1" }),
      workflow("any"),
    ])
    await _injectIssueEventForTest(event("status_changed"))
    const fired = dispatchTrigger.mock.calls.map((c) => (c[0] as { workflowId: string }).workflowId)
    expect(fired.sort()).toEqual(["any", "mine"])
  })

  it("applies the per-workflow cooldown", async () => {
    _seedTriggerSubscriptionsForTest([workflow("wf1", { cooldownMs: 5_000 })])
    await _injectIssueEventForTest(event("created"))
    clock += 1_000
    await _injectIssueEventForTest(event("created", { id: "e2" }))
    expect(dispatchTrigger).toHaveBeenCalledTimes(1)
    clock += 5_000
    await _injectIssueEventForTest(event("created", { id: "e3" }))
    expect(dispatchTrigger).toHaveBeenCalledTimes(2)
  })

  it("stays silent after dispose", async () => {
    _seedTriggerSubscriptionsForTest([workflow("wf1")])
    disposeIssueEventTrigger()
    await _injectIssueEventForTest(event("created"))
    expect(dispatchTrigger).not.toHaveBeenCalled()
  })
})
