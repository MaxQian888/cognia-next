import { fromBase64Url } from "../bytes"
import { matchesKeyCommitment, openDeviceName, unwrapPreviousKey } from "../epoch"
import { isDeviceId } from "../ids"
import { ChainBuilder, makeDevice, makeRecovery } from "./chain"

const SPACE = "s".repeat(43)

describe("ChainBuilder", () => {
  it("makes devices with raw P-256 points and dev_ ids", async () => {
    const device = await makeDevice("Laptop", "web")
    expect(isDeviceId(device.deviceId)).toBe(true)
    expect(device.platform).toBe("web")
    expect(fromBase64Url(device.signPub)).toHaveLength(65)
    expect(fromBase64Url(device.encPub)).toHaveLength(65)
  })

  it("keeps every epoch key, each matching its commitment and wrapping the previous one", async () => {
    const first = await makeDevice("First")
    const chain = await ChainBuilder.genesis(SPACE, first, await makeRecovery())
    await chain.rotateEpoch(first)
    await chain.rotateEpoch(first)
    expect(chain.epoch).toBe(3)
    for (const epoch of [1, 2, 3]) {
      const key = chain.epochKeys.get(epoch)!
      expect(await matchesKeyCommitment(key, SPACE, epoch, chain.state.keyCommits[epoch]!)).toBe(
        true
      )
    }
    const previous = await unwrapPreviousKey(
      chain.currentKey(),
      chain.state.prevWraps[3]!,
      SPACE,
      3
    )
    expect(previous).toEqual(chain.epochKeys.get(2))
  })

  it("seals each device's name under the epoch it joined", async () => {
    const first = await makeDevice("我的电脑")
    const chain = await ChainBuilder.genesis(SPACE, first, await makeRecovery())
    const device = chain.state.devices[first.deviceId]!
    expect(
      await openDeviceName(chain.epochKeys.get(1)!, SPACE, first.deviceId, device.nameCt)
    ).toBe("我的电脑")
  })

  it("forks without touching the original", async () => {
    const first = await makeDevice()
    const chain = await ChainBuilder.genesis(SPACE, first, await makeRecovery())
    const fork = chain.fork()
    await fork.rotateEpoch(first)
    expect(chain.entries).toHaveLength(1)
    expect(chain.state.epoch).toBe(1)
    expect(fork.entries).toHaveLength(2)
  })
})
