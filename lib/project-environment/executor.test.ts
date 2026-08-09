const platformMock = jest.fn(() => "macos")
jest.mock("@tauri-apps/plugin-os", () => ({ platform: () => platformMock() }))

let tauri = true
const callMock = jest.fn()
jest.mock("@/lib/tauri", () => ({
  isTauri: () => tauri,
  transport: { call: (...args: unknown[]) => callMock(...args) },
}))

const updateInitializationMock = jest.fn().mockResolvedValue(true)
jest.mock("@/lib/db/project-environments", () => ({
  updateProjectEnvironmentInitialization: (...args: unknown[]) => updateInitializationMock(...args),
}))

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
