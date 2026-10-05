import { spaceWithFirstDevice, testServer } from "./test-support"

describe("enrollment test support", () => {
  it("creates a space with a first device", async () => {
    const server = testServer()
    const { device, recoveryKeyText } = await spaceWithFirstDevice(server)
    expect(server.state()?.devices[device.deviceId]?.status).toBe("active")
    expect(recoveryKeyText).toMatch(/^([0-9A-Z]{4}-){6}[0-9A-Z]{2}$/)
  })
})
