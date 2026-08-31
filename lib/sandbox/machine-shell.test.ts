import { CONTAINER_SHELL_SCRIPT, machineShellArgv, openMachineShell } from "./machine-shell"
import type { TerminalStoreLike } from "@/lib/terminal/spawn-orchestrator"

const store = {} as TerminalStoreLike

function running(overrides: Record<string, unknown> = {}) {
  return {
    containerId: "c0ffee",
    status: "running",
    running: true,
    paused: false,
    networkMode: "none",
    nanoCpus: 0,
    memoryBytes: 0,
    ...overrides,
  }
}

const LOCAL = () => "tauri-channel" as const

describe("machineShellArgv", () => {
  /**
   * The image decides which shell exists, so the choice is made inside the
   * container. A distroless or alpine base has no bash at all, and guessing
   * one from out here produces a tab that dies on open.
   */
  it("resolves bash or sh inside the container, and execs into it", () => {
    expect(machineShellArgv("abc")).toEqual([
      "exec",
      "-it",
      "abc",
      "/bin/sh",
      "-lc",
      CONTAINER_SHELL_SCRIPT,
    ])
    expect(CONTAINER_SHELL_SCRIPT).toContain("exec bash")
    expect(CONTAINER_SHELL_SCRIPT).toContain("exec sh")
  })
})

describe("openMachineShell", () => {
  it("spawns docker exec against the id inspect reported", async () => {
    const spawn = jest.fn().mockResolvedValue({ kind: "ok", sessionId: "t-1" })
    const outcome = await openMachineShell({
      connectionId: "conn-1",
      name: "home-docker",
      store,
      inspect: jest.fn().mockResolvedValue(running()),
      spawn,
      transport: LOCAL,
    })
    expect(outcome).toEqual({ kind: "opened", sessionId: "t-1" })
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        req: expect.objectContaining({ shell: "docker", args: machineShellArgv("c0ffee") }),
        title: "home-docker",
      })
    )
  })

  /**
   * ADR-0160 made `docker inspect` the single source of truth because an
   * in-process map recorded what we asked for rather than what Docker did.
   * Re-deriving the deterministic name here would reintroduce exactly that.
   */
  it("never invents a container name of its own", async () => {
    const spawn = jest.fn().mockResolvedValue({ kind: "ok", sessionId: "t-1" })
    await openMachineShell({
      connectionId: "conn-1",
      name: "home-docker",
      store,
      inspect: jest.fn().mockResolvedValue(running({ containerId: "deadbeef" })),
      spawn,
      transport: LOCAL,
    })
    expect(JSON.stringify(spawn.mock.calls[0][0].req.args)).not.toContain("conn-1")
    expect(spawn.mock.calls[0][0].req.args).toContain("deadbeef")
  })

  /**
   * Docker reports a paused container as still running, so the two are checked
   * in order and reported apart: a paused machine resumes with its memory
   * intact, a stopped one has to be started and has lost it.
   */
  it.each([
    [running({ paused: true }), "paused"],
    [running({ running: false, status: "exited" }), "stopped"],
    [null, "absent"],
  ])("refuses a machine that cannot accept an exec, and says which", async (state, expected) => {
    const spawn = jest.fn()
    await expect(
      openMachineShell({
        connectionId: "conn-1",
        name: "home-docker",
        store,
        inspect: jest.fn().mockResolvedValue(state),
        spawn,
        transport: LOCAL,
      })
    ).resolves.toEqual({ kind: "not-running", state: expected })
    expect(spawn).not.toHaveBeenCalled()
  })

  /**
   * `cua_sandbox_*` is `target: "client"`, so the machines belong to the
   * renderer's own computer while the terminal follows the routing target.
   * Running the exec anyway would open a shell on the wrong box.
   */
  it.each(["ws", "webrtc", "unsupported"] as const)(
    "refuses over %s, where the terminal is not the machine's computer",
    async (kind) => {
      const inspect = jest.fn()
      await expect(
        openMachineShell({
          connectionId: "conn-1",
          name: "home-docker",
          store,
          inspect,
          spawn: jest.fn(),
          transport: () => kind,
        })
      ).resolves.toEqual({ kind: "wrong-host" })
      // Not even asked: the answer does not depend on the machine's state.
      expect(inspect).not.toHaveBeenCalled()
    }
  )

  it("carries a docker failure verbatim, because the message is the diagnosis", async () => {
    await expect(
      openMachineShell({
        connectionId: "conn-1",
        name: "home-docker",
        store,
        inspect: jest.fn().mockRejectedValue(new Error("Cannot connect to the Docker daemon")),
        spawn: jest.fn(),
        transport: LOCAL,
      })
    ).resolves.toEqual({ kind: "error", message: "Cannot connect to the Docker daemon" })
  })

  it("reports a plugin veto as a refusal rather than a silent no-op", async () => {
    await expect(
      openMachineShell({
        connectionId: "conn-1",
        name: "home-docker",
        store,
        inspect: jest.fn().mockResolvedValue(running()),
        spawn: jest.fn().mockResolvedValue({ kind: "denied" }),
        transport: LOCAL,
      })
    ).resolves.toMatchObject({ kind: "error" })
  })
})
