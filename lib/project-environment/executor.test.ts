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
jest.mock("@/lib/files/workspace-fs", () => ({
  readWorkspaceFile: async (_root: string, relPath: string) => {
    if (relPath in workspaceFiles) return workspaceFiles[relPath]
    throw new Error(`missing ${relPath}`)
  },
  statWorkspaceFile: async (_root: string, relPath: string) => ({
    exists: relPath in workspaceFiles || workspacePaths.has(relPath),
    isDir: workspacePaths.has(relPath),
    size: workspaceFiles[relPath]?.length ?? 0,
    mtimeMs: 1,
  }),
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
