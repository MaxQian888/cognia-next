const platformMock = jest.fn(() => "macos")
jest.mock("@tauri-apps/plugin-os", () => ({ platform: () => platformMock() }))

let tauri = true
const callMock = jest.fn()
jest.mock("@/lib/tauri", () => ({
  isTauri: () => tauri,
  transport: { call: (...args: unknown[]) => callMock(...args) },
}))

const updateInitializationMock = jest.fn().mockResolvedValue(true)
const getEnvironmentMock = jest.fn()
jest.mock("@/lib/db/project-environments", () => ({
  updateProjectEnvironmentInitialization: (...args: unknown[]) => updateInitializationMock(...args),
  getProjectEnvironment: (...args: unknown[]) => getEnvironmentMock(...args),
}))

let workspaceFiles: Record<string, string> = {}
let workspacePaths = new Set<string>()
let workspaceStatFails = false
jest.mock("@/lib/files/workspace-fs", () => ({
  readWorkspaceFile: async (_root: string, relPath: string) => {
    if (relPath in workspaceFiles) return workspaceFiles[relPath]
    throw new Error(`missing ${relPath}`)
  },
  statWorkspaceFile: async (_root: string, relPath: string) => {
    if (workspaceStatFails) throw new Error("unavailable workspace")
    return {
      exists: relPath in workspaceFiles || workspacePaths.has(relPath),
      isDir: workspacePaths.has(relPath),
      size: workspaceFiles[relPath]?.length ?? 0,
      mtimeMs: 1,
    }
  },
}))
jest.mock("@/lib/data/crypto", () => ({ sha256Hex: async (value: string) => `h(${value})` }))

import { executeProjectEnvironment, resolveEnvironmentScript } from "./executor"
import type { ProjectEnvironment } from "@/types/project-environment"

const environment: ProjectEnvironment = {
  id: "env-1",
  projectId: "project-1",
  name: "Development",
  isEnabled: true,
  setupScript: { default: "install", byOs: { macos: "pnpm install" } },
  actions: [{ id: "test", name: "Test", script: { default: "pnpm test" } }],
  variables: { NODE_ENV: "development" },
  keyringReferences: [{ variable: "API_TOKEN", keyringRef: "project:token" }],
  createdAt: 1,
  updatedAt: 1,
}

beforeEach(() => {
  tauri = true
  callMock.mockReset().mockResolvedValue({
    stdout: "ok",
    stderr: "",
    exit_code: 0,
    timed_out: false,
  })
  updateInitializationMock.mockClear()
  getEnvironmentMock.mockReset().mockResolvedValue(undefined)
  workspaceFiles = {}
  workspacePaths = new Set()
  workspaceStatFails = false
  platformMock.mockReset().mockReturnValue("macos")
})

it("keeps host script selection and keyring values inside the execution host", async () => {
  const result = await executeProjectEnvironment({
    environment,
    executionRoot: "/worktree",
    scope: "managedWorktree",
    surface: "interactive",
  })

  expect(result).toEqual(expect.objectContaining({ success: true, bypassed: false }))
  expect(callMock).toHaveBeenCalledWith("project_environment_execute", {
    script: { default: "install", byOs: { macos: "pnpm install" } },
    cwd: "/worktree",
    variables: { NODE_ENV: "development" },
    keyringReferences: [{ variable: "API_TOKEN", keyringRef: "project:token" }],
    policy: { network: "on", requireSandbox: false },
    timeoutSecs: undefined,
  })
  expect(updateInitializationMock).toHaveBeenLastCalledWith(
    "env-1",
    expect.objectContaining({ status: "succeeded", executionRoot: "/worktree" }),
    expect.any(Number)
  )
})

it("allows only interactive setup failures to be bypassed", async () => {
  callMock.mockResolvedValue({ stdout: "", stderr: "bad", exit_code: 1, timed_out: false })
  await expect(
    executeProjectEnvironment({
      environment,
      executionRoot: "/repo",
      scope: "local",
      surface: "interactive",
      bypassOnFailure: true,
    })
  ).resolves.toEqual(expect.objectContaining({ success: true, bypassed: true }))

  await expect(
    executeProjectEnvironment({
      environment,
      executionRoot: "/repo",
      scope: "local",
      surface: "scheduled",
      bypassOnFailure: true,
    })
  ).resolves.toEqual(expect.objectContaining({ success: false, bypassed: false }))
})

