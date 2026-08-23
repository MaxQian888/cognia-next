/**
 * The host-event publisher must be available before any authoritative
 * headless runtime starts and must remain available until those runtimes have
 * stopped. This focused runtime test pins the bridge mapping and teardown.
 *
 * @jest-environment node
 */

import { bootstrapHeadlessRuntimes } from "../bootstrap"
import { __resetHeadlessRuntimesForTesting } from "../registry"
import type { HeadlessRuntimeContext } from "../types"
import {
  __resetHostEventPublisherForTests,
  publishHostEvent,
} from "@/lib/companion/host-event-publisher"

describe("host-event-publisher runtime", () => {
  beforeEach(() => {
    __resetHeadlessRuntimesForTesting()
    __resetHostEventPublisherForTests()
  })

  it("maps host events to the authenticated bridge and unregisters on stop", async () => {
    const invoke = jest.fn(async () => null)
    const ctx: HeadlessRuntimeContext = {
      host: "brain",
      accountId: "local_acct_a",
      bridge: {
        listen: async () => () => undefined,
        invoke,
      },
      notifyDbWrite: () => undefined,
      resolveMessage: (key) => key,
      log: () => undefined,
    }

    await import("./host-event-publisher")
    const result = await bootstrapHeadlessRuntimes(ctx)
    expect(result.started).toEqual(["host-event-publisher"])

    await publishHostEvent("sync://invalidate", { table: "workflowRuns" })
    expect(invoke).toHaveBeenCalledWith("companion_event_publish", {
      topic: "sync://invalidate",
      event: { table: "workflowRuns" },
    })

    await result.stop()
    invoke.mockClear()
    await publishHostEvent("sync://invalidate", { table: "workflowRuns" })
    expect(invoke).not.toHaveBeenCalled()
  })
})
