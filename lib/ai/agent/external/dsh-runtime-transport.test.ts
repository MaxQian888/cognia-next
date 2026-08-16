import type { ExternalAgentConfig } from "@/types/agent/external-agent"

import {
  DshRuntimeUnavailableError,
  createDshRuntimeTransport,
  loadHarnessClientModule,
  resolveDshLaunchFromConfig,
} from "./dsh-runtime-transport"

// The SDK client is loaded from the installed runtime home by absolute path, so
// there is no specifier to mock: the loader is injected instead.
const harnessState: {
  notifications: unknown[]
  subscribeError?: Error
  /** Hold the notification stream open, as a live runtime does between turns. */
  keepOpen: boolean
  started: number
  closed: number
  initializeParams?: Record<string, unknown>
  promptParams?: Record<string, unknown>
  constructorOptions?: Record<string, unknown>
} = { notifications: [], keepOpen: false, started: 0, closed: 0 }

class FakeHarnessClient {
  constructor(options: Record<string, unknown>) {
    harnessState.constructorOptions = options
  }
  async start() {
    harnessState.started += 1
  }
  async initialize(params: Record<string, unknown>) {
    harnessState.initializeParams = params
    return {}
  }
  async prompt(params: Record<string, unknown>) {
    harnessState.promptParams = params
    return { messageId: "msg-42" }
  }
  subscribe() {
    return {
      async *[Symbol.asyncIterator]() {
        for (const notification of harnessState.notifications) yield notification
        if (harnessState.subscribeError) throw harnessState.subscribeError
        // A live runtime keeps this stream open between turns; ending it
        // means the process is gone, which the transport reports as closed.
        if (harnessState.keepOpen) await new Promise(() => {})
      },
    }
  }
  async close() {
    harnessState.closed += 1
  }
}

const fakeLoader = async () => ({ HarnessClient: FakeHarnessClient }) as never

beforeEach(() => {
  harnessState.notifications = []
  harnessState.keepOpen = false
  harnessState.subscribeError = undefined
  harnessState.started = 0
  harnessState.closed = 0
  harnessState.initializeParams = undefined
  harnessState.promptParams = undefined
  harnessState.constructorOptions = undefined
})

function config(
  process_?: Partial<NonNullable<ExternalAgentConfig["process"]>>
): ExternalAgentConfig {
  return {
    id: "agent-1",
    name: "DSH",
    protocol: "dsh-sdk",
    ...(process_ ? { process: process_ as NonNullable<ExternalAgentConfig["process"]> } : {}),
  } as unknown as ExternalAgentConfig
}

const INSTALLED = {
  command: "/bundled/node",
  args: ["/rt/launcher.mjs", "/rt/host.sdk-readonly.yml"],
  cwd: "/work",
  env: {
    DEEPSEEK_API_KEY: "sk-test-1234567890",
    COGNIA_DSH_WORKSPACE: "/work",
  },
}

describe("resolveDshLaunchFromConfig", () => {
  it("derives the launch spec from an installed config", () => {
    const launch = resolveDshLaunchFromConfig(config(INSTALLED))
    expect(launch).toMatchObject({
      command: "/bundled/node",
      args: ["/rt/launcher.mjs", "/rt/host.sdk-readonly.yml"],
      workspace: "/work",
      provider: "deepseek-official",
      model: "deepseek-v4-flash",
    })
  })

  it("honours a model override from the environment", () => {
    const launch = resolveDshLaunchFromConfig(
      config({ ...INSTALLED, env: { ...INSTALLED.env, COGNIA_DSH_MODEL: "deepseek-v4-pro" } })
    )
    expect(launch.model).toBe("deepseek-v4-pro")
  })

  it("falls back to the process cwd when no workspace variable is set", () => {
    const launch = resolveDshLaunchFromConfig(
      config({ ...INSTALLED, env: { DEEPSEEK_API_KEY: "sk-test-1234567890" } })
    )
    expect(launch.workspace).toBe("/work")
  })

  it("reports an uninstalled agent with an actionable message", () => {
    // Better than letting the spawn fail with ENOENT on an empty command.
    expect(() => resolveDshLaunchFromConfig(config())).toThrow(DshRuntimeUnavailableError)
    expect(() => resolveDshLaunchFromConfig(config())).toThrow(/installer/i)
  })

  it("treats a config with a command but no args as uninstalled", () => {
    expect(() =>
      resolveDshLaunchFromConfig(config({ command: "/bundled/node", args: [] }))
    ).toThrow(DshRuntimeUnavailableError)
  })

  it("refuses to launch when no credential was resolved", () => {
    // Without this the model route fails deep inside the runtime with an opaque
    // provider error, and the cause is no longer attributable.
    expect(() => resolveDshLaunchFromConfig(config({ ...INSTALLED, env: {} }))).toThrow(
      /No DeepSeek credential/
    )
  })
})