it("executes reusable actions without overwriting setup initialization state", async () => {
  await executeProjectEnvironment({
    environment,
    executionRoot: "/repo",
    scope: "local",
    surface: "interactive",
    actionId: "test",
  })
  expect(callMock).toHaveBeenCalledWith(
    "project_environment_execute",
    expect.objectContaining({ script: { default: "pnpm test" } })
  )
  expect(updateInitializationMock).not.toHaveBeenCalled()
})

it("routes web execution through the existing transport with a fail-closed cloud policy", async () => {
  tauri = false
  await expect(
    executeProjectEnvironment({
      environment,
      executionRoot: "/repo",
      scope: "local",
      surface: "interactive",
    })
  ).resolves.toEqual(expect.objectContaining({ success: true, bypassed: false }))
  expect(callMock).toHaveBeenCalledWith(
    "project_environment_execute",
    expect.objectContaining({
      script: environment.setupScript,
      policy: { network: "off", requireSandbox: true },
    })
  )
})

it("uses the default script when the host has no override", () => {
  expect(resolveEnvironmentScript(environment.setupScript, "linux")).toBe("install")
})

describe("setup reuse", () => {
  const reusable: ProjectEnvironment = {
    ...environment,
    setupReuse: { enabled: true, inputs: ["pnpm-lock.yaml"], outputs: ["node_modules"] },
  }
  const input = {
    environment: reusable,
    executionRoot: "/worktree",
    scope: "managedWorktree" as const,
    surface: "scheduled" as const,
  }

  /** Run setup once and hand back the fingerprint it recorded. */
  async function recordedFingerprint(): Promise<string> {
    await executeProjectEnvironment(input)
    const finished = updateInitializationMock.mock.calls
      .map((call) => call[1])
      .filter((record) => record.status === "succeeded")
      .pop()
    expect(finished?.fingerprint).toEqual(expect.any(String))
    return finished.fingerprint
  }

  function storedWith(fingerprint: string, status = "succeeded"): ProjectEnvironment {
    return {
      ...reusable,
      initializationHistory: [
        {
          status: status as "succeeded",
          scope: "managedWorktree",
          executionRoot: "/worktree",
          startedAt: 1,
          completedAt: 2,
          exitCode: 0,
          fingerprint,
        },
      ],
    }
  }

  beforeEach(() => {
    workspaceFiles = { "pnpm-lock.yaml": "lock-v1" }
    workspacePaths = new Set(["node_modules"])
  })

  it("records a fingerprint on success and skips the next identical setup", async () => {
    const fingerprint = await recordedFingerprint()
    callMock.mockClear()
    updateInitializationMock.mockClear()
    getEnvironmentMock.mockResolvedValue(storedWith(fingerprint))

    const result = await executeProjectEnvironment(input)

    expect(result).toEqual({ success: true, bypassed: false, exitCode: 0, reused: true })
    expect(callMock).not.toHaveBeenCalled()
    // A reuse is not a setup and leaves the history alone.
    expect(updateInitializationMock).not.toHaveBeenCalled()
  })

  it("runs again when an input changes", async () => {
    const fingerprint = await recordedFingerprint()
    getEnvironmentMock.mockResolvedValue(storedWith(fingerprint))
    workspaceFiles = { "pnpm-lock.yaml": "lock-v2" }
    callMock.mockClear()

    const result = await executeProjectEnvironment(input)

    expect(result.reused).toBeUndefined()
    expect(callMock).toHaveBeenCalledTimes(1)
  })

  it("runs again when a declared output is gone", async () => {
    const fingerprint = await recordedFingerprint()
    getEnvironmentMock.mockResolvedValue(storedWith(fingerprint))
    workspacePaths = new Set()
    callMock.mockClear()

    await executeProjectEnvironment(input)

    expect(callMock).toHaveBeenCalledTimes(1)
  })

  it("runs again after a failed setup in the same root", async () => {
    const fingerprint = await recordedFingerprint()
    getEnvironmentMock.mockResolvedValue(storedWith(fingerprint, "failed"))
    callMock.mockClear()

    await executeProjectEnvironment(input)

    expect(callMock).toHaveBeenCalledTimes(1)
  })

  it("always runs when forced", async () => {
    const fingerprint = await recordedFingerprint()
    getEnvironmentMock.mockResolvedValue(storedWith(fingerprint))
    callMock.mockClear()

    await executeProjectEnvironment({ ...input, force: true })

    expect(callMock).toHaveBeenCalledTimes(1)
  })

  it("does not record a fingerprint for a failed setup", async () => {
    callMock.mockResolvedValue({ stdout: "", stderr: "", exit_code: 1, timed_out: false })

    await executeProjectEnvironment(input)

    const failed = updateInitializationMock.mock.calls.map((call) => call[1]).pop()
    expect(failed.status).toBe("failed")
    expect(failed).not.toHaveProperty("fingerprint")
  })

  it("never reuses for an environment that did not opt in", async () => {
    const fingerprint = await recordedFingerprint()
    getEnvironmentMock.mockClear().mockResolvedValue(storedWith(fingerprint))
    callMock.mockClear()

    await executeProjectEnvironment({ ...input, environment: environment })

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(getEnvironmentMock).not.toHaveBeenCalled()
  })
})

