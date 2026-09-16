/** @jest-environment jsdom */
import "fake-indexeddb/auto"

jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({ name: "host-test-main" }),
}))

import * as host from "./host"
import { accountDatabaseAppliers } from "./db/outbox-appliers"

describe("router-fusion host surface", () => {
  it("exposes the chat routing and run lifecycle the send path loads", () => {
    for (const name of [
      "selectChatDeployment",
      "sealChatRoute",
      "createChatRouteHost",
      "rememberChatRoute",
      "beginChatRun",
      "answerCallReserve",
      "recordCallAttemptResult",
      "observeEnvelopeMessage",
      "finalizeChatRun",
      "cancelChatRun",
      "abortChatRunBeforeDispatch",
      "recoverStaleFusionRuns",
      "tenantLimitFor",
      // B2: the gateway's passthrough lane and the outbox drain the lanes
      // without a run driver use.
      "reservePassthroughCall",
      "settlePassthroughCall",
      "drainAccountOutbox",
      "runApiDeps",
      // B3: the orchestrated modes, their recovery, and the Run API's reads.
      "executeFusionRun",
      "driveRun",
      "orchestratedRunResumer",
      "routeRunRequest",
      "getSessionFromApi",
      "getArtifactFromApi",
      "readArtifactFromApi",
      "createHostToolRuntime",
      "createRunEvidenceResolver",
      "createChatRunFromApi",
      "chatResultFromApi",
      "selectChatFusionRun",
      "startChatFusionTurn",
      "cancelChatFusionTurn",
      "chatAutoConsidersFusion",
    ] as const) {
      expect(typeof host[name]).toBe("function")
    }
  })

  it("gives every run of this window the same lease owner and the account store", async () => {
    const faults: string[] = []
    const deps = host.chatRunDeps((fault) => faults.push(fault.code))
    expect(deps.leaseOwner).toBe(host.windowLeaseOwner())
    expect(deps.leaseOwner).toMatch(/^window:/)
    expect(deps.appliers).toBe(accountDatabaseAppliers)
    const store = await deps.store()
    expect(store.db.name).toBe("host-test-main-router-fusion-v1")
    deps.onFault?.({ code: "internal" } as never)
    expect(faults).toEqual(["internal"])
  })
})