describe("createDshRuntimeTransport", () => {
  it("refuses to build a transport in a host that cannot spawn processes", () => {
    // Web and Capacitor have no subprocess; failing here is what keeps the
    // dsh-sdk-client import out of those bundles.
    expect(() =>
      createDshRuntimeTransport(config(INSTALLED), resolveDshLaunchFromConfig, false)
    ).toThrow(DshRuntimeUnavailableError)
    expect(() =>
      createDshRuntimeTransport(config(INSTALLED), resolveDshLaunchFromConfig, false)
    ).toThrow(/desktop \(Tauri\), CLI, and headless/)
  })

  it("builds a transport in a host that can spawn processes", () => {
    const transport = createDshRuntimeTransport(config(INSTALLED), resolveDshLaunchFromConfig, true)
    expect(transport.isRunning()).toBe(false)
  })

  it("does not resolve the launch spec until start", () => {
    // Construction must stay cheap and side-effect free; an uninstalled agent
    // should surface at connect, not when the adapter is merely instantiated.
    expect(() =>
      createDshRuntimeTransport(config(), resolveDshLaunchFromConfig, true)
    ).not.toThrow()
  })

  it("rejects a prompt before the runtime has started", async () => {
    const transport = createDshRuntimeTransport(config(INSTALLED), resolveDshLaunchFromConfig, true)
    await expect(transport.prompt("s1", "hi")).rejects.toThrow(DshRuntimeUnavailableError)
  })

  it("closes idempotently before start", async () => {
    const transport = createDshRuntimeTransport(config(INSTALLED), resolveDshLaunchFromConfig, true)
    await expect(transport.close()).resolves.toBeUndefined()
    await expect(transport.close()).resolves.toBeUndefined()
    expect(transport.isRunning()).toBe(false)
  })

  it("surfaces an uninstalled agent at start rather than at construction", async () => {
    const transport = createDshRuntimeTransport(config(), resolveDshLaunchFromConfig, true)
    await expect(transport.start({ onNotification: () => {}, onClosed: () => {} })).rejects.toThrow(
      DshRuntimeUnavailableError
    )
  })
})

