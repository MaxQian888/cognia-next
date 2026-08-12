/** @jest-environment jsdom */

import "fake-indexeddb/auto"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDecisionContext } from "@/lib/db/governance-ledger"
import { recordToolAuthorizationGovernance } from "./tool-authorization"

const fixture = createDbTestFixture()
beforeAll(fixture.initialize)
beforeEach(fixture.restore)
afterAll(fixture.dispose)

it.each([
  [true, "executed"],
  [false, "failed"],
] as const)(
  "records a content-free tool authorization (dispatched=%s)",
  async (dispatched, state) => {
    const decisionId = await recordToolAuthorizationGovernance({
      sessionId: "session-1",
      requestId: "request-1",
      outcome: "allow",
      decidedAt: 100,
      dispatched,
      hasUpdatedInput: true,
    })

    const context = await getDecisionContext(decisionId)
    expect(context?.decision.lifecycle.state).toBe(state)
    expect(context?.decision.correlation).toMatchObject({
      sessionId: "session-1",
      requestId: "request-1",
    })
    expect(JSON.stringify(context)).not.toContain("private tool arguments")
  }
)
