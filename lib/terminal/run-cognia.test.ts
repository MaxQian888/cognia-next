import { launchCognia } from "./run-cognia"

function makeStore() {
  return { setPanelOpen: jest.fn() } as never
}

describe("launchCognia", () => {
  it("opens the dock, spawns a tab, and writes the cognia command", async () => {
    const write = jest.fn().mockResolvedValue(undefined)
    const spawn = jest
      .fn()
      .mockResolvedValue({ kind: "spawned", sessionId: "s1", shell: "/bin/bash" })
    const lookup = jest.fn().mockReturnValue({ write })
    const store = makeStore() as never as { setPanelOpen: jest.Mock }

    const out = await launchCognia({
      command: "plugin build",
      cwd: "/proj",
      shell: "/bin/bash",
      store: store as never,
      spawn,
      lookup,
    })

    expect(store.setPanelOpen).toHaveBeenCalledWith(true)
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        req: expect.objectContaining({
          shell: "/bin/bash",
          cwd: "/proj",
          rows: 24,
          cols: 80,
          enableShellIntegration: true,
        }),
      })
    )
    expect(write).toHaveBeenCalledWith("cognia plugin build\r")
    expect(out).toEqual({ kind: "launched", sessionId: "s1" })
  })

  it("returns denied when the spawn is denied", async () => {
    const spawn = jest.fn().mockResolvedValue({ kind: "denied", reason: "policy" })
    const out = await launchCognia({
      command: "plugin dev",
      cwd: "/proj",
      shell: "x",
      store: makeStore(),
      spawn,
      lookup: jest.fn(),
    })
    expect(out).toEqual({ kind: "denied", reason: "policy" })
  })

  it("returns error when the spawn errors", async () => {
    const spawn = jest.fn().mockResolvedValue({ kind: "error", message: "boom" })
    const out = await launchCognia({
      command: "plugin dev",
      cwd: "/proj",
      shell: "x",
      store: makeStore(),
      spawn,
      lookup: jest.fn(),
    })
    expect(out).toEqual({ kind: "error", message: "boom" })
  })

  it("errors when the spawned session isn't live", async () => {
    const spawn = jest.fn().mockResolvedValue({ kind: "spawned", sessionId: "s2", shell: "x" })
    const lookup = jest.fn().mockReturnValue(undefined)
    const out = await launchCognia({
      command: "plugin lint",
      cwd: "/proj",
      shell: "x",
      store: makeStore(),
      spawn,
      lookup,
    })
    expect(out.kind).toBe("error")
  })

  it("falls back to a platform default shell when none is given", async () => {
    const spawn = jest.fn().mockResolvedValue({ kind: "spawned", sessionId: "s3", shell: "x" })
    const lookup = jest.fn().mockReturnValue({ write: jest.fn() })
    await launchCognia({
      command: "plugin new",
      cwd: "/proj",
      store: makeStore(),
      spawn,
      lookup,
    })
    const arg = spawn.mock.calls[0][0]
    expect(typeof arg.req.shell).toBe("string")
    expect(arg.req.shell.length).toBeGreaterThan(0)
  })
})