describe("running transport", () => {
  function build() {
    return createDshRuntimeTransport(
      config(INSTALLED),
      resolveDshLaunchFromConfig,
      true,
      fakeLoader
    )
  }
  const noop = { onNotification: () => {}, onClosed: () => {} }

  it("starts the runtime with the resolved launch spec and environment", async () => {
    harnessState.keepOpen = true
    const transport = build()
    await transport.start(noop)
    expect(harnessState.started).toBe(1)
    expect(harnessState.constructorOptions).toMatchObject({
      launch: { command: "/bundled/node", args: INSTALLED.args },
    })
    expect(transport.isRunning()).toBe(true)
  })

  it("initializes with the workspace and model route", async () => {
    await build().start(noop)
    expect(harnessState.initializeParams).toMatchObject({
      cwd: "/work",
      provider: "deepseek-official",
      model: "deepseek-v4-flash",
    })
  })

  it("delivers notifications to the handler", async () => {
    harnessState.notifications = [{ method: "session.status" }, { method: "session.event" }]
    const seen: unknown[] = []
    const transport = build()
    await transport.start({ onNotification: (n) => seen.push(n), onClosed: () => {} })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(seen).toHaveLength(2)
  })

  it("reports a clean stream end as a close", async () => {
    let reason: string | undefined
    await build().start({ onNotification: () => {}, onClosed: (r) => (reason = r) })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(reason).toMatch(/closed its notification stream/)
  })

  it("redacts the API key from a transport failure message", async () => {
    // TransportClosedError carries a bounded stderr tail, which is exactly the
    // kind of text that can contain a leaked key.
    harnessState.subscribeError = new Error(
      "exit 1: DEEPSEEK_API_KEY=sk-test-1234567890 not accepted"
    )
    let reason = ""
    await build().start({ onNotification: () => {}, onClosed: (r) => (reason = r) })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(reason).not.toContain("sk-test-1234567890")
    expect(reason).toContain("[redacted]")
  })

  it("marks the transport stopped once the stream ends", async () => {
    const transport = build()
    await transport.start(noop)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(transport.isRunning()).toBe(false)
  })

  it("sends a prompt as a text content block and returns the admission receipt", async () => {
    // The messageId identifies inbox admission only, never a turn result.
    harnessState.keepOpen = true
    const transport = build()
    await transport.start(noop)
    const messageId = await transport.prompt("s1", "hello")
    expect(messageId).toBe("msg-42")
    expect(harnessState.promptParams).toEqual({
      sessionId: "s1",
      contentBlocks: [{ type: "text", text: "hello" }],
    })
  })

  it("blocks provider-bound prompts that fail the PII gate", async () => {
    harnessState.keepOpen = true
    const transport = build()
    await transport.start(noop)

    await expect(transport.prompt("s1", "Email alice@example.com")).rejects.toThrow(/PII gate/)
    expect(harnessState.promptParams).toBeUndefined()
  })

  it("closes the upstream client and clears retained secrets", async () => {
    harnessState.keepOpen = true
    const transport = build()
    await transport.start(noop)
    await transport.close()
    expect(harnessState.closed).toBe(1)
    expect(transport.isRunning()).toBe(false)
  })

  it("rejects a prompt after close", async () => {
    harnessState.keepOpen = true
    const transport = build()
    await transport.start(noop)
    await transport.close()
    await expect(transport.prompt("s1", "hi")).rejects.toThrow(DshRuntimeUnavailableError)
  })
})

describe("loadHarnessClientModule", () => {
  it("refuses when the launch spec carries no launcher path", async () => {
    await expect(loadHarnessClientModule("/bundled/node", [])).rejects.toThrow(
      DshRuntimeUnavailableError
    )
  })

  it("reports the resolved client path when the runtime is incomplete", async () => {
    // The message must name where it looked, or a broken install is undebuggable.
    await expect(
      loadHarnessClientModule("/bundled/node", ["/nope/launcher.mjs", "/nope/host.yml"])
    ).rejects.toThrow(/nope\/node_modules\/@deepseek-ai\/dsh-sdk-client\/lib\/index\.js/)
  })

  it("suggests reinstalling rather than leaking the underlying loader error alone", async () => {
    await expect(loadHarnessClientModule("/bundled/node", ["/nope/launcher.mjs"])).rejects.toThrow(
      /Reinstall the runtime/
    )
  })

  it("derives the client path from the launcher's own directory", async () => {
    // The runtime home is wherever the launcher lives; nothing else is assumed.
    await expect(
      loadHarnessClientModule("/bundled/node", ["/opt/cognia/dsh/launcher.mjs"])
    ).rejects.toThrow(/\/opt\/cognia\/dsh\/node_modules\//)
  })
})
