import { ChainBuilder, makeDevice, makeRecovery } from "@cognia/sync-protocol/testing/chain"

import { deviceNames } from "./device-names"

describe("deviceNames", () => {
  it("opens each name with its epoch's key and reports the rest as null", async () => {
    const first = await makeDevice("MacBook 工作")
    const chain = await ChainBuilder.genesis("s".repeat(43), first, await makeRecovery())
    await chain.rotateEpoch(first)
    const second = await makeDevice("Pixel")
    await chain.addByApproval(first, second)
    const names = await deviceNames(chain.state, chain.epochKeys)
    expect(names.get(first.deviceId)).toBe("MacBook 工作")
    expect(names.get(second.deviceId)).toBe("Pixel")
    const partial = await deviceNames(chain.state, new Map([[2, chain.epochKeys.get(2)!]]))
    expect(partial.get(first.deviceId)).toBeNull()
    const wrong = await deviceNames(chain.state, new Map([[1, chain.epochKeys.get(2)!]]))
    expect(wrong.get(first.deviceId)).toBeNull()
  })
})
