export {}

const registerHeadlessRuntime = jest.fn()
const attachManagedIdeBrokerTransport = jest.fn((_brokerTransport: unknown, _runtime: unknown) =>
  jest.fn()
)
class CompanionTransport {
  static acceptInstances = true
  static [Symbol.hasInstance](): boolean {
    return CompanionTransport.acceptInstances
  }

  subscribe = jest.fn()
  uploadManagedIdeContent = jest.fn()
  redeemManagedIdeContent = jest.fn()
}
const transport = new CompanionTransport()
const createManagedIdeBrokerDependencies = jest.fn(() => ({ marker: true }))
const ManagedIdeBrokerRuntime = jest.fn()

jest.mock("../registry", () => ({
  registerHeadlessRuntime: (...args: unknown[]) => registerHeadlessRuntime(...args),
}))
jest.mock("@/lib/tauri", () => ({ transport }))
jest.mock("@/lib/tauri/transport-companion", () => ({ CompanionTransport }))
jest.mock("@/lib/plugin/ide/broker-runtime", () => ({
  attachManagedIdeBrokerTransport: (brokerTransport: unknown, runtime: unknown) =>
    attachManagedIdeBrokerTransport(brokerTransport, runtime),
  createManagedIdeBrokerDependencies: () => createManagedIdeBrokerDependencies(),
  ManagedIdeBrokerRuntime: function (...args: unknown[]) {
    return ManagedIdeBrokerRuntime(...args)
  },
}))

describe("managed IDE headless runtime", () => {
  beforeEach(() => {
    jest.resetModules()
    registerHeadlessRuntime.mockClear()
    attachManagedIdeBrokerTransport.mockClear()
    ManagedIdeBrokerRuntime.mockClear()
    transport.uploadManagedIdeContent.mockReset()
    transport.redeemManagedIdeContent.mockReset()
    CompanionTransport.acceptInstances = true
    delete process.env.COGNIA_HOST_ID
  })

  it("binds broker events to the brain transport and returns its disposer", async () => {
    await import("./managed-ide-broker")
    const registration = registerHeadlessRuntime.mock.calls[0][0]
    const dispose = await registration.start()

    expect(registration).toMatchObject({
      name: "managed-ide-broker",
      hosts: ["brain"],
    })
    expect(ManagedIdeBrokerRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        marker: true,
        createContent: expect.any(Function),
        redeemContent: expect.any(Function),
      })
    )
    expect(attachManagedIdeBrokerTransport).toHaveBeenCalledWith(transport, expect.any(Object))
    expect(typeof dispose).toBe("function")
  })

  it("routes scoped binary handles through the companion and honors the remote host id", async () => {
    process.env.COGNIA_HOST_ID = "paired-host"
    transport.uploadManagedIdeContent.mockResolvedValue({ id: "uploaded" })
    transport.redeemManagedIdeContent.mockResolvedValue(Uint8Array.from([4, 2]))
    await import("./managed-ide-broker")
    const registration = registerHeadlessRuntime.mock.calls[0][0]

    await registration.start()
    const dependencies = ManagedIdeBrokerRuntime.mock.calls[0][0]
    const bytes = Uint8Array.from([1, 2, 3])
    await expect(
      dependencies.createContent(
        "/workspace",
        7,
        "acme.tools",
        "cognia.acme.tools.fs",
        "filesystem:read",
        bytes
      )
    ).resolves.toEqual({ id: "uploaded" })
    expect(transport.uploadManagedIdeContent).toHaveBeenCalledWith(
      {
        root: "/workspace",
        generation: 7,
        pluginId: "acme.tools",
        providerId: "cognia.acme.tools.fs",
        permission: "filesystem:read",
        mediaType: "application/octet-stream",
      },
      bytes
    )
    await expect(
      dependencies.redeemContent(
        "/workspace",
        7,
        "acme.tools",
        "cognia.acme.tools.fs",
        "filesystem:read",
        "handle-1"
      )
    ).resolves.toEqual(Uint8Array.from([4, 2]))
    expect(transport.redeemManagedIdeContent).toHaveBeenCalledWith(
      {
        root: "/workspace",
        generation: 7,
        pluginId: "acme.tools",
        providerId: "cognia.acme.tools.fs",
        permission: "filesystem:read",
      },
      "handle-1"
    )
    expect(ManagedIdeBrokerRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ expectedHostId: "paired-host" })
    )
  })

  it("fails closed when the headless process is not using companion transport", async () => {
    CompanionTransport.acceptInstances = false
    await import("./managed-ide-broker")
    const registration = registerHeadlessRuntime.mock.calls[0][0]

    await expect(registration.start()).rejects.toThrow(
      "managed-ide-broker requires the headless companion transport"
    )
    expect(ManagedIdeBrokerRuntime).not.toHaveBeenCalled()
  })
})