describe("concurrent setups in one root", () => {
  const input = {
    environment,
    executionRoot: "/worktree",
    scope: "managedWorktree" as const,
    surface: "scheduled" as const,
  }

  function deferredHostCall() {
    let finish: (value: unknown) => void = () => undefined
    callMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    return (exitCode: number) =>
      finish({ stdout: "", stderr: "", exit_code: exitCode, timed_out: false })
  }

  it("joins an identical setup already in flight instead of running it twice", async () => {
    const finish = deferredHostCall()
    const first = executeProjectEnvironment(input)
    const second = executeProjectEnvironment(input)
    await Promise.resolve()
    finish(0)

    await expect(first).resolves.toEqual(expect.objectContaining({ success: true }))
    await expect(second).resolves.toEqual({
      success: true,
      bypassed: false,
      exitCode: 0,
      joined: true,
    })
    expect(callMock).toHaveBeenCalledTimes(1)
  })

  it("makes its own attempt after an in-flight setup fails", async () => {
    const finish = deferredHostCall()
    const first = executeProjectEnvironment(input)
    const second = executeProjectEnvironment(input)
    await Promise.resolve()
    finish(1)

    await expect(first).resolves.toEqual(expect.objectContaining({ success: false }))
    await expect(second).resolves.toEqual(expect.objectContaining({ success: true }))
    expect(callMock).toHaveBeenCalledTimes(2)
  })

  it("waits for, but does not join, a setup with a different definition", async () => {
    const finish = deferredHostCall()
    const first = executeProjectEnvironment(input)
    const second = executeProjectEnvironment({
      ...input,
      environment: { ...environment, variables: { NODE_ENV: "test" } },
    })
    await Promise.resolve()
    expect(callMock).toHaveBeenCalledTimes(1)
    finish(0)

    await first
    const result = await second
    expect(result.joined).toBeUndefined()
    expect(callMock).toHaveBeenCalledTimes(2)
  })

  it("does not serialize setups in different roots", async () => {
    const finish = deferredHostCall()
    const first = executeProjectEnvironment(input)
    const other = executeProjectEnvironment({ ...input, executionRoot: "/other" })

    await expect(other).resolves.toEqual(expect.objectContaining({ success: true }))
    finish(0)
    await first
    expect(callMock).toHaveBeenCalledTimes(2)
  })
})

