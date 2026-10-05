import { ChainBuilder, makeDevice, makeRecovery } from "../testing/chain"
import { laterPin, pinFor, type RegistryPin } from "./pin"

describe("registry pin", () => {
  it("records genesis, head and epoch", async () => {
    const first = await makeDevice()
    const chain = await ChainBuilder.genesis("s".repeat(43), first, await makeRecovery())
    await chain.rotateEpoch(first)
    expect(pinFor(chain.state)).toEqual({
      genesisHash: chain.state.genesisHash,
      seq: 1,
      hash: chain.state.head.hash,
      epoch: 2,
    })
  })

  it("only moves forward", () => {
    const older: RegistryPin = { genesisHash: "g", seq: 2, hash: "a", epoch: 1 }
    const newer: RegistryPin = { genesisHash: "g", seq: 5, hash: "b", epoch: 3 }
    expect(laterPin(null, older)).toBe(older)
    expect(laterPin(older, newer)).toBe(newer)
    expect(laterPin(newer, older)).toBe(newer)
    const same: RegistryPin = { ...newer }
    expect(laterPin(newer, same)).toBe(same)
  })
})
