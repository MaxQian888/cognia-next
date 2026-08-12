/** @jest-environment jsdom */

import "fake-indexeddb/auto"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDecisionContext } from "@/lib/db/governance-ledger"
import { recordConnectorRouteGovernance } from "./connector"

const fixture = createDbTestFixture()
beforeAll(fixture.initialize)
beforeEach(fixture.restore)
afterAll(fixture.dispose)

it("projects connector routing from policy evidence without message content", async () => {
  const id = await recordConnectorRouteGovernance({
    adapterId: "lark-1",
    messageId: "message-1",
    conversationKey: "private-conversation-key",
    mode: "auto",
    evaluation: { matched: true, blocked: false },
    route: "ai-run",
    decidedAt: 100,
  })

  const context = await getDecisionContext(id)
  expect(context?.decision).toMatchObject({
    kind: "connector-route",
    resolution: { outcome: "ai-run" },
  })
  expect(context?.evidence).toHaveLength(1)
  expect(JSON.stringify(context)).not.toContain("private-conversation-key")
})