describe("bootstrap Agent initialization", () => {
  const bootstrapEnvironment: ProjectEnvironment = {
    ...environment,
    keyringReferences: [{ variable: "BOOTSTRAP_KEY", keyringRef: "provider:test" }],
    bootstrapAgent: {
      enabled: true,
      task: "Repair $(literal) 'quoted' dependencies",
      baseUrl: "https://api.example.com/v1",
      model: "test-model",
      apiKeyEnv: "BOOTSTRAP_KEY",
      checks: [{ name: "ready", command: "test -d node_modules" }],
    },
  }
  const input = {
    environment: bootstrapEnvironment,
    executionRoot: "/repo",
    scope: "local" as const,
    surface: "scheduled" as const,
  }

  it("launches before full runtime, retains host policy and sends literal config only in variables", async () => {
    await executeProjectEnvironment({
      ...input,
      environment: {
        ...bootstrapEnvironment,
        policy: { requiredRuntimeCapabilities: [], network: "off", requireSandbox: true },
      },
    })
    const args = callMock.mock.calls[0][1]
    expect(args.cwd).toBe("/repo")
    expect(args.policy).toEqual({
      requiredRuntimeCapabilities: [],
      network: "off",
      requireSandbox: true,
    })
    expect(args.keyringReferences).toEqual(bootstrapEnvironment.keyringReferences)
    expect(args.timeoutSecs).toBe(605)
    expect(args.script.byOs.macos).toContain("init --config-env COGNIA_BOOTSTRAP_CONFIG")
    expect(args.script.default).not.toContain("Repair")
    expect(JSON.parse(args.variables.COGNIA_BOOTSTRAP_CONFIG_MACOS)).toMatchObject({
      task: bootstrapEnvironment.bootstrapAgent!.task,
      setupCommand: "pnpm install",
    })
  })

  it("propagates manual force and preserves the CLI cleanup budget", async () => {
    await executeProjectEnvironment({ ...input, force: true, timeoutSecs: 1 })
    const args = callMock.mock.calls[0][1]
    expect(args.timeoutSecs).toBe(605)
    expect(args.script.byOs.linux).toContain("--force")
    expect(args.script.default).toContain("--force")
  })

  it("runs with an empty setup script and never intercepts actions", async () => {
    await executeProjectEnvironment({
      ...input,
      environment: { ...bootstrapEnvironment, setupScript: { default: "" } },
    })
    expect(callMock).toHaveBeenCalledTimes(1)
    expect(
      JSON.parse(callMock.mock.calls[0][1].variables.COGNIA_BOOTSTRAP_CONFIG)
    ).not.toHaveProperty("setupCommand")
    callMock.mockClear()
    await executeProjectEnvironment({ ...input, actionId: "test" })
    expect(callMock.mock.calls[0][1]).toMatchObject({
      script: { default: "pnpm test" },
      variables: environment.variables,
    })
  })

  it("leaves ordinary execution unchanged when bootstrap is disabled", async () => {
    await executeProjectEnvironment({
      ...input,
      environment: {
        ...bootstrapEnvironment,
        bootstrapAgent: { ...bootstrapEnvironment.bootstrapAgent!, enabled: false },
      },
    })
    expect(callMock.mock.calls[0][1]).toMatchObject({
      script: environment.setupScript,
      variables: environment.variables,
    })
    expect(callMock.mock.calls[0][1].timeoutSecs).toBeUndefined()
  })

  it.each([
    { stdout: "Agent says ready", stderr: "", exit_code: 1, timed_out: false },
    { stdout: "Agent says ready", stderr: "", exit_code: 0, timed_out: true },
  ])("accepts only a checked zero exit without timeout", async (result) => {
    callMock.mockResolvedValue(result)
    expect((await executeProjectEnvironment(input)).success).toBe(false)
    expect(updateInitializationMock).toHaveBeenLastCalledWith(
      "env-1",
      expect.objectContaining({ status: "failed" }),
      expect.any(Number)
    )
  })

  it("rejects scheduled bypass and fails closed on an invalid stored definition", async () => {
    expect((await executeProjectEnvironment({ ...input, bypassOnFailure: true })).success).toBe(
      false
    )
    expect(callMock).not.toHaveBeenCalled()
    const result = await executeProjectEnvironment({
      ...input,
      environment: { ...bootstrapEnvironment, keyringReferences: [] },
    })
    expect(result.success).toBe(false)
    expect(callMock).not.toHaveBeenCalled()
  })

  it("invalidates successful reuse when bootstrap settings change", async () => {
    const reusable = {
      ...bootstrapEnvironment,
      setupReuse: { enabled: true, inputs: [], outputs: [] },
    }
    await executeProjectEnvironment({ ...input, environment: reusable })
    const previous = updateInitializationMock.mock.calls.at(-1)![1]
    getEnvironmentMock.mockResolvedValue({ ...reusable, lastInitialization: previous })
    callMock.mockClear()
    expect(
      (await executeProjectEnvironment({ ...input, environment: reusable })).reused
    ).toBeUndefined()
    expect(callMock.mock.calls.at(-1)![1].script.default).not.toContain("--force")
    callMock.mockClear()
    await executeProjectEnvironment({
      ...input,
      environment: {
        ...reusable,
        bootstrapAgent: { ...reusable.bootstrapAgent!, model: "new-model" },
      },
    })
    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock.mock.calls[0][1].script.default).toContain("--force")
  })

  it("hashes bootstrap inputs, forces setup when their content changes and always runs readiness", async () => {
    const configured: ProjectEnvironment = {
      ...bootstrapEnvironment,
      bootstrapAgent: {
        ...bootstrapEnvironment.bootstrapAgent!,
        reuse: { inputs: ["package.json"], outputs: ["node_modules"] },
      },
    }
    workspaceFiles = { "package.json": "v1" }
    workspacePaths.add("node_modules")
    await executeProjectEnvironment({ ...input, environment: configured })
    const previous = updateInitializationMock.mock.calls.at(-1)![1]
    expect(previous.fingerprint).toEqual(expect.any(String))
    getEnvironmentMock.mockResolvedValue({ ...configured, lastInitialization: previous })
    callMock.mockClear()
    await executeProjectEnvironment({ ...input, environment: configured })
    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock.mock.calls.at(-1)![1].script.default).not.toContain("--force")
    workspaceFiles["package.json"] = "v2"
    await executeProjectEnvironment({ ...input, environment: configured })
    expect(callMock.mock.calls.at(-1)![1].script.default).toContain("--force")
    expect(updateInitializationMock.mock.calls.at(-1)![1].fingerprint).not.toBe(
      previous.fingerprint
    )
  })

  it("forces setup for absent bootstrap outputs and prior success without a fingerprint", async () => {
    const configured: ProjectEnvironment = {
      ...bootstrapEnvironment,
      bootstrapAgent: {
        ...bootstrapEnvironment.bootstrapAgent!,
        reuse: { outputs: ["node_modules"] },
      },
    }
    await executeProjectEnvironment({ ...input, environment: configured })
    const previous = updateInitializationMock.mock.calls.at(-1)![1]
    getEnvironmentMock.mockResolvedValue({ ...configured, lastInitialization: previous })
    await executeProjectEnvironment({ ...input, environment: configured })
    expect(callMock.mock.calls.at(-1)![1].script.default).toContain("--force")
    workspacePaths.add("node_modules")
    getEnvironmentMock.mockResolvedValue({
      ...configured,
      lastInitialization: { ...previous, fingerprint: undefined },
    })
    await executeProjectEnvironment({ ...input, environment: configured })
    expect(callMock.mock.calls.at(-1)![1].script.default).toContain("--force")
  })

  it("fails closed on bootstrap fingerprint I/O and invalid imported paths", async () => {
    const configured: ProjectEnvironment = {
      ...bootstrapEnvironment,
      bootstrapAgent: {
        ...bootstrapEnvironment.bootstrapAgent!,
        reuse: { inputs: ["package.json"] },
      },
    }
    workspaceStatFails = true
    await executeProjectEnvironment({ ...input, environment: configured })
    expect(callMock.mock.calls.at(-1)![1].script.default).toContain("--force")
    callMock.mockClear()
    const result = await executeProjectEnvironment({
      ...input,
      environment: {
        ...configured,
        bootstrapAgent: { ...configured.bootstrapAgent!, reuse: { inputs: ["C:\\outside"] } },
      },
    })
    expect(result).toMatchObject({ success: false, bootstrapValidationCode: "reuse" })
    expect(callMock).not.toHaveBeenCalled()
    expect(updateInitializationMock.mock.calls.at(-1)![1].status).toBe("failed")
  })

  it("serializes simultaneous bootstrap requests while running fresh readiness for each", async () => {
    let release!: (value: unknown) => void
    let enter!: () => void
    const entered = new Promise<void>((resolve) => {
      enter = resolve
    })
    callMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
          enter()
        })
    )
    const first = executeProjectEnvironment(input)
    const second = executeProjectEnvironment(input)
    await entered
    expect(callMock).toHaveBeenCalledTimes(1)
    release({ stdout: "ok", stderr: "", exit_code: 0, timed_out: false })
    await expect(first).resolves.toMatchObject({ success: true })
    const result = await second
    expect(result.success).toBe(true)
    expect(result.joined).toBeUndefined()
    expect(callMock).toHaveBeenCalledTimes(2)
  })
})
