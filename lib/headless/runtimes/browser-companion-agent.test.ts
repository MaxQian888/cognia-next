export {}

const registerHeadlessRuntime = jest.fn()
const teardown = jest.fn()
const startBrowserCompanionAgentRuntime = jest.fn(async () => teardown)

jest.mock("../registry", () => ({
  registerHeadlessRuntime: (...args: unknown[]) => registerHeadlessRuntime(...args),
}))
jest.mock("@/lib/browser-companion/host-dispatch", () => ({
  startBrowserCompanionAgentRuntime: () => startBrowserCompanionAgentRuntime(),
}))

interface RegisteredRuntime {
  name: string
  criticality: string
  hosts: string[]
  start: (ctx: unknown) => Promise<unknown>
}

function registered(): RegisteredRuntime {
  expect(registerHeadlessRuntime).toHaveBeenCalledTimes(1)
  return registerHeadlessRuntime.mock.calls[0][0] as RegisteredRuntime
}

describe("browser companion agent headless runtime", () => {
  beforeEach(() => {
    jest.resetModules()
    registerHeadlessRuntime.mockClear()
    startBrowserCompanionAgentRuntime.mockClear()
  })

  it("registers as an optional brain runtime", async () => {
    await import("./browser-companion-agent")
    const runtime = registered()
    expect(runtime).toMatchObject({
      name: "browser-companion-agent",
      criticality: "optional",
      hosts: ["brain"],
    })
  })

  it("starts the same Host runtime the desktop mounts and hands back its teardown", async () => {
    await import("./browser-companion-agent")
    const stop = await registered().start({})
    expect(startBrowserCompanionAgentRuntime).toHaveBeenCalledTimes(1)
    expect(stop).toBe(teardown)
  })

  it("is part of the brain's runtime set", async () => {
    const { readFile } = await import("node:fs/promises")
    const index = await readFile("lib/headless/runtimes/index.ts", "utf8")
    expect(index).toContain('import "./browser-companion-agent"')
  })
})
