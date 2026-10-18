import type { AgentProcessHost } from "@cognia/agent-contracts/host"
import type { ExternalAgentConfig } from "@cognia/agent-contracts/external-agent"
import { codexAppServerExtension } from "@cognia/agent-codex/app-server-client"
import { createSiwcAppServerAdapterFactory, isCodexAppServerProtocol } from "./siwc"
import { transport } from "@/lib/tauri"
import { useAccountStore } from "@/stores/account/account-store"

jest.mock("@/lib/tauri", () => ({ isTauri: () => true, transport: { call: jest.fn() } }))
jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: { getState: jest.fn(), subscribe: jest.fn() },
}))
jest.mock("../config/env-builder", () => ({
  buildAgentEnv: jest.fn(() => {
    throw new Error("must not resolve legacy auth")
  }),
}))

const host = (): AgentProcessHost => ({
  available: true,
  spawn: jest.fn(),
  send: jest.fn(),
  kill: jest.fn(async () => undefined),
  commandExists: jest.fn(),
  onStdoutLine: jest.fn(async () => () => {}),
  onStdoutRaw: jest.fn(async () => () => {}),
  onStderr: jest.fn(async () => () => {}),
  onExit: jest.fn(async () => () => {}),
})
const config = (): ExternalAgentConfig => ({
  id: "siwc-agent",
  name: "SIWC",
  protocol: "codex-siwc-app-server",
  transport: "stdio",
  enabled: true,
  process: {
    command: "codex",
    args: ["app-server"],
    env: { OPENAI_API_KEY: "legacy-must-not-leak" },
  },
  metadata: { siwc: { localAccountId: "local-a", connectionId: "registration-a" } },
})

beforeEach(() => {
  jest.clearAllMocks()
  jest.mocked(transport.call).mockResolvedValue(undefined)
  jest.mocked(useAccountStore.getState).mockReturnValue({ unlockedAccountId: "local-a" } as never)
  jest.mocked(useAccountStore.subscribe).mockReturnValue(() => undefined)
})

it("retains a separate protocol while reusing the native Codex extension", () => {
  const adapter = createSiwcAppServerAdapterFactory(host())()
  expect(adapter.protocol).toBe("codex-siwc-app-server")
  expect(codexAppServerExtension.resolve(adapter)).toBe(adapter)
  expect(adapter.isConnected()).toBe(false)
  expect(isCodexAppServerProtocol(adapter.protocol)).toBe(true)
  expect(isCodexAppServerProtocol("codex-app-server")).toBe(true)
  expect(isCodexAppServerProtocol("acp")).toBe(false)
})

it("refuses mismatched local account references before spawn", async () => {
  jest.mocked(useAccountStore.getState).mockReturnValue({ unlockedAccountId: "local-b" } as never)
  const adapter = createSiwcAppServerAdapterFactory(host())()
  await expect(adapter.connect(config())).rejects.toThrow("original unlocked")
  expect(transport.call).not.toHaveBeenCalled()
})

it("passes only a native reference and sandbox scope, never renderer args or legacy secrets", async () => {
  const processHost = host()
  jest.mocked(transport.call).mockRejectedValueOnce(new Error("synthetic spawn stop"))
  const adapter = createSiwcAppServerAdapterFactory(processHost)()
  await expect(adapter.connect(config())).rejects.toThrow("synthetic spawn stop")
  const [command, args] = jest.mocked(transport.call).mock.calls[0]
  expect(command).toBe("siwc_spawn_app_server")
  expect(args).toMatchObject({
    localAccountId: "local-a",
    connectionId: "registration-a",
    config: { id: "siwc-agent", command: "codex" },
  })
  expect(JSON.stringify(args)).not.toMatch(/legacy-must-not-leak|OPENAI_API_KEY|"args"|"env"/)
  expect(processHost.spawn).not.toHaveBeenCalled()
})

it("kills a late spawn after an ABA account switch", async () => {
  const processHost = host()
  let finish!: (value: string) => void
  jest.mocked(transport.call).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve
    }) as never
  )
  const adapter = createSiwcAppServerAdapterFactory(processHost)()
  const connecting = adapter.connect(config())
  await Promise.resolve()
  const listener = jest.mocked(useAccountStore.subscribe).mock.calls[0][0]
  listener({ unlockedAccountId: "local-b" } as never, {} as never)
  listener({ unlockedAccountId: "local-a" } as never, {} as never)
  finish("native-child")
  await expect(connecting).rejects.toThrow("changed during spawn")
  expect(transport.call).toHaveBeenCalledWith("siwc_stop_app_server", {
    localAccountId: "local-a",
    connectionId: "registration-a",
    agentId: "native-child",
  })
  expect(processHost.kill).not.toHaveBeenCalled()
})

it("handshakes and stops only through SIWC-owned native process commands", async () => {
  const processHost = host()
  let stdout!: Parameters<AgentProcessHost["onStdoutLine"]>[0]
  processHost.onStdoutLine = jest.fn(async (listener) => {
    stdout = listener
    return () => {}
  })
  jest.mocked(transport.call).mockImplementation((command, args) => {
    if (command === "siwc_spawn_app_server") return Promise.resolve("native-child") as never
    if (command === "siwc_send_app_server") {
      const request = JSON.parse((args as { message: string }).message) as {
        id?: number
        method?: string
      }
      if (request.id !== undefined)
        queueMicrotask(() =>
          stdout({
            processId: "native-child",
            data: JSON.stringify({
              id: request.id,
              result: request.method === "initialize" ? { userAgent: "codex/0.163.0" } : {},
            }),
          })
        )
    }
    return Promise.resolve(undefined) as never
  })
  const adapter = createSiwcAppServerAdapterFactory(processHost)()
  await adapter.connect(config())
  expect(adapter.isConnected()).toBe(true)
  const sends = jest
    .mocked(transport.call)
    .mock.calls.filter(([command]) => command === "siwc_send_app_server")
  expect(sends[0][1]).toMatchObject({
    localAccountId: "local-a",
    connectionId: "registration-a",
    agentId: "native-child",
  })
  expect(JSON.parse((sends[0][1] as { message: string }).message)).toMatchObject({
    method: "initialize",
    params: { clientInfo: { name: "cognia" } },
  })
  const rebound = config()
  rebound.metadata = { siwc: { localAccountId: "local-a", connectionId: "other-registration" } }
  await expect(adapter.connect(rebound)).rejects.toThrow("before changing")
  await adapter.disconnect()
  expect(transport.call).toHaveBeenCalledWith("siwc_stop_app_server", {
    localAccountId: "local-a",
    connectionId: "registration-a",
    agentId: "native-child",
  })
  expect(processHost.send).not.toHaveBeenCalled()
  expect(processHost.kill).not.toHaveBeenCalled()
})
