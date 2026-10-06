/** @jest-environment jsdom */
import {
  createOfficeEngineController,
  createOfficeEngineTool,
  renderOfficeEngineBar,
  type EngineStatus,
} from "./engine-runtime"
import manifest from "../plugin.json"

const status = (state: EngineStatus["state"]): EngineStatus => ({
  state,
  prepared: state === "prepared",
  fingerprint: "sha",
  updatedAt: 1,
  packageManager: "pnpm@11.18.0",
})

function setup() {
  const api = {
    status: jest.fn(async () => status("missing")),
    prepare: jest.fn(async () => status("preparing")),
    probe: jest.fn(async () => ({ ...status("prepared"), probe: { version: "0.1.5" } })),
    cancel: jest.fn(async () => ({
      ...status("failed"),
      error: { code: "CANCELLED", message: "Cancelled" },
    })),
    remove: jest.fn(async () => status("missing")),
  }
  const permissions = {
    hasPermission: jest.fn(() => true),
    requestPermission: jest.fn(async (_permission: string, _reason?: string) => true),
  }
  const t = (key: string, params?: Record<string, string | number>) => {
    let value = (manifest.i18n.locales.en as Record<string, string>)[key] ?? key
    for (const [name, replacement] of Object.entries(params ?? {}))
      value = value.replaceAll(`{${name}}`, String(replacement))
    return value
  }
  const controller = createOfficeEngineController({
    nodeRuntime: api,
    permissions,
    i18n: { t },
  } as never)
  return { api, permissions, controller, t }
}

afterEach(() => jest.useRealTimers())

it("does not install, probe, or inspect the host during construction or toolbar rendering", async () => {
  const { api, controller, t } = setup()
  const bar = renderOfficeEngineBar(controller, t)
  expect(bar.textContent).toContain("never loaded at startup")
  for (const method of Object.values(api)) expect(method).not.toHaveBeenCalled()
  await controller.dispose()
})

it("requests optional permissions only for explicit actions and respects refusal", async () => {
  const { api, permissions, controller } = setup()
  permissions.hasPermission.mockReturnValue(false)
  permissions.requestPermission.mockResolvedValue(false)
  await controller.run("status")
  expect(permissions.requestPermission).not.toHaveBeenCalled()
  await expect(controller.run("prepare")).rejects.toThrow("Permission was not granted")
  expect(api.prepare).not.toHaveBeenCalled()
  expect(controller.error).toContain("Permission was not granted")
  permissions.requestPermission.mockResolvedValue(true)
  await controller.run("prepare")
  expect(permissions.requestPermission.mock.calls.map(([permission]) => permission)).toEqual([
    "shell:execute",
    "shell:execute",
    "network:fetch",
  ])
  await controller.dispose()
  expect(api.cancel).toHaveBeenCalledTimes(1)
})

it("polls only after explicit installation, stops on readiness, and keeps loading explicit", async () => {
  jest.useFakeTimers()
  const { api, controller } = setup()
  api.status.mockResolvedValue(status("prepared"))
  await controller.run("prepare")
  await jest.advanceTimersByTimeAsync(1000)
  expect(controller.status?.prepared).toBe(true)
  expect(api.status).toHaveBeenCalledTimes(1)
  expect(api.probe).not.toHaveBeenCalled()
  await jest.advanceTimersByTimeAsync(5000)
  expect(api.status).toHaveBeenCalledTimes(1)
  await controller.run("probe")
  expect(controller.status?.probe).toEqual({ version: "0.1.5" })
  await controller.run("remove")
  expect(controller.status?.state).toBe("missing")
  await controller.dispose()
})

it("stops automatic polling after a transport error and permits explicit retry", async () => {
  jest.useFakeTimers()
  const { api, controller, t } = setup()
  api.status.mockRejectedValueOnce(new Error("Host disconnected"))
  await controller.run("prepare")
  await jest.advanceTimersByTimeAsync(1000)
  expect(controller.error).toBe("Host disconnected")
  await jest.advanceTimersByTimeAsync(5000)
  expect(api.status).toHaveBeenCalledTimes(1)
  const bar = renderOfficeEngineBar(controller, t)
  expect(bar.querySelector('[data-focus-key="engine:status"]')).toHaveAttribute(
    "aria-disabled",
    "false"
  )
  await controller.run("status")
  expect(controller.error).toBeUndefined()
  await controller.dispose()
})

it("does not let a late poll overwrite cancellation", async () => {
  const { api, controller } = setup()
  await controller.run("prepare")
  let resolve!: (value: EngineStatus) => void
  api.status.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done
      })
  )
  const poll = controller.run("status")
  await controller.run("cancel")
  resolve(status("preparing"))
  await poll
  expect(controller.status?.error?.code).toBe("CANCELLED")
  await controller.dispose()
})

it("cancels a preparation that acknowledges after plugin disposal", async () => {
  const { api, controller } = setup()
  let resolve!: (value: EngineStatus) => void
  api.prepare.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done
      })
  )
  const prepare = controller.run("prepare")
  await controller.dispose()
  resolve(status("preparing"))
  await prepare
  expect(api.cancel).toHaveBeenCalledTimes(1)
  await expect(controller.run("status")).rejects.toThrow("no longer active")
})

it("stops requesting permissions when the plugin is disposed during a grant prompt", async () => {
  const { api, permissions, controller } = setup()
  permissions.hasPermission.mockReturnValue(false)
  let resolve!: (value: boolean) => void
  permissions.requestPermission.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done
      })
  )
  const prepare = controller.run("prepare")
  const rejected = expect(prepare).rejects.toThrow("no longer active")
  await controller.dispose()
  resolve(true)
  await rejected
  expect(permissions.requestPermission).toHaveBeenCalledTimes(1)
  expect(api.prepare).not.toHaveBeenCalled()
})

it("validates Agent action names and exposes real loading through the same controller", async () => {
  const { api, controller } = setup()
  const tool = createOfficeEngineTool(controller)
  await expect(tool.execute({ action: "convert" } as never, {} as never)).rejects.toThrow(
    "Unsupported"
  )
  await tool.execute({ action: "probe" } as never, {} as never)
  expect(api.probe).toHaveBeenCalledTimes(1)
  await controller.dispose()
})
