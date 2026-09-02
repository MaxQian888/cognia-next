import { __setProcessPlaneDepsForTests } from "./process-plane"

const agentInvoke = jest.fn()
jest.mock("./agent-transport", () => ({
  agentInvoke: (...args: unknown[]) => agentInvoke(...args),
}))

import {
  detectInstalledRuntimes,
  ExternalAgentDetectionUnavailableError,
  forgetInstalledRuntimes,
} from "./installed-runtimes"

function reachable(): () => void {
  return __setProcessPlaneDepsForTests({
    isRemoteHostActive: () => false,
    hasLocalProcessTable: () => true,
  })
}

/** Reachable through a paired Host, named so a second one is tellable apart. */
function pairedTo(hostId: string): () => void {
  return __setProcessPlaneDepsForTests({
    isRemoteHostActive: () => false,
    hasLocalProcessTable: () => false,
    getRuntimeSnapshot: () => ({
      target: { id: hostId, kind: "companion", hostKind: "desktop", platform: "web" },
      vaultState: "unlocked",
      connectionState: "online",
      host: {
        compatible: true,
        operations: ["external_agent_detect_runtimes"],
        grants: ["process.spawn"],
      },
    }),
  })
}

function unreachable(): () => void {
  return __setProcessPlaneDepsForTests({
    isRemoteHostActive: () => false,
    hasLocalProcessTable: () => false,
    getRuntimeSnapshot: () => ({
      target: null,
      vaultState: "unlocked",
      connectionState: "offline",
    }),
  })
}

const REPORT = {
  runtimes: [
    {
      runtimeId: "codex-app-server",
      command: "codex",
      resolution: "installed",
      executablePath: "/opt/homebrew/bin/codex",
      versionOutput: "codex-cli 0.48.1\n",
      detail: null,
    },
    {
      runtimeId: "gemini-cli",
      command: "npx",
      resolution: "package-runner",
      executablePath: "/usr/local/bin/npx",
      versionOutput: null,
      detail: "gemini-cli runs through npx",
    },
    {
      runtimeId: "droid",
      command: "droid",
      resolution: "missing",
      executablePath: null,
      versionOutput: null,
      detail: null,
    },
    {
      runtimeId: "opencode-remote",
      command: null,
      resolution: "not-local",
      executablePath: null,
      versionOutput: null,
      detail: "opencode-remote has no local command to detect",
    },
  ],
}

describe("detectInstalledRuntimes", () => {
  let restore: (() => void) | undefined

  beforeEach(() => {
    agentInvoke.mockReset()
    forgetInstalledRuntimes()
  })

  afterEach(() => {
    restore?.()
    restore = undefined
  })

  it("reads the version out of raw probe output with the catalogued parser", async () => {
    restore = reachable()
    agentInvoke.mockResolvedValue(REPORT)

    const [codex] = await detectInstalledRuntimes()

    expect(agentInvoke).toHaveBeenCalledWith("external_agent_detect_runtimes", {})
    expect(codex).toEqual({
      runtimeId: "codex-app-server",
      command: "codex",
      resolution: "installed",
      executablePath: "/opt/homebrew/bin/codex",
      version: "0.48.1",
      detail: null,
    })
  })

  it("keeps a runtime whose version could not be read as installed", async () => {
    // Found is found. An unreadable `--version` is a separate fact, and
    // downgrading it to "missing" would send the user to install something
    // that is already there.
    restore = reachable()
    agentInvoke.mockResolvedValue({
      runtimes: [
        {
          runtimeId: "codex-app-server",
          command: "codex",
          resolution: "installed",
          executablePath: "/usr/bin/codex",
          versionOutput: "unreadable banner",
        },
      ],
    })

    const [codex] = await detectInstalledRuntimes()
    expect(codex.resolution).toBe("installed")
    expect(codex.version).toBeNull()
  })

  it("drops a row whose resolution this build does not understand", async () => {
    // A badge is a claim. A host speaking a newer vocabulary gets silence, not
    // a guess at what its new state might mean.
    restore = reachable()
    agentInvoke.mockResolvedValue({
      runtimes: [{ runtimeId: "codex-app-server", resolution: "quarantined" }],
    })
    await expect(detectInstalledRuntimes()).resolves.toEqual([])
  })

  it("caches for the session so a picker does not respawn probes per render", async () => {
    restore = reachable()
    agentInvoke.mockResolvedValue(REPORT)

    await detectInstalledRuntimes()
    await detectInstalledRuntimes()
    expect(agentInvoke).toHaveBeenCalledTimes(1)

    await detectInstalledRuntimes({ refresh: true })
    expect(agentInvoke).toHaveBeenCalledTimes(2)
  })

  it("shares one in-flight request between concurrent callers", async () => {
    restore = reachable()
    agentInvoke.mockResolvedValue(REPORT)
    await Promise.all([detectInstalledRuntimes(), detectInstalledRuntimes()])
    expect(agentInvoke).toHaveBeenCalledTimes(1)
  })

  it("re-asks when the host changes, instead of describing the previous one", async () => {
    // The cache is about a machine's PATH, and nothing announces that the
    // machine moved. Serving Host A's rows to Host B badges every preset with
    // an answer about a computer the user is no longer talking to.
    restore = pairedTo("host-a")
    agentInvoke.mockResolvedValue(REPORT)
    await detectInstalledRuntimes()
    expect(agentInvoke).toHaveBeenCalledTimes(1)

    restore()
    restore = pairedTo("host-b")
    await detectInstalledRuntimes()
    expect(agentInvoke).toHaveBeenCalledTimes(2)
  })

  it("lets the newest load win, whichever answer lands first", async () => {
    restore = reachable()
    let settleFirst: (value: unknown) => void = () => {}
    agentInvoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settleFirst = resolve
        })
    )
    const stale = detectInstalledRuntimes()

    const fresh = { runtimes: [{ runtimeId: "codex-app-server", resolution: "installed" }] }
    agentInvoke.mockResolvedValueOnce(fresh)
    await detectInstalledRuntimes({ refresh: true })

    // The superseded request answers last and must not write its rows back.
    settleFirst(REPORT)
    await stale
    await expect(detectInstalledRuntimes()).resolves.toEqual([
      expect.objectContaining({ runtimeId: "codex-app-server" }),
    ])
    expect(agentInvoke).toHaveBeenCalledTimes(2)
  })

  it("refuses rather than answering an empty list when nothing can be asked", async () => {
    // An empty array reads as "every runtime is missing", which is a different
    // and false claim about the user's machine.
    restore = unreachable()
    await expect(detectInstalledRuntimes()).rejects.toBeInstanceOf(
      ExternalAgentDetectionUnavailableError
    )
    expect(agentInvoke).not.toHaveBeenCalled()
  })
})
