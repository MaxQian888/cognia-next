/**
 * Tests for lib/notifications/emit-center.ts — the bridge that maps a derived
 * run fact onto the existing ADR-0042 `notify()` center funnel. Covers the
 * run-kind → source mapping, the deep-link/dedupe/group fields, and the
 * directed-vs-ambient split (approval facts badge, progress pings don't).
 */

import { runKindToSource, emitCenterFromDerivedFact } from "./emit-center"
import type { DerivedNotificationFact } from "./delivery/facts"
import type { ExecutionRun } from "@/types/execution/run"
import type { NotificationInput } from "@/types/notifications"

// The center funnel is mocked — emit-center is the translation, not the sink.
const notifyMock = jest.fn(async (_input: NotificationInput) => "rec-1")
jest.mock("./runtime", () => ({
  notify: (input: NotificationInput) => notifyMock(input),
}))

function derived(over: Partial<DerivedNotificationFact["fact"]> = {}): DerivedNotificationFact {
  return {
    fact: {
      factKey: "run:evt:1",
      category: "run.terminal",
      purpose: "terminal-state",
      level: "info",
      source: "execution",
      ...over,
    },
    title: "Deploy failed",
    body: "boom",
    maxClassification: "internal",
  }
}

function run(over: Partial<ExecutionRun> = {}): ExecutionRun {
  return { id: "run-1", kind: "workflow", projectId: "p1", ...over } as ExecutionRun
}

beforeEach(() => notifyMock.mockClear())

describe("runKindToSource", () => {
  it("maps execution kinds onto notification sources", () => {
    expect(runKindToSource("workflow")).toBe("workflow")
    expect(runKindToSource("scheduled")).toBe("scheduler")
    expect(runKindToSource("agent-turn")).toBe("agent-team")
    expect(runKindToSource("team")).toBe("agent-team")
    expect(runKindToSource("bot")).toBe("agent-team")
    expect(runKindToSource("delegation")).toBe("agent-team")
    expect(runKindToSource(undefined)).toBe("system")
  })
})

describe("emitCenterFromDerivedFact", () => {
  it("emits a center record keyed on the fact's factKey", async () => {
    await emitCenterFromDerivedFact({ derived: derived(), run: run() })
    expect(notifyMock).toHaveBeenCalledTimes(1)
    const input = notifyMock.mock.calls[0][0]
    expect(input.source).toBe("workflow")
    expect(input.level).toBe("info")
    expect(input.title).toBe("Deploy failed")
    expect(input.body).toBe("boom")
    expect(input.dedupeKey).toBe("run:evt:1")
    expect(input.logicalKey).toBe("run:evt:1")
    expect(input.groupKey).toBe("run-1")
    expect(input.href).toBe("/agent-runs?run=run-1")
    expect(input.sourceRef).toEqual({ kind: "run", id: "run-1" })
    expect(input.projectId).toBe("p1")
    expect(input.category).toBe("run.terminal")
  })

  it("marks an approval-request fact directed (red badge)", async () => {
    await emitCenterFromDerivedFact({
      derived: derived({ purpose: "approval-request" }),
      run: run(),
    })
    expect(notifyMock.mock.calls[0][0].directed).toBe(true)
  })

  it("leaves a plain notify fact ambient (dot badge)", async () => {
    await emitCenterFromDerivedFact({ derived: derived({ purpose: "terminal-state" }), run: run() })
    expect(notifyMock.mock.calls[0][0].directed).toBe(false)
  })

  it("omits projectId when the run has none", async () => {
    await emitCenterFromDerivedFact({ derived: derived(), run: run({ projectId: undefined }) })
    expect(notifyMock.mock.calls[0][0].projectId).toBeUndefined()
  })

  it("omits body when the fact has none", async () => {
    await emitCenterFromDerivedFact({ derived: { ...derived(), body: "" }, run: run() })
    expect(notifyMock.mock.calls[0][0].body).toBeUndefined()
  })
})
