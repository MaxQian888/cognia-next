import { createMemoryKeyring } from "../testing/memory-keyring"
import { createAccountSyncVault } from "../vault-store"
import { createAccountSyncContext } from "./context"
import { revokeDevice } from "./manage"
import { isActiveDevice, readEnrollmentStatus } from "./status"
import { identity, spaceWithFirstDevice, testContext, testServer, TEST_SPACE } from "./test-support"
import { recoverWithKey } from "./recover"

describe("readEnrollmentStatus", () => {
  it("names an empty space, then an enrolled first device", async () => {
    const server = testServer()
    expect(await readEnrollmentStatus(testContext(server, "x"))).toMatchObject({
      kind: "not-enrolled",
      space: "empty",
    })
    const { context, device } = await spaceWithFirstDevice(server)
    const status = await readEnrollmentStatus(context)
    expect(status).toMatchObject({ kind: "enrolled", device: { deviceId: device.deviceId } })
    expect(await readEnrollmentStatus(testContext(server, "y"))).toMatchObject({
      kind: "not-enrolled",
      space: "ready",
    })
  })

  it("is locked while the secret store is", async () => {
    const store = createMemoryKeyring()
    store.persistent = false
    const context = createAccountSyncContext(
      {
        localAccountId: "l",
        issuer: "https://id.test/api/auth",
        userId: "usr_1",
        spaceId: TEST_SPACE,
        syncUrl: "https://sync.test",
        accessToken: async () => "t",
      },
      {
        fetchImpl: testServer().fetch,
        vault: createAccountSyncVault({ localAccountId: "l", spaceId: TEST_SPACE }, store),
      }
    )
    expect(await readEnrollmentStatus(context)).toEqual({ kind: "locked" })
  })

  it("applies a proven revocation and then reports the removal", async () => {
    const server = testServer()
    const { context, device, recoveryKeyText } = await spaceWithFirstDevice(server)
    const second = testContext(server, "second")
    await recoverWithKey(second, recoveryKeyText, identity("Second"))
    const secondKeys = (await second.vault.loadDeviceKeys())!
    await revokeDevice(context, device, secondKeys.deviceId)
    const status = await readEnrollmentStatus(second)
    expect(status).toMatchObject({ kind: "removed", removal: { by: device.deviceId } })
    expect(await second.vault.loadDeviceKeys()).toBeNull()
  })

  it("does not treat keys the list does not hold as enrolled", async () => {
    const server = testServer()
    await spaceWithFirstDevice(server)
    const stray = testContext(server, "stray")
    const { generateDeviceKeyMaterial } = await import("../crypto")
    await stray.vault.saveDeviceKeys(await generateDeviceKeyMaterial())
    expect(await readEnrollmentStatus(stray)).toMatchObject({
      kind: "not-enrolled",
      space: "ready",
    })
  })
})

describe("isActiveDevice", () => {
  it("reads the list", async () => {
    const server = testServer()
    const { device } = await spaceWithFirstDevice(server)
    expect(isActiveDevice(server.state()!, device.deviceId)).toBe(true)
    expect(isActiveDevice(server.state()!, "dev_nope")).toBe(false)
  })
})
