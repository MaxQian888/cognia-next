/** @jest-environment node */
import {
  PiRpcClientAdapter,
  PiExtensionHandshakeError,
  PiDisabledError,
  PiOutboundBlockedError,
  PI_KILL_SWITCH_ENV,
  isPiRpcDisabled,
  PI_SYSTEM_PROMPT_ENV,
  buildPiSystemPrompt,
  PiResourceLimitError,
  PiVersionError,
  isCogniaHandshake,
  PI_CERTIFIED_VERSION,
  PiExtensionUnavailableError,
  classifyPiVersion,
  type PiExtensionVerdict,
  clampThinkingLevel,
  extensionPolicyArgs,
  piHandshakeTimeoutMs,
  PI_EXTENSION_HANDSHAKE_TIMEOUT_MS,
  PI_EXTENSION_HANDSHAKE_TIMEOUT_GLOBAL_MS,
  parsePiModel,
  processToolFloor,
  type PiRpcHost,
} from "./pi-rpc-client"
import { PI_AUTH_FORBIDDEN_FLAGS, PI_AUTH_FORBIDDEN_SUBCOMMANDS } from "./pi-auth"
import { encodePiPermissionTitle } from "./pi-permission"
import type {
  ExternalAgentConfig,
  ExternalAgentEvent,
  ExternalAgentMessage,
} from "@/types/agent/external-agent"

// ============================================================================
// Pure helpers
// ============================================================================

describe("classifyPiVersion", () => {
  it("certifies exactly the pinned version", () => {
    expect(classifyPiVersion(PI_CERTIFIED_VERSION)).toEqual({
      status: "certified",
      version: "0.84.3",
    })
    expect(classifyPiVersion(" v0.84.3 ").status).toBe("certified")
  })

  it("allows a newer version but marks it unverified", () => {
    // A Pi upgrade must degrade to a warning, not an outage.
    expect(classifyPiVersion("0.84.4").status).toBe("unverified")
    expect(classifyPiVersion("0.85.0").status).toBe("unverified")
    expect(classifyPiVersion("1.0.0").status).toBe("unverified")
  })

  it("refuses anything below the certified floor", () => {
    for (const version of ["0.84.0", "0.83.9", "0.9.0"]) {
      expect(classifyPiVersion(version)).toMatchObject({
        status: "unsupported",
        reason: "below_certified_version",
      })
    }
  })

  it("refuses a missing or unparseable version", () => {
    expect(classifyPiVersion(null)).toMatchObject({ reason: "no_version_reported" })
    expect(classifyPiVersion("")).toMatchObject({ reason: "no_version_reported" })
    expect(classifyPiVersion("not-a-version")).toMatchObject({ reason: "unparseable_version" })
  })

  it("treats a shorter version as zero-padded, not as newer", () => {
    expect(classifyPiVersion("0.84").status).toBe("unsupported")
    expect(classifyPiVersion("0.85").status).toBe("unverified")
  })
})

describe("clampThinkingLevel", () => {
  /**
   * Pi accepts an unsupported level, answers `success: true`, and silently
   * clamps to `off`. Everything here exists so that never reaches the wire.
   */
  it("passes through a supported level", () => {
    expect(clampThinkingLevel("high", ["off", "high", "max"])).toBe("high")
  })

  it("steps DOWN to the nearest supported level, never up", () => {
    // deepseek-v4-pro really does report exactly this set.
    expect(clampThinkingLevel("medium", ["off", "high", "max"])).toBe("off")
    expect(clampThinkingLevel("xhigh", ["off", "high", "max"])).toBe("high")
  })

  it("returns undefined when nothing is supported or the level is unknown", () => {
    expect(clampThinkingLevel("high", [])).toBeUndefined()
    expect(clampThinkingLevel("nonsense", ["off", "high"])).toBeUndefined()
  })

  it("clamps to the lowest level when the request is below everything offered", () => {
    expect(clampThinkingLevel("off", ["high", "max"])).toBe("high")
  })
})

describe("parsePiModel", () => {
  it("splits provider/model", () => {
    expect(parsePiModel("deepseek/deepseek-v4-pro")).toEqual({
      provider: "deepseek",
      modelId: "deepseek-v4-pro",
    })
  })

  it("keeps a bare id so the active provider is preserved", () => {
    expect(parsePiModel("gpt-4o")).toEqual({ modelId: "gpt-4o" })
    expect(parsePiModel("/leading")).toEqual({ modelId: "/leading" })
  })
})

describe("extensionPolicyArgs", () => {
  /**
   * `--no-extensions` alone is NOT isolation: skills under ~/.agents/skills
   * and Pi's inline extensions still load. Verified against 0.84.3.
   */
  it("isolates skills and prompt templates too, not just extensions", () => {
    expect(extensionPolicyArgs("isolated")).toEqual([
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-approve",
    ])
  })

  it("keeps context files loadable in every policy", () => {
    // AGENTS.md / CLAUDE.md are data, not executable code, and they materially
    // improve results — so --no-context-files must never appear.
    for (const policy of ["isolated", "global", "trusted-project"] as const) {
      expect(extensionPolicyArgs(policy)).not.toContain("--no-context-files")
    }
  })

  it("only trusts project-local files when explicitly asked", () => {
    expect(extensionPolicyArgs("global")).toEqual(["--no-approve"])
    expect(extensionPolicyArgs("trusted-project")).toEqual(["--approve"])
  })
})

describe("piHandshakeTimeoutMs", () => {
  /**
   * `session_start` fires only once every loaded extension has initialised, so
   * the budget has to cover whatever the policy lets load. Measured against Pi
   * 0.84.3 on one real install: 250ms isolated, 5578ms with the user's own
   * stack (an LSP bridge, an MCP client dialing five servers, a background-task
   * poller, a status line, a permission engine). The flat 5s budget refused
   * every Pi session on that machine, about an extension that was loading fine
   * behind somebody else's.
   */
  it("keeps the tight budget only where the startup set is ours", () => {
    expect(piHandshakeTimeoutMs("isolated")).toBe(PI_EXTENSION_HANDSHAKE_TIMEOUT_MS)
    expect(PI_EXTENSION_HANDSHAKE_TIMEOUT_MS).toBe(5000)
  })

  it("allows for a third-party stack under every policy that loads one", () => {
    for (const policy of ["global", "trusted-project"] as const) {
      expect(piHandshakeTimeoutMs(policy)).toBe(PI_EXTENSION_HANDSHAKE_TIMEOUT_GLOBAL_MS)
      // Comfortably past the 5578ms actually measured.
      expect(piHandshakeTimeoutMs(policy)).toBeGreaterThan(6000)
    }
  })

  it("names the policy in the refusal, because the two need different actions", () => {
    expect(new PiExtensionHandshakeError("s1", "isolated").message).not.toContain('isolated"')
    const global = new PiExtensionHandshakeError("s1", "global").message
    expect(global).toContain("30000ms")
    expect(global).toContain("global")
    expect(global).toContain("isolated")
  })
})

describe("processToolFloor", () => {
  it("pins plan mode to read-only tools at the process level", () => {
    expect(processToolFloor("plan", undefined)).toEqual(["read", "grep", "find", "ls"])
  })

  it("restricts dontAsk to the allowlisted builtins", () => {
    expect(processToolFloor("dontAsk", ["read", "write", "not-a-builtin"])).toEqual([
      "read",
      "write",
    ])
    expect(processToolFloor("dontAsk", undefined)).toEqual([])
  })

  it("imposes no process-level floor on the permissive modes while interception is live", () => {
    for (const mode of ["default", "acceptEdits", "bypassPermissions", undefined]) {
      expect(processToolFloor(mode, ["read"])).toEqual([])
    }
  })

  /**
   * Pi ships no permission prompts of its own — its tools run with the full
   * rights of the process. So `default` / `acceptEdits` only mean anything
   * while the bundled extension is intercepting `tool_call`. Without it, an
   * empty floor would silently permit `edit` / `write` / `bash`: the exact
   * silent bypass this layer exists to prevent.
   */
  it("collapses the asking modes to read-only when nothing can intercept", () => {
    for (const mode of ["default", "acceptEdits", undefined]) {
      expect(processToolFloor(mode, ["read"], { interceptionAvailable: false })).toEqual([
        "read",
        "grep",
        "find",
        "ls",
      ])
    }
  })

  it("leaves bypassPermissions alone without interception", () => {
    // The user explicitly opted out of prompts, and the strict sandbox still
    // contains the process.
    expect(processToolFloor("bypassPermissions", [], { interceptionAvailable: false })).toEqual([])
  })

  it("keeps plan and dontAsk unchanged either way — neither ever asked", () => {
    for (const intercepted of [true, false]) {
      expect(processToolFloor("plan", [], { interceptionAvailable: intercepted })).toEqual([
        "read",
        "grep",
        "find",
        "ls",
      ])
      expect(
        processToolFloor("dontAsk", ["read", "bash"], { interceptionAvailable: intercepted })
      ).toEqual(["read", "bash"])
    }
  })
})

// ============================================================================
// Adapter, against a fake host
// ============================================================================

interface FakeHost extends PiRpcHost {
  spawns: Array<{
    id: string
    command: string
    args: string[]
    framing?: string
    env?: Record<string, string>
  }>
  sent: Array<{ agentId: string; message: string }>
  killed: string[]
  /** Every `list_pi_sessions` host call, by its args. */
  listSessionCalls: Array<Record<string, unknown>>
  /** What the host answers `list_pi_sessions` with. */
  setListedSessions(value: unknown): void
  emitStdout(agentId: string, text: string): void
  /**
   * Emit the way the Rust host does: one `external-agent://stdout` event per
   * line, with the trailing `\n` already stripped by `BufReader::lines()`.
   */
  emitStdoutLines(agentId: string, text: string): void
  emitExit(agentId: string, code?: number): void
  emitVersion(agentId: string, version: string): void
  lastCommand(type: string): Record<string, unknown> | undefined
  /**
   * The last frame of `type` written to the wire, whatever its shape.
   *
   * `lastCommand` matches on the `type` field too, but is meant for correlated
   * commands; `extension_ui_response` is an uncorrelated frame whose `id` is
   * the dialog id, so it needs its own accessor to stay readable.
   */
  lastFrame(type: string): Record<string, unknown> | undefined
}

/** Commands the fake answers on its own, mirroring Pi's own behaviour. */
const AUTO_REPLY = new Map<string, unknown>([
  ["abort", null],
  ["get_session_stats", { tokens: { input: 1, output: 1, total: 2 } }],
])

/**
 * A verified extension, which is what every real host reports on a healthy
 * install. The adapter now refuses to start a session without one, so this is
 * the default rather than something each test opts into.
 */
const VERIFIED_EXTENSION: PiExtensionVerdict = {
  status: "ok",
  path: "/opt/cognia/sidecar/pi-extension/cognia-pi-extension.ts",
  sha256: "d1g3st",
}

interface FakeHostOptions {
  /** What `resolve_pi_extension` answers on a host that implements it. */
  extensionVerdict?: PiExtensionVerdict
  /**
   * Simulate a host with no `resolve_pi_extension` arm at all (an older CLI).
   * A separate flag rather than `extensionVerdict: undefined`, because a
   * destructuring default treats an explicit `undefined` as "not passed".
   */
  resolverUnsupported?: boolean
  /**
   * Whether the fake extension announces itself. A healthy install always does,
   * and the adapter now refuses any session that cannot prove interception is
   * live, so this is the default. Tests for the refusal path pass `false`.
   */
  autoHandshake?: boolean
  /**
   * Which stdout framing this fake host speaks. A real host speaks exactly one
   * for the whole session, so the auto-emitted frames must use it too — an
   * auto-handshake on `stdout-raw` would latch the adapter to raw and make a
   * line-framing test silently exercise the raw path.
   */
  framing?: "raw" | "line"
  /**
   * Commands the fake refuses instead of auto-answering. Used to prove that a
   * failed side query (usage stats) still lets the turn complete.
   */
  failCommands?: readonly string[]
}

function createFakeHost(options: FakeHostOptions = {}): FakeHost {
  const {
    extensionVerdict = VERIFIED_EXTENSION,
    resolverUnsupported = false,
    autoHandshake = true,
    framing = "raw",
    failCommands = [],
  } = options
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  const spawns: FakeHost["spawns"] = []
  const listSessionCalls: Array<Record<string, unknown>> = []
  let listedSessions: unknown = []
  const sent: FakeHost["sent"] = []
  const killed: string[] = []

  const emit = (channel: string, payload: unknown) => {
    for (const handler of listeners.get(channel) ?? []) handler(payload)
  }

  /** Emit one complete `\n`-terminated frame in this host's own framing. */
  const emitFrame = (agentId: string, text: string) => {
    if (framing === "line") {
      for (const line of text.split("\n")) {
        if (line === "") continue
        emit("external-agent://stdout", { agentId, data: line })
      }
      return
    }
    emit("external-agent://stdout-raw", {
      agentId,
      data: Buffer.from(text, "utf8").toString("base64"),
    })
  }

  return {
    spawns,
    sent,
    killed,
    listSessionCalls,
    setListedSessions(value: unknown) {
      listedSessions = value
    },
    async invoke<T>(name: string, args: Record<string, unknown>): Promise<T> {
      if (name === "list_pi_sessions") {
        listSessionCalls.push(args)
        return listedSessions as T
      }
      if (name === "resolve_pi_extension") {
        // A host that does not implement the command at all (an older CLI)
        // throws, exactly as `agentInvoke` would.
        if (resolverUnsupported) throw new Error("unsupported external-agent command")
        return extensionVerdict as T
      }
      if (name === "spawn_external_agent") {
        const config = args.config as {
          id: string
          command: string
          args?: string[]
          framing?: string
          env?: Record<string, string>
        }
        spawns.push({
          id: config.id,
          command: config.command,
          args: config.args ?? [],
          framing: config.framing,
          env: config.env,
        })
        // A loaded extension announces itself on `session_start`. Doing it here
        // — rather than in each test — mirrors a healthy install and keeps the
        // now-unconditional handshake gate from costing every session test the
        // full 5s timeout. Version probes carry no `-e`, so they are skipped.
        if (autoHandshake && (config.args ?? []).includes("-e")) {
          queueMicrotask(() =>
            emitFrame(
              config.id,
              JSON.stringify({
                type: "extension_ui_request",
                id: "handshake",
                method: "setStatus",
                statusKey: "cognia",
                statusText: "cognia-ready v1 mode=default toolhost=off",
              }) + "\n"
            )
          )
        }
        return config.id as T
      }
      if (name === "send_to_external_agent") {
        const agentId = String(args.agentId)
        const message = String(args.message)
        sent.push({ agentId, message })
        // Real Pi answers these promptly and unconditionally. Auto-replying
        // keeps teardown paths from sitting out the adapter's 5s abort grace
        // period in every test that closes a session.
        const frame = JSON.parse(message) as { type: string; id: string }
        if (AUTO_REPLY.has(frame.type)) {
          const failed = failCommands.includes(frame.type)
          queueMicrotask(() =>
            emitFrame(
              agentId,
              JSON.stringify({
                id: frame.id,
                type: "response",
                command: frame.type,
                success: !failed,
                ...(failed
                  ? { error: `${frame.type} unavailable` }
                  : { data: AUTO_REPLY.get(frame.type) }),
              }) + "\n"
            )
          )
        }
        return undefined as T
      }
      if (name === "kill_external_agent") {
        killed.push(String(args.agentId))
        return undefined as T
      }
      throw new Error(`unexpected invoke: ${name}`)
    },
    async listen<T>(channel: string, handler: (payload: T) => void): Promise<() => void> {
      const set = listeners.get(channel) ?? new Set()
      listeners.set(channel, set)
      set.add(handler as (payload: unknown) => void)
      return () => set.delete(handler as (payload: unknown) => void)
    },
    emitStdout(agentId, text) {
      emit("external-agent://stdout-raw", {
        agentId,
        data: Buffer.from(text, "utf8").toString("base64"),
      })
    },
    emitStdoutLines(agentId, text) {
      for (const line of text.split("\n")) {
        if (line === "") continue
        emit("external-agent://stdout", { agentId, data: line })
      }
    },
    emitExit(agentId, code = 0) {
      emit("external-agent://exit", { agentId, code })
    },
    emitVersion(agentId, version) {
      emit("external-agent://stdout", { agentId, data: version })
      emit("external-agent://exit", { agentId, code: 0 })
    },
    lastCommand(type) {
      for (let i = sent.length - 1; i >= 0; i--) {
        const parsed = JSON.parse(sent[i].message) as Record<string, unknown>
        if (parsed.type === type) return parsed
      }
      return undefined
    },
    lastFrame(type) {
      for (let i = sent.length - 1; i >= 0; i--) {
        const parsed = JSON.parse(sent[i].message) as Record<string, unknown>
        if (parsed.type === type) return parsed
      }
      return undefined
    },
  }
}

const config: ExternalAgentConfig = {
  id: "agent-1",
  name: "Pi",
  protocol: "pi-rpc",
  transport: "stdio",
  enabled: true,
  process: { command: "pi", args: ["--mode", "rpc"] },
}

/** Answer the next command of `type` on the fake wire. */
function replyTo(
  host: FakeHost,
  type: string,
  data: unknown = null,
  options: { success?: boolean; error?: string; framing?: "raw" | "line" } = {}
): boolean {
  for (let i = host.sent.length - 1; i >= 0; i--) {
    const frame = JSON.parse(host.sent[i].message) as { type: string; id: string }
    if (frame.type !== type) continue
    // A host speaks ONE framing for the whole session — replies included. The
    // adapter latches on the first raw frame, so a line-framed test whose
    // replies arrived as raw would silently exercise the raw path instead.
    const emitFrame = options.framing === "line" ? host.emitStdoutLines : host.emitStdout
    emitFrame(
      host.sent[i].agentId,
      JSON.stringify({
        id: frame.id,
        type: "response",
        command: type,
        success: options.success ?? true,
        data,
        error: options.error,
      }) + "\n"
    )
    return true
  }
  return false
}

async function connected(host: FakeHost, version = PI_CERTIFIED_VERSION) {
  const adapter = new PiRpcClientAdapter({
    host,
    generateSessionId: (() => {
      let n = 0
      return () => `sess-${++n}`
    })(),
  })
  const connecting = adapter.connect(config)
  await Promise.resolve()
  // The probe spawns `pi --version` and waits for its exit.
  const probe = host.spawns.find((s) => s.args.includes("--version"))
  if (probe) host.emitVersion(probe.id, version)
  await connecting
  return adapter
}

describe("credential diagnostics", () => {
  /**
   * Drive one non-RPC probe: wait for its spawn, answer it, and hand back both
   * the adapter's result and the argv it was actually launched with.
   *
   * The argv matters as much as the verdict here — the whole reason ADR-0119
   * routes this through `pi auth check` is that the two sibling subcommands
   * print the credential itself.
   */
  async function runProbe<T>(
    start: (adapter: PiRpcClientAdapter) => Promise<T>,
    match: (args: string[]) => boolean,
    reply: { stdout: string; code?: number }
  ): Promise<{ result: T; args: string[] }> {
    const host = createFakeHost()
    const adapter = new PiRpcClientAdapter({ host })
    const connecting = adapter.connect(config)
    await Promise.resolve()
    host.emitVersion(
      host.spawns.find((s) => s.args.includes("--version"))!.id,
      PI_CERTIFIED_VERSION
    )
    await connecting

    const pending = start(adapter)
    await Promise.resolve()
    const spawn = host.spawns.find((s) => match(s.args))!
    expect(spawn).toBeDefined()
    host.emitStdoutLines(spawn.id, reply.stdout)
    host.emitExit(spawn.id, reply.code ?? 0)
    return { result: await pending, args: spawn.args }
  }

  const authArgs = (args: string[]) => args[0] === "auth"

  it("asks Pi about one provider, read-only, and reports the verdict", async () => {
    const { result, args } = await runProbe(
      (adapter) => adapter.checkProviderAuth("deepseek"),
      authArgs,
      { stdout: '{"status":"ready","provider":"deepseek","authType":"api_key"}', code: 0 }
    )
    expect(args).toEqual(["auth", "check", "--provider", "deepseek", "--json", "--no-refresh"])
    expect(result).toEqual({ status: "ready", provider: "deepseek", authType: "api_key" })
  })

  it("never spawns a subcommand that prints the credential", async () => {
    const { args } = await runProbe((adapter) => adapter.checkProviderAuth("anthropic"), authArgs, {
      stdout: '{"status":"not_ready","provider":"anthropic","reason":"credentials_not_configured"}',
      code: 1,
    })
    for (const banned of [...PI_AUTH_FORBIDDEN_SUBCOMMANDS, ...PI_AUTH_FORBIDDEN_FLAGS]) {
      expect(args).not.toContain(banned)
    }
    // `--no-refresh` is the flag that makes Pi open its credential store
    // read-only. Losing it would let a diagnostic rotate the user's tokens.
    expect(args).toContain("--no-refresh")
  })

  it("keeps the requested provider when Pi answers without one", async () => {
    const { result } = await runProbe((adapter) => adapter.checkProviderAuth("groq"), authArgs, {
      stdout: '{"status":"ready"}',
      code: 0,
    })
    expect(result).toEqual({ status: "ready", provider: "groq" })
  })

  it("reports a usage error as unreadable, not as missing credentials", async () => {
    // Pi writes its argument errors to stderr and leaves stdout empty even
    // under `--json`, while still exiting 1 — the exact shape that would read
    // as `not_ready` if the exit code were trusted.
    const { result } = await runProbe(
      (adapter) => adapter.checkProviderAuth("deepseek"),
      authArgs,
      { stdout: "", code: 1 }
    )
    expect(result).toEqual({
      status: "unreadable",
      provider: "deepseek",
      unreadableReason: "no_output",
    })
  })

  it("lists the providers Pi can actually reach", async () => {
    const { result, args } = await runProbe(
      (adapter) => adapter.listModelProviders(),
      (a) => a.includes("--list-models"),
      {
        stdout: [
          "provider  model            context  max-out  thinking  images",
          "deepseek  deepseek-v4-pro  1M       384K     yes       no",
          "deepseek  deepseek-v4-flash  1M     384K     yes       no",
        ].join("\n"),
      }
    )
    // The isolation flags travel with the probe: the listing has to describe
    // the process the session will actually be, not the user's whole stack.
    expect(args).toEqual([
      "--list-models",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-approve",
    ])
    expect(result).toEqual({ status: "ok", providers: ["deepseek"] })
  })

  it("refuses to guess when the adapter never connected", async () => {
    const adapter = new PiRpcClientAdapter({ host: createFakeHost() })
    // No spawn may happen: there is no resolved command to spawn.
    await expect(adapter.checkProviderAuth("deepseek")).resolves.toMatchObject({
      status: "unreadable",
    })
    await expect(adapter.listModelProviders()).resolves.toEqual({ status: "unreadable" })
  })
})

describe("protocol registration", () => {
  /**
   * The `dsh-sdk` trap this integration had to avoid: a protocol can be in the
   * type union, the permission table, the supported list and a preset while
   * `registerDefaultAdapters()` never registers its adapter — so `addAgent`
   * throws `Unsupported protocol` only at the point of use. Importing the
   * manager here proves the registration actually ran.
   */
  it("is registered as a built-in adapter, not merely declared", async () => {
    const { protocolAdapterRegistry } = await import("./protocol-adapter")
    await import("./manager")
    const { ExternalAgentManager } = await import("./manager")
    ExternalAgentManager.getInstance()

    expect(protocolAdapterRegistry.has("pi-rpc")).toBe(true)
    expect(protocolAdapterRegistry.create("pi-rpc")?.protocol).toBe("pi-rpc")
  })

  it("declares itself in the supported protocol list", async () => {
    const { SUPPORTED_EXTERNAL_AGENT_PROTOCOLS } = await import("./config-normalizer")
    expect([...SUPPORTED_EXTERNAL_AGENT_PROTOCOLS]).toContain("pi-rpc")
  })
})

describe("PiRpcClientAdapter — connect", () => {
  it("probes the version through the sandboxed spawn path", async () => {
    const host = createFakeHost()
    await connected(host)
    const probe = host.spawns.find((s) => s.args.includes("--version"))
    expect(probe).toBeDefined()
    expect(probe!.command).toBe("pi")
  })

  it("connects on the certified version", async () => {
    const host = createFakeHost()
    const adapter = await connected(host)
    expect(adapter.isConnected()).toBe(true)
    expect(adapter.versionStatus).toMatchObject({ status: "certified" })
  })

  it("connects on a newer version but records it as unverified", async () => {
    const host = createFakeHost()
    const adapter = await connected(host, "0.85.0")
    expect(adapter.isConnected()).toBe(true)
    expect(adapter.versionStatus).toMatchObject({ status: "unverified", version: "0.85.0" })
  })

  it("refuses an older version and reports the diagnostic reason code", async () => {
    const host = createFakeHost()
    const adapter = new PiRpcClientAdapter({ host })
    const connecting = adapter.connect(config)
    await Promise.resolve()
    const probe = host.spawns.find((s) => s.args.includes("--version"))!
    host.emitVersion(probe.id, "0.83.0")

    await expect(connecting).rejects.toBeInstanceOf(PiVersionError)
    await expect(connecting).rejects.toMatchObject({ reasonCode: "runtime_version_unsupported" })
    expect(adapter.isConnected()).toBe(false)
  })
})

describe("PiRpcClientAdapter — sessions", () => {
  it("spawns one raw-framed process per session with the isolation flags", async () => {
    const host = createFakeHost()
    const adapter = await connected(host)
    await adapter.createSession({ cwd: "/w" })

    const spawn = host.spawns.find((s) => s.args.includes("--session-id"))!
    expect(spawn.framing).toBe("raw")
    expect(spawn.args).toEqual(
      expect.arrayContaining([
        "--mode",
        "rpc",
        "--session-id",
        "sess-1",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-approve",
      ])
    )
  })

  it("pins the read-only tool floor in plan mode", async () => {
    const host = createFakeHost()
    const adapter = await connected(host)
    await adapter.createSession({ cwd: "/w", permissionMode: "plan" })
    const spawn = host.spawns.find((s) => s.args.includes("--session-id"))!
    expect(spawn.args).toEqual(expect.arrayContaining(["--tools", "read,grep,find,ls"]))
  })

  it("gives each session its own process and never shares one", async () => {
    const host = createFakeHost()
    const adapter = await connected(host)
    await adapter.createSession({ cwd: "/a" })
    await adapter.createSession({ cwd: "/b" })

    const sessionSpawns = host.spawns.filter((s) => s.args.includes("--session-id"))
    expect(sessionSpawns).toHaveLength(2)
    expect(new Set(sessionSpawns.map((s) => s.id)).size).toBe(2)
    // Sharing a process would interleave two conversations on one stream.
    expect(host.sent.every((s) => !JSON.parse(s.message).type?.includes("switch_session"))).toBe(
      true
    )
  })

  it("resumes by re-passing the same --session-id", async () => {
    const host = createFakeHost()
    const adapter = await connected(host)
    await adapter.createSession({ cwd: "/w" })
    await adapter.closeSession("sess-1")

    await adapter.resumeSession("sess-1")
    const resumed = host.spawns.filter((s) => s.args.includes("sess-1"))
    expect(resumed.length).toBeGreaterThanOrEqual(2)
  })

  it("forks into a new session id via --fork", async () => {
    const host = createFakeHost()
    const adapter = await connected(host)
    await adapter.createSession({ cwd: "/w" })
    const forked = await adapter.forkSession("sess-1")

    expect(forked.id).toBe("sess-2")
    const spawn = host.spawns.find((s) => s.args.includes("--fork"))!
    expect(spawn.args).toEqual(
      expect.arrayContaining(["--fork", "sess-1", "--session-id", "sess-2"])
    )
    expect(forked.metadata?.forkedFrom).toBe("sess-1")
  })

  it("stores only the session id, cwd and version — never a session file path", async () => {
    const host = createFakeHost()
    const adapter = await connected(host)
    const session = await adapter.createSession({ cwd: "/w" })
    expect(session.metadata).toMatchObject({
      piSessionId: "sess-1",
      piVersion: "0.84.3",
      cwd: "/w",
    })
    expect(JSON.stringify(session.metadata)).not.toMatch(/\.jsonl/)
  })

  it("reclaims the least-recently-used idle process at the cap", async () => {
    const host = createFakeHost()
    const adapter = new PiRpcClientAdapter({
      host,
      maxProcesses: 2,
      generateSessionId: (() => {
        let n = 0
        return () => `s${++n}`
      })(),
    })
    const connecting = adapter.connect(config)
    await Promise.resolve()
    host.emitVersion(host.spawns[0].id, PI_CERTIFIED_VERSION)
    await connecting

    await adapter.createSession({ cwd: "/a" })
    await adapter.createSession({ cwd: "/b" })
    await adapter.createSession({ cwd: "/c" })

    // s1 was idle and oldest, so it made way rather than the cap being ignored.
    expect(adapter.getSession("s1")).toBeUndefined()
    expect(adapter.getSession("s3")).toBeDefined()
  })
})

describe("PiRpcClientAdapter — bundled extension", () => {
  const withExtension: ExternalAgentConfig = {
    ...config,
    metadata: { piExtensionPath: "/opt/cognia/cognia-pi-extension.ts" },
  }

  async function connectWithExtension(host: FakeHost) {
    const adapter = new PiRpcClientAdapter({
      host,
      generateSessionId: (() => {
        let n = 0
        return () => `sess-${++n}`
      })(),
    })
    const connecting = adapter.connect(withExtension)
    await Promise.resolve()
    host.emitVersion(host.spawns[0].id, PI_CERTIFIED_VERSION)
    await connecting
    return adapter
  }

  /** Poll until the session process appears, rather than counting microtasks. */
  async function awaitSessionSpawn(host: FakeHost) {
    for (let i = 0; i < 50; i++) {
      const spawn = host.spawns.find((s) => s.args.includes("--session-id"))
      if (spawn) return spawn
      await Promise.resolve()
    }
    throw new Error("session process never spawned")
  }

  const handshake = (agentId: string, host: FakeHost) =>
    host.emitStdout(
      agentId,
      JSON.stringify({
        type: "extension_ui_request",
        id: "u1",
        method: "setStatus",
        statusKey: "cognia",
        statusText: "cognia-ready v1 mode=default toolhost=on",
      }) + "\n"
    )

  it("loads the bundled extension with -e, which survives --no-extensions", async () => {
    // `-e` is explicitly exempt from `--no-extensions`, which is what makes
    // isolation workable: the user's stack stays off, Cognia's stays on.
    const host = createFakeHost()
    const adapter = await connectWithExtension(host)
    const creating = adapter.createSession({ cwd: "/w" })
    const spawn = await awaitSessionSpawn(host)
    expect(spawn.args).toEqual(
      expect.arrayContaining(["--no-extensions", "-e", "/opt/cognia/cognia-pi-extension.ts"])
    )
    handshake(spawn.id, host)
    await creating
  })

  it("hands the resolved policy to the extension as env, not as logic", async () => {
    const host = createFakeHost()
    const adapter = await connectWithExtension(host)
    const creating = adapter.createSession({ cwd: "/w", permissionMode: "plan" })
    const spawn = await awaitSessionSpawn(host)
    handshake(spawn.id, host)
    await creating

    const policy = JSON.parse(spawn.env?.COGNIA_TOOLHOST_PI_POLICY ?? "{}")
    expect(policy.mode).toBe("plan")
    expect(policy.decisions.bash).toBe("deny")
    expect(policy.decisions.read).toBe("allow")
  })

  /**
   * The extension enforces the native-tool matrix, so a session that cannot
   * prove it loaded must be refused rather than run ungated.
   */
  it("refuses the session when the extension never reports ready", async () => {
    jest.useFakeTimers()
    try {
      const host = createFakeHost({ autoHandshake: false })
      const adapter = await connectWithExtension(host)
      const creating = adapter.createSession({ cwd: "/w" })
      const assertion = expect(creating).rejects.toBeInstanceOf(PiExtensionHandshakeError)
      await jest.advanceTimersByTimeAsync(6000)
      await assertion
    } finally {
      jest.useRealTimers()
    }
  })

  /**
   * The end-to-end form of the same guarantee: with no extension resolved,
   * a `default`-mode session must not spawn Pi with `edit` / `write` / `bash`
   * loaded, because nothing would be able to ask before they run.
   */
  /**
   * Previously this spawned a read-only session instead. That was the wrong
   * shape of safety: it left the user with an agent that silently could not
   * edit anything, and it rested on `--tools` alone while the component that
   * enforces the permission MATRIX was absent. A session that cannot intercept
   * `tool_call` is now refused outright, before any process exists.
   */
  it("refuses the session outright when no extension is available", async () => {
    const host = createFakeHost({ extensionVerdict: { status: "missing" } })
    const adapter = await connected(host)

    await expect(
      adapter.createSession({ cwd: "/w", permissionMode: "default" })
    ).rejects.toBeInstanceOf(PiExtensionUnavailableError)
    // Nothing was spawned: the refusal happens before `spawn_external_agent`.
    expect(host.spawns.filter((s) => s.args.includes("--session-id"))).toHaveLength(0)
  })

  it("refuses an extension that cannot be verified, naming the cause", async () => {
    for (const verdict of [
      { status: "unpinned" as const, path: "/a", sha256: "x" },
      { status: "tampered" as const, path: "/a", expected: "x", actual: "y" },
      { status: "unreadable" as const, path: "/a", detail: "EACCES" },
    ]) {
      const host = createFakeHost({ extensionVerdict: verdict })
      const adapter = await connected(host)
      await expect(adapter.createSession({ cwd: "/w" })).rejects.toThrow(/Cognia Pi extension/)
    }
  })

  /**
   * A host too old to answer `resolve_pi_extension` must not silently become a
   * host that runs Pi unintercepted.
   */
  it("refuses when the host cannot answer the resolver at all", async () => {
    const host = createFakeHost({ resolverUnsupported: true })
    const adapter = await connected(host)
    await expect(adapter.createSession({ cwd: "/w" })).rejects.toBeInstanceOf(
      PiExtensionUnavailableError
    )
  })
})

describe("isCogniaHandshake", () => {
  it("accepts the bundled extension's own status line", () => {
    expect(
      isCogniaHandshake({
        type: "extension_ui_request",
        method: "setStatus",
        statusKey: "cognia",
        statusText: "cognia-ready v1 mode=default toolhost=on",
      })
    ).toBe(true)
  })

  /**
   * Verified by running the bundled extension under real Pi 0.84.3: the wire
   * fields are `statusKey`/`statusText`, NOT `text`/`title`. Matching the
   * wrong field made the gate silently unsatisfiable.
   */
  it("reads the real statusText field, not a generic text field", () => {
    expect(
      isCogniaHandshake({
        type: "extension_ui_request",
        method: "setStatus",
        text: "cognia-ready v1",
      })
    ).toBe(false)
  })

  it("ignores another extension's status line", () => {
    // Matching on any status at all would let an unrelated extension satisfy
    // Cognia's gate.
    expect(
      isCogniaHandshake({
        type: "extension_ui_request",
        method: "setStatus",
        statusKey: "lsp",
        statusText: "lsp ready",
      })
    ).toBe(false)
    expect(isCogniaHandshake({ type: "extension_ui_request", method: "notify" })).toBe(false)
    expect(isCogniaHandshake({ type: "message_start" })).toBe(false)
  })
})

describe("buildPiSystemPrompt", () => {
  it("joins the system prompt, envelope and brief-mode instruction", () => {
    const prompt = buildPiSystemPrompt({
      systemPrompt: "You are Cognia.",
      instructionEnvelope: {
        hash: "h",
        developerInstructions: "Follow the repo rules.",
        projectContextSummary: "A Next.js app.",
      },
      briefMode: true,
    })!
    expect(prompt).toContain("You are Cognia.")
    expect(prompt).toContain("Follow the repo rules.")
    expect(prompt).toContain("A Next.js app.")
    expect(prompt).toContain("Answer concisely.")
  })

  it("returns nothing when there is nothing to inject", () => {
    expect(buildPiSystemPrompt({})).toBeUndefined()
    expect(buildPiSystemPrompt({ systemPrompt: "   " })).toBeUndefined()
  })

  /**
   * The gate has to run BEFORE the value reaches the spawn config: once it is
   * in the process env it has already crossed the boundary.
   */
  it("refuses to send a prompt that would leak PII", () => {
    expect(() =>
      buildPiSystemPrompt({ systemPrompt: "Email the user at alice.smith@example.com" })
    ).toThrow(PiOutboundBlockedError)
  })

  it("blocks the session rather than spawning with a leaking prompt", async () => {
    const host = createFakeHost()
    const adapter = await connected(host)
    const before = host.spawns.length
    await expect(
      adapter.createSession({ cwd: "/w", systemPrompt: "card 4111 1111 1111 1111" })
    ).rejects.toBeInstanceOf(PiOutboundBlockedError)
    // Nothing was spawned, so nothing crossed the boundary.
    expect(host.spawns.length).toBe(before)
  })

  it("passes a clean prompt to the extension through the allowlisted env", async () => {
    const host = createFakeHost()
    const adapter = await connected(host)
    await adapter.createSession({ cwd: "/w", systemPrompt: "Be helpful." })
    const spawn = host.spawns.find((s) => s.args.includes("--session-id"))!
    expect(spawn.env?.[PI_SYSTEM_PROMPT_ENV]).toContain("Be helpful.")
    expect(PI_SYSTEM_PROMPT_ENV.startsWith("COGNIA_TOOLHOST_")).toBe(true)
  })
})

describe("kill switch", () => {
  const original = process.env[PI_KILL_SWITCH_ENV]
  afterEach(() => {
    if (original === undefined) delete process.env[PI_KILL_SWITCH_ENV]
    else process.env[PI_KILL_SWITCH_ENV] = original
  })

  it("reads the documented truthy spellings only", () => {
    // This repo's `ProcessEnv` requires NODE_ENV, so build envs explicitly.
    const env = (value?: string) =>
      ({ NODE_ENV: "test", [PI_KILL_SWITCH_ENV]: value }) as NodeJS.ProcessEnv
    for (const value of ["1", "true", "TRUE", "yes"]) {
      expect(isPiRpcDisabled(env(value))).toBe(true)
    }
    for (const value of ["0", "false", "", "off", undefined]) {
      expect(isPiRpcDisabled(env(value))).toBe(false)
    }
  })

  it("blocks a new session while it is engaged", async () => {
    const host = createFakeHost()
    const adapter = await connected(host)
    process.env[PI_KILL_SWITCH_ENV] = "1"
    await expect(adapter.createSession({ cwd: "/w" })).rejects.toBeInstanceOf(PiDisabledError)
  })

  /**
   * Deliberately does NOT kill live sessions: terminating a turn mid-tool-call
   * can leave a half-written file behind, which is worse than letting it end.
   */
  it("leaves an already-running session alone", async () => {
    const host = createFakeHost()
    const adapter = await connected(host)
    const session = await adapter.createSession({ cwd: "/w" })

    process.env[PI_KILL_SWITCH_ENV] = "1"
    expect(adapter.getSession(session.id)).toBeDefined()
    const steering = adapter.steerTurn(session.id, "keep going")
    await Promise.resolve()
    replyTo(host, "steer")
    await expect(steering).resolves.toBeUndefined()
  })

  it("is re-read per session, so no restart is needed", async () => {
    const host = createFakeHost()
    const adapter = await connected(host)
    process.env[PI_KILL_SWITCH_ENV] = "1"
    await expect(adapter.createSession({ cwd: "/a" })).rejects.toBeInstanceOf(PiDisabledError)
    delete process.env[PI_KILL_SWITCH_ENV]
    await expect(adapter.createSession({ cwd: "/b" })).resolves.toBeDefined()
  })
})

describe("PiRpcClientAdapter — streaming", () => {
  const message: ExternalAgentMessage = {
    id: "m1",
    role: "user",
    content: [{ type: "text", text: "hi" }],
    timestamp: new Date(),
  }

  async function startTurn(host: FakeHost, framing: "raw" | "line" = "raw") {
    const adapter = await connected(host)
    await adapter.createSession({ cwd: "/w" })
    const events: string[] = []
    const iterator = (async () => {
      for await (const event of adapter.prompt("sess-1", message)) events.push(event.type)
      return events
    })()
    // Let `prompt` reach the wire, then acknowledge it.
    await Promise.resolve()
    await Promise.resolve()
    replyTo(host, "prompt", null, { framing })
    return { adapter, events, iterator, agentId: "agent-1:sess-1" }
  }

  it("blocks a user turn containing PII before it reaches Pi", async () => {
    const host = createFakeHost()
    const adapter = await connected(host)
    await adapter.createSession({ cwd: "/w" })
    const leakingMessage: ExternalAgentMessage = {
      id: "m-pii",
      role: "user",
      content: [{ type: "text", text: "Email alice.smith@example.com" }],
      timestamp: new Date(),
    }

    await expect(
      adapter.prompt("sess-1", leakingMessage)[Symbol.asyncIterator]().next()
    ).rejects.toBeInstanceOf(PiOutboundBlockedError)
    expect(host.lastCommand("prompt")).toBeUndefined()
  })

  it("forwards base64 image blocks through Pi's native RPC image field", async () => {
    const host = createFakeHost()
    const adapter = await connected(host)
    await adapter.createSession({ cwd: "/w" })
    const imageMessage: ExternalAgentMessage = {
      id: "m-image",
      role: "user",
      content: [
        { type: "text", text: "describe this" },
        {
          type: "image",
          source: { type: "base64", data: "aW1hZ2U=", mediaType: "image/png" },
        },
      ],
      timestamp: new Date(),
    }
    const iterator = (async () => {
      for await (const _event of adapter.prompt("sess-1", imageMessage)) {
        // Drain the turn to release its queue.
      }
    })()

    await Promise.resolve()
    await Promise.resolve()
    expect(host.lastCommand("prompt")).toMatchObject({
      message: "describe this",
      images: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
    })
    replyTo(host, "prompt", null)
    host.emitStdout("agent-1:sess-1", JSON.stringify({ type: "agent_settled" }) + "\n")
    await iterator
  })

  it("carries the turn's usage ON the done event, not after it", async () => {
    // `attachUsage` used to be fired with `void` AFTER `done` was pushed.
    // `prompt()` returns on `done` and `execute()` reads `tokenUsage` off it,
    // so the stats landed on a session object nobody was still reading and
    // every Pi turn reported zero tokens.
    const host = createFakeHost()
    const adapter = await connected(host)
    await adapter.createSession({ cwd: "/w" })
    const events: ExternalAgentEvent[] = []
    const iterator = (async () => {
      for await (const event of adapter.prompt("sess-1", message)) events.push(event)
      return events
    })()
    await Promise.resolve()
    await Promise.resolve()
    replyTo(host, "prompt", null)
    host.emitStdout("agent-1:sess-1", JSON.stringify({ type: "agent_settled" }) + "\n")

    const settled = (await iterator).find((event) => event.type === "done")
    expect(settled).toMatchObject({
      type: "done",
      tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    })
  })

  it("still completes the turn when the stats query fails", async () => {
    // Usage is reporting, not correctness: a failed `get_session_stats` must
    // never strand a turn that already succeeded.
    const host = createFakeHost({ failCommands: ["get_session_stats"] })
    const adapter = await connected(host)
    await adapter.createSession({ cwd: "/w" })
    const events: ExternalAgentEvent[] = []
    const iterator = (async () => {
      for await (const event of adapter.prompt("sess-1", message)) events.push(event)
      return events
    })()
    await Promise.resolve()
    await Promise.resolve()
    replyTo(host, "prompt", null)
    host.emitStdout("agent-1:sess-1", JSON.stringify({ type: "agent_settled" }) + "\n")

    const seen = await iterator
    expect(seen.map((event) => event.type)).toEqual(["done"])
    expect(seen[0]).not.toHaveProperty("tokenUsage")
  })

  it("releases the session after a rejected prompt so a corrected turn can run", async () => {
    const host = createFakeHost()
    const adapter = await connected(host)
    await adapter.createSession({ cwd: "/w" })
    const rejected = adapter
      .prompt("sess-1", message, { timeout: 1000 })
      [Symbol.asyncIterator]()
      .next()
    replyTo(host, "prompt", null, { success: false, error: "prompt not accepted" })
    await expect(rejected).rejects.toThrow("prompt not accepted")
    const retry = (async () => {
      const events: string[] = []
      for await (const event of adapter.prompt("sess-1", message)) events.push(event.type)
      return events
    })()
    replyTo(host, "prompt")
    host.emitStdout("agent-1:sess-1", JSON.stringify({ type: "agent_settled" }) + "\n")
    await expect(retry).resolves.toEqual(["usage_update", "done"])
  })

  it.each([
    { type: "url", url: "https://example.org/picture.png", mediaType: "image/png" },
    { type: "base64", data: "", mediaType: "image/png" },
  ])("rejects an unusable image source before sending a prompt", async (source) => {
    const host = createFakeHost()
    const adapter = await connected(host)
    await adapter.createSession({ cwd: "/w" })
    const invalid = { ...message, content: [{ type: "image", source }] } as ExternalAgentMessage
    await expect(adapter.prompt("sess-1", invalid)[Symbol.asyncIterator]().next()).rejects.toThrow(
      "require base64 image data"
    )
    expect(host.lastCommand("prompt")).toBeUndefined()
  })

  it("streams text and completes only on agent_settled", async () => {
    const host = createFakeHost()
    const { iterator, agentId } = await startTurn(host)

    host.emitStdout(agentId, JSON.stringify({ type: "message_start" }) + "\n")
    host.emitStdout(
      agentId,
      JSON.stringify({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "hello" },
      }) + "\n"
    )
    // Neither of these may end the turn — a retry can still follow.
    host.emitStdout(agentId, JSON.stringify({ type: "agent_end" }) + "\n")
    host.emitStdout(agentId, JSON.stringify({ type: "turn_end" }) + "\n")
    host.emitStdout(agentId, JSON.stringify({ type: "agent_settled" }) + "\n")

    const events = await iterator
    // `usage_update` before `done`: the turn's cost has to reach a streaming
    // consumer that never inspects the terminal event.
    expect(events).toEqual([
      "message_start",
      "message_delta",
      "progress",
      "progress",
      "usage_update",
      "done",
    ])
  })

  // ── Host framing parity ──────────────────────────────────────────────────
  //
  // The adapter must work on BOTH hosts. The Node/CLI backend honours
  // `framing: "raw"`; the Rust host (desktop + headless) ignores that flag and
  // emits `\n`-stripped lines on `external-agent://stdout`. Subscribing only to
  // `stdout-raw` is why the desktop received nothing at all — the process
  // started, the version probe succeeded, and every frame fell on the floor.

  it("drives a full turn from a line-framed host, as the desktop emits", async () => {
    const host = createFakeHost({ framing: "line" })
    const { iterator, agentId } = await startTurn(host, "line")

    host.emitStdoutLines(
      agentId,
      JSON.stringify({ type: "message_start" }) +
        "\n" +
        JSON.stringify({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "hello" },
        }) +
        "\n" +
        JSON.stringify({ type: "agent_settled" }) +
        "\n"
    )

    expect(await iterator).toEqual(["message_start", "message_delta", "usage_update", "done"])
  })

  it("reassembles a frame split across several line events", async () => {
    const host = createFakeHost({ framing: "line" })
    const { iterator, agentId } = await startTurn(host, "line")

    // A Pi frame whose payload contains a literal newline is impossible —
    // `JSON.stringify` escapes it — so every line event is a whole frame. What
    // must NOT happen is the decoder inventing a delimiter where the host did
    // not put one, so feed a long frame and assert it survives intact.
    const long = "x".repeat(5000)
    host.emitStdoutLines(
      agentId,
      JSON.stringify({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: long },
      }) +
        "\n" +
        JSON.stringify({ type: "agent_settled" }) +
        "\n"
    )

    expect(await iterator).toEqual(["message_delta", "usage_update", "done"])
  })

  it("ignores line events once the host has proved it speaks raw", async () => {
    const host = createFakeHost()
    const { iterator, agentId } = await startTurn(host)

    // A raw frame latches the framing. If a host somehow emitted both, the
    // decoder must not be fed the same frame twice.
    host.emitStdout(agentId, JSON.stringify({ type: "message_start" }) + "\n")
    host.emitStdoutLines(agentId, JSON.stringify({ type: "message_start" }))
    host.emitStdout(agentId, JSON.stringify({ type: "agent_settled" }) + "\n")

    expect(await iterator).toEqual(["message_start", "usage_update", "done"])
  })

  it("treats the prompt response as acceptance, not completion", async () => {
    const host = createFakeHost()
    const { iterator, agentId, events } = await startTurn(host)
    // The prompt was already acknowledged in startTurn; the turn must still
    // be open.
    expect(events).toEqual([])
    host.emitStdout(agentId, JSON.stringify({ type: "agent_settled" }) + "\n")
    await iterator
  })

  it("refuses a second concurrent turn on the same session", async () => {
    const host = createFakeHost()
    const { adapter, iterator, agentId } = await startTurn(host)

    await expect(async () => {
      for await (const _ of adapter.prompt("sess-1", message)) void _
    }).rejects.toThrow(/already has a turn in flight/)

    host.emitStdout(agentId, JSON.stringify({ type: "agent_settled" }) + "\n")
    await iterator
  })

  it("does not leak events between two live sessions", async () => {
    const host = createFakeHost()
    const adapter = await connected(host)
    await adapter.createSession({ cwd: "/a" })
    await adapter.createSession({ cwd: "/b" })

    const seenA: string[] = []
    const runA = (async () => {
      for await (const e of adapter.prompt("sess-1", message)) seenA.push(e.type)
    })()
    await Promise.resolve()
    await Promise.resolve()
    replyTo(host, "prompt")

    // Emit on session 2's process only.
    host.emitStdout(
      "agent-1:sess-2",
      JSON.stringify({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "leak?" },
      }) + "\n"
    )
    host.emitStdout("agent-1:sess-1", JSON.stringify({ type: "agent_settled" }) + "\n")
    await runA

    expect(seenA).toEqual(["usage_update", "done"])
  })

  it("surfaces an unexpected process exit as an error and ends the turn", async () => {
    const host = createFakeHost()
    const { iterator, agentId, events } = await startTurn(host)
    host.emitExit(agentId, 9)
    await iterator
    expect(events).toContain("error")
  })

  it("reports a malformed frame and stops trusting the stream", async () => {
    const host = createFakeHost()
    const { iterator, agentId, events } = await startTurn(host)
    host.emitStdout(agentId, "this is not json\n")
    // Closing on a protocol fault ends the turn rather than hanging.
    await iterator
    expect(events).toContain("error")
  })
})

describe("PiRpcClientAdapter — controls", () => {
  async function session(host: FakeHost) {
    const adapter = await connected(host)
    await adapter.createSession({ cwd: "/w" })
    return adapter
  }

  it("advertises and invokes native compaction, propagating its refusal", async () => {
    const host = createFakeHost()
    const adapter = await session(host)
    await expect(adapter.supportsSteering()).resolves.toBe(true)
    await expect(adapter.getCompactionCapability()).resolves.toEqual({
      status: "supported",
      routes: [{ kind: "native", supportsFocus: false }],
    })
    const compacting = adapter.compactSession("sess-1")
    expect(host.lastCommand("compact")).toMatchObject({ type: "compact" })
    replyTo(host, "compact")
    await expect(compacting).resolves.toBeUndefined()
    const rejected = adapter.compactSession("sess-1")
    replyTo(host, "compact", null, { success: false, error: "already compacting" })
    await expect(rejected).rejects.toThrow("already compacting")
  })

  it.each([true, false])(
    "reads live model options with populated=%s out of order",
    async (populated) => {
      const host = createFakeHost()
      const adapter = await session(host)
      const models = adapter.getSessionModels("sess-1")
      replyTo(
        host,
        "get_available_models",
        populated
          ? {
              models: [
                { id: "z-ai/glm-5.3-flash", provider: "commandcode", name: "GLM" },
                { id: "bare" },
                {},
              ],
            }
          : {}
      )
      replyTo(
        host,
        "get_state",
        populated ? { model: { provider: "commandcode", id: "z-ai/glm-5.3-flash" } } : {}
      )
      await expect(models).resolves.toEqual({
        currentModelId: populated ? "commandcode/z-ai/glm-5.3-flash" : "",
        availableModels: populated
          ? [
              { modelId: "commandcode/z-ai/glm-5.3-flash", name: "GLM" },
              { modelId: "bare", name: "bare" },
              { modelId: "", name: "" },
            ]
          : [],
      })
    }
  )

  it.each([true, false])("reads config options with populated=%s", async (populated) => {
    const host = createFakeHost()
    const adapter = await session(host)
    const options = adapter.getConfigOptions("sess-1")
    replyTo(
      host,
      "get_available_models",
      populated ? { models: [{ provider: "p", id: "m", name: "Model M" }, { id: "bare" }] } : {}
    )
    replyTo(host, "get_available_thinking_levels", populated ? { levels: ["off", "high"] } : {})
    replyTo(
      host,
      "get_state",
      populated ? { model: { provider: "p", id: "m" }, thinkingLevel: "high" } : {}
    )
    await expect(options).resolves.toEqual([
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: populated ? "p/m" : "",
        options: populated
          ? [
              { value: "p/m", name: "Model M" },
              { value: "bare", name: "bare" },
            ]
          : [],
      },
      {
        id: "thinking",
        name: "Thinking",
        category: "thought_level",
        type: "select",
        currentValue: populated ? "high" : "off",
        options: populated
          ? [
              { value: "off", name: "off" },
              { value: "high", name: "high" },
            ]
          : [],
      },
    ])
  })

  it.each(["model", "thinking"])("refreshes config after changing %s", async (option) => {
    const host = createFakeHost()
    const adapter = await session(host)
    const changing = adapter.setConfigOption("sess-1", option, option === "model" ? "bare" : "high")
    if (option === "thinking") {
      replyTo(host, "get_available_thinking_levels", { levels: ["off", "high"] })
      await new Promise((resolve) => setImmediate(resolve))
      replyTo(host, "set_thinking_level")
    } else {
      expect(host.lastCommand("set_model")).toMatchObject({ modelId: "bare" })
      expect(host.lastCommand("set_model")).not.toHaveProperty("provider")
      replyTo(host, "set_model")
    }
    await new Promise((resolve) => setImmediate(resolve))
    replyTo(host, "get_available_models", { models: [] })
    replyTo(host, "get_available_thinking_levels", { levels: [] })
    replyTo(host, "get_state", {})
    await expect(changing).resolves.toHaveLength(2)
    const count = host.sent.length
    await expect(adapter.setConfigOption("sess-1", "unknown", "x")).rejects.toThrow(
      "Unknown Pi config option"
    )
    expect(host.sent).toHaveLength(count)
  })

  it("does not send a thinking setting if the provider omits its levels", async () => {
    const host = createFakeHost()
    const adapter = await session(host)
    const changing = adapter.setThinkingLevel("sess-1", "high")
    replyTo(host, "get_available_thinking_levels", {})
    await expect(changing).resolves.toBeUndefined()
    expect(host.lastCommand("set_thinking_level")).toBeUndefined()
  })

  it("checks live health and reports a failed RPC without discarding the session", async () => {
    const host = createFakeHost()
    const adapter = await connected(host)
    await expect(adapter.healthCheck()).resolves.toBe(true)
    await adapter.createSession({ cwd: "/w" })
    const healthy = adapter.healthCheck()
    replyTo(host, "get_state", {})
    await expect(healthy).resolves.toBe(true)
    const unhealthy = adapter.healthCheck()
    replyTo(host, "get_state", null, { success: false, error: "unavailable" })
    await expect(unhealthy).resolves.toBe(false)
    expect(adapter.getSessions()).toHaveLength(1)
    await adapter.disconnect()
    await expect(adapter.healthCheck()).resolves.toBe(false)
    await expect(adapter.cancel("gone")).resolves.toBeUndefined()
  })

  it("maps steer and abort onto Pi's own commands", async () => {
    const host = createFakeHost()
    const adapter = await session(host)

    const steering = adapter.steerTurn("sess-1", "actually, stop")
    await Promise.resolve()
    replyTo(host, "steer")
    await steering
    expect(host.lastCommand("steer")).toMatchObject({ message: "actually, stop" })

    const cancelling = adapter.cancel("sess-1")
    await Promise.resolve()
    replyTo(host, "abort")
    await cancelling
    expect(host.lastCommand("abort")).toBeDefined()
  })

  it("clamps a thinking level against what the model reports", async () => {
    const host = createFakeHost()
    const adapter = await session(host)

    const setting = adapter.setThinkingLevel("sess-1", "medium")
    await Promise.resolve()
    replyTo(host, "get_available_thinking_levels", { levels: ["off", "high", "max"] })
    await Promise.resolve()
    replyTo(host, "set_thinking_level")
    await expect(setting).resolves.toBe("off")
    expect(host.lastCommand("set_thinking_level")).toMatchObject({ level: "off" })
  })

  it("never sends an unsupported level to the wire", async () => {
    const host = createFakeHost()
    const adapter = await session(host)
    const setting = adapter.setThinkingLevel("sess-1", "nonsense")
    await Promise.resolve()
    replyTo(host, "get_available_thinking_levels", { levels: ["off", "high"] })
    await expect(setting).resolves.toBeUndefined()
    expect(host.lastCommand("set_thinking_level")).toBeUndefined()
  })

  it("splits provider/model when switching models", async () => {
    const host = createFakeHost()
    const adapter = await session(host)
    const setting = adapter.setSessionModel("sess-1", "deepseek/deepseek-v4-pro")
    await Promise.resolve()
    replyTo(host, "set_model")
    await setting
    expect(host.lastCommand("set_model")).toMatchObject({
      provider: "deepseek",
      modelId: "deepseek-v4-pro",
    })
  })

  it("explains a refusal that the isolation policy caused, not the model id", async () => {
    // Pi says only "Model not found", which reads as a typo. Under the default
    // isolated policy the real cause is that the model belongs to a provider one
    // of the user's own Pi extensions contributes, and those are not loaded.
    const host = createFakeHost()
    const adapter = await session(host)
    const setting = adapter.setSessionModel("sess-1", "commandcode/z-ai/glm-5.3-flash")
    await Promise.resolve()
    replyTo(host, "set_model", null, {
      success: false,
      error: "Model not found: commandcode/z-ai/glm-5.3-flash",
    })
    await expect(setting).rejects.toThrow(/extension policy "isolated"/)
    await expect(setting).rejects.toThrow(/Model not found/)
  })

  it("passes an unrelated refusal through unembellished", async () => {
    const host = createFakeHost()
    const adapter = await session(host)
    const setting = adapter.setSessionModel("sess-1", "deepseek/deepseek-v4-pro")
    await Promise.resolve()
    replyTo(host, "set_model", null, { success: false, error: "provider unreachable" })
    await expect(setting).rejects.toThrow(/provider unreachable/)
    await expect(setting).rejects.not.toThrow(/extension policy/)
  })

  it("aborts before killing so a tool call can finish cleanly", async () => {
    const host = createFakeHost()
    const adapter = await session(host)
    const closing = adapter.closeSession("sess-1")
    await Promise.resolve()
    replyTo(host, "abort")
    await closing

    expect(host.lastCommand("abort")).toBeDefined()
    expect(host.killed).toContain("agent-1:sess-1")
  })

  it("rejects work against an unknown or dead session", async () => {
    const host = createFakeHost()
    const adapter = await session(host)
    await expect(adapter.steerTurn("nope", "x")).rejects.toThrow(/Unknown Pi session/)

    host.emitExit("agent-1:sess-1", 1)
    await expect(adapter.steerTurn("sess-1", "x")).rejects.toThrow(/no longer running/)
  })
})

describe("PiRpcClientAdapter — elicitation", () => {
  /** Raise a Pi dialog on a live session and return its canonical request. */
  async function openDialog(host: FakeHost, dialog: Record<string, unknown> = {}) {
    const adapter = await connected(host)
    await adapter.createSession({ cwd: "/w" })
    const seen: ExternalAgentEvent[] = []
    const iterator = (async () => {
      for await (const event of adapter.prompt("sess-1", {
        id: "m1",
        role: "user",
        content: [{ type: "text", text: "hi" }],
        timestamp: new Date(),
      })) {
        seen.push(event)
      }
    })()
    await Promise.resolve()
    await Promise.resolve()
    replyTo(host, "prompt")

    host.emitStdout(
      "agent-1:sess-1",
      JSON.stringify({
        type: "extension_ui_request",
        id: "dlg-1",
        method: "select",
        title: "Pick a branch",
        options: ["main", "dev"],
        ...dialog,
      }) + "\n"
    )
    // The frame decodes synchronously, but the `for await` loop needs a real
    // turn of the event loop to pull it out of the queue and into `seen`.
    for (let i = 0; i < 20 && !seen.some((e) => e.type === "elicitation_request"); i++) {
      await new Promise((resolve) => setImmediate(resolve))
    }
    return { adapter, seen, iterator }
  }

  /**
   * The end of the dead-end: `elicitation_request` is what Pi dialogs map to,
   * and until `respondToElicitation` existed nothing could answer one, so the
   * extension stayed blocked for the whole turn.
   */
  it("preserves a negative confirmation instead of approving the tool", async () => {
    const host = createFakeHost()
    const { adapter, iterator } = await openDialog(host, { method: "confirm" })
    await adapter.respondToElicitation({
      requestId: "dlg-1",
      action: "accept",
      content: { confirm: false },
    })
    const answer = host.lastFrame("extension_ui_response")
    host.emitStdout("agent-1:sess-1", JSON.stringify({ type: "agent_settled" }) + "\n")
    await iterator
    expect(answer).toEqual({ type: "extension_ui_response", id: "dlg-1", confirmed: false })
  })

  it("cancels pending dialogs on abort and ignores late permission replies", async () => {
    const host = createFakeHost()
    const { adapter, iterator } = await openDialog(host)
    await adapter.cancel("sess-1")
    const answer = host.lastFrame("extension_ui_response")
    const count = host.sent.length
    await adapter.respondToPermission("sess-1", { requestId: "dlg-1", granted: true })
    const lateWrites = host.sent.slice(count)
    host.emitStdout("agent-1:sess-1", JSON.stringify({ type: "agent_settled" }) + "\n")
    await iterator
    expect(answer).toEqual({ type: "extension_ui_response", id: "dlg-1", cancelled: true })
    expect(lateWrites).toEqual([])
  })

  it("ignores permission replies for an unknown request", async () => {
    const host = createFakeHost()
    const adapter = await connected(host)
    await adapter.createSession({ cwd: "/w" })
    await adapter.respondToPermission("sess-1", { requestId: "never-asked", granted: true })
    expect(host.lastFrame("extension_ui_response")).toBeUndefined()
  })

  it("answers a dialog through respondToElicitation", async () => {
    const host = createFakeHost()
    const { adapter, seen, iterator } = await openDialog(host)

    const request = seen.find((e) => e.type === "elicitation_request")
    expect(request).toBeDefined()

    await adapter.respondToElicitation({
      requestId: "dlg-1",
      action: "accept",
      content: { select: "dev" },
    })

    // `id` is the DIALOG id, not a correlation id: Pi looks the answer up in
    // `pendingExtensionRequests` by exactly this field (rpc-mode.js). Sending a
    // correlation id here is what left every dialog blocked.
    const answer = host.lastFrame("extension_ui_response")
    expect(answer).toEqual({ type: "extension_ui_response", id: "dlg-1", value: "dev" })
    // The three response payloads are mutually exclusive in Pi's own types.
    expect(answer).not.toHaveProperty("confirmed")

    host.emitStdout("agent-1:sess-1", JSON.stringify({ type: "agent_settled" }) + "\n")
    await iterator
  })

  it("maps decline and cancel onto Pi's dismissal, not onto a deliberate no", async () => {
    for (const action of ["decline", "cancel"] as const) {
      const host = createFakeHost()
      const { adapter, iterator } = await openDialog(host)

      await adapter.respondToElicitation({ requestId: "dlg-1", action })

      const answer = host.lastFrame("extension_ui_response")
      // `cancelled`, never `confirmed: false` — the latter reads as a real
      // answer to a `select` rather than a dismissal.
      expect(answer).toEqual({ type: "extension_ui_response", id: "dlg-1", cancelled: true })

      host.emitStdout("agent-1:sess-1", JSON.stringify({ type: "agent_settled" }) + "\n")
      await iterator
    }
  })

  /**
   * The other half of the split: a native-tool approval reaches the approval UI
   * as `permission_request` and is answered with `confirmed`, which is the only
   * shape Pi's `confirm` accepts.
   */
  it("answers a native-tool approval with confirmed, not with a value", async () => {
    const host = createFakeHost()
    const adapter = await connected(host)
    await adapter.createSession({ cwd: "/w" })
    const seen: ExternalAgentEvent[] = []
    const iterator = (async () => {
      for await (const event of adapter.prompt("sess-1", {
        id: "m1",
        role: "user",
        content: [{ type: "text", text: "hi" }],
        timestamp: new Date(),
      })) {
        seen.push(event)
      }
    })()
    await Promise.resolve()
    await Promise.resolve()
    replyTo(host, "prompt")

    host.emitStdout(
      "agent-1:sess-1",
      JSON.stringify({
        type: "extension_ui_request",
        id: "approve-1",
        method: "confirm",
        title: encodePiPermissionTitle({ tool: "bash", mode: "default" }),
        message: "bash: rm -rf dist",
      }) + "\n"
    )
    for (let i = 0; i < 20 && !seen.some((e) => e.type === "permission_request"); i++) {
      await new Promise((resolve) => setImmediate(resolve))
    }
    expect(seen.some((e) => e.type === "permission_request")).toBe(true)

    await adapter.respondToPermission("sess-1", { requestId: "approve-1", granted: true })

    expect(host.lastFrame("extension_ui_response")).toEqual({
      type: "extension_ui_response",
      id: "approve-1",
      confirmed: true,
    })

    host.emitStdout("agent-1:sess-1", JSON.stringify({ type: "agent_settled" }) + "\n")
    await iterator
  })

  it.each([
    ["confirm", false, { confirmed: false }],
    ["confirm", true, { confirmed: true }],
    ["select", "dev", { value: "dev" }],
    ["input", "", { value: "" }],
    ["editor", "line 1\nline 2", { value: "line 1\nline 2" }],
  ])("answers %s using its named field and exact wire type", async (method, value, payload) => {
    const host = createFakeHost()
    const { adapter, iterator } = await openDialog(host, { method })
    expect(host.lastFrame("extension_ui_response")).toBeUndefined()
    await adapter.respondToElicitation({
      requestId: "dlg-1",
      action: "accept",
      content: { unrelated: "Yes", [String(method)]: value },
    })
    expect(host.lastFrame("extension_ui_response")).toEqual({
      type: "extension_ui_response",
      id: "dlg-1",
      ...payload,
    })
    host.emitStdout("agent-1:sess-1", JSON.stringify({ type: "agent_settled" }) + "\n")
    await iterator
  })

  it.each([
    ["confirm", {}],
    ["confirm", { confirm: "true" }],
    ["select", { select: "not-an-option" }],
    ["input", { input: 42 }],
  ])("cancels invalid %s content instead of inventing an approval", async (method, content) => {
    const host = createFakeHost()
    const { adapter, iterator } = await openDialog(host, { method })
    await adapter.respondToElicitation({ requestId: "dlg-1", action: "accept", content })
    expect(host.lastFrame("extension_ui_response")).toEqual({
      type: "extension_ui_response",
      id: "dlg-1",
      cancelled: true,
    })
    host.emitStdout("agent-1:sess-1", JSON.stringify({ type: "agent_settled" }) + "\n")
    await iterator
  })

  it("keeps global-extension selects and Cognia confirmations independently blocked", async () => {
    const host = createFakeHost()
    const { adapter, iterator } = await openDialog(host, {
      title: "Permission Required\nbash: echo hi",
      options: ["Yes", "Yes, for this session", "No", "No, provide reason"],
    })
    host.emitStdout(
      "agent-1:sess-1",
      JSON.stringify({
        type: "extension_ui_request",
        id: "native",
        method: "confirm",
        title: encodePiPermissionTitle({ tool: "bash", mode: "default" }),
      }) + "\n"
    )
    expect(host.lastFrame("extension_ui_response")).toBeUndefined()
    await adapter.respondToElicitation({
      requestId: "dlg-1",
      action: "accept",
      content: { select: "Yes" },
    })
    expect(host.lastFrame("extension_ui_response")).toEqual({
      type: "extension_ui_response",
      id: "dlg-1",
      value: "Yes",
    })
    expect(host.sent.filter((s) => s.message.includes('"id":"native"'))).toEqual([])
    await adapter.respondToPermission("sess-1", { requestId: "native", granted: false })
    expect(host.lastFrame("extension_ui_response")).toEqual({
      type: "extension_ui_response",
      id: "native",
      cancelled: true,
    })
    const count = host.sent.length
    await adapter.respondToPermission("sess-1", { requestId: "native", granted: true })
    expect(host.sent).toHaveLength(count)
    host.emitStdout("agent-1:sess-1", JSON.stringify({ type: "agent_settled" }) + "\n")
    await iterator
  })

  it("cannot answer another session's approval", async () => {
    const host = createFakeHost()
    const { adapter, iterator } = await openDialog(host)
    await adapter.createSession({ cwd: "/other" })
    await adapter.respondToPermission("sess-2", { requestId: "dlg-1", granted: true })
    expect(host.lastFrame("extension_ui_response")).toBeUndefined()
    await adapter.respondToElicitation({
      requestId: "dlg-1",
      action: "accept",
      content: { select: "dev" },
    })
    expect(host.lastFrame("extension_ui_response")).toMatchObject({ value: "dev" })
    host.emitStdout("agent-1:sess-1", JSON.stringify({ type: "agent_settled" }) + "\n")
    await iterator
  })

  it("ignores replies after Pi's advertised dialog timeout", async () => {
    const host = createFakeHost()
    const { adapter, iterator } = await openDialog(host, { timeout: 100 })
    const clock = jest.spyOn(Date, "now").mockReturnValue(Date.now() + 101)
    try {
      await adapter.respondToElicitation({
        requestId: "dlg-1",
        action: "accept",
        content: { select: "dev" },
      })
      expect(host.lastFrame("extension_ui_response")).toBeUndefined()
    } finally {
      clock.mockRestore()
    }
    host.emitStdout("agent-1:sess-1", JSON.stringify({ type: "agent_settled" }) + "\n")
    await iterator
  })

  it.each(["close", "exit", "settle"])("ignores late replies after %s", async (ending) => {
    const host = createFakeHost()
    const { adapter, iterator } = await openDialog(host)
    if (ending === "close") await adapter.closeSession("sess-1")
    else if (ending === "exit") host.emitExit("agent-1:sess-1", 0)
    else host.emitStdout("agent-1:sess-1", JSON.stringify({ type: "agent_settled" }) + "\n")
    await iterator
    const count = host.sent.length
    await adapter.respondToPermission("sess-1", { requestId: "dlg-1", granted: true })
    await adapter.respondToElicitation({
      requestId: "dlg-1",
      action: "accept",
      content: { select: "dev" },
    })
    expect(host.sent).toHaveLength(count)
  })

  it("handles a rejected cancellation write without an unhandled promise", async () => {
    const host = createFakeHost()
    const { adapter, iterator } = await openDialog(host)
    const invoke = host.invoke.bind(host)
    host.invoke = async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
      if (
        name === "send_to_external_agent" &&
        String(args.message).includes("extension_ui_response")
      ) {
        throw new Error("broken pipe")
      }
      return invoke<T>(name, args)
    }
    await adapter.cancel("sess-1")
    await new Promise((resolve) => setImmediate(resolve))
    await expect(
      adapter.respondToPermission("sess-1", { requestId: "dlg-1", granted: true })
    ).resolves.toBeUndefined()
    host.emitStdout("agent-1:sess-1", JSON.stringify({ type: "agent_settled" }) + "\n")
    await iterator
  })

  it("cancels requests arriving during abort without surfacing another prompt", async () => {
    const host = createFakeHost()
    const { adapter, iterator, seen } = await openDialog(host)
    const aborting = adapter.cancel("sess-1")
    host.emitStdout(
      "agent-1:sess-1",
      JSON.stringify({
        type: "extension_ui_request",
        id: "during-abort",
        method: "input",
        title: "Reason?",
      }) + "\n"
    )
    await aborting
    expect(host.lastFrame("extension_ui_response")).toEqual({
      type: "extension_ui_response",
      id: "during-abort",
      cancelled: true,
    })
    const types = host.sent.map((s) => JSON.parse(s.message).type)
    expect(types.indexOf("abort")).toBeLessThan(types.indexOf("extension_ui_response"))
    host.emitStdout("agent-1:sess-1", JSON.stringify({ type: "agent_settled" }) + "\n")
    await iterator
    expect(seen.filter((event) => event.type === "elicitation_request")).toHaveLength(1)
  })

  it("ignores an answer to a dialog it does not know", async () => {
    const host = createFakeHost()
    const adapter = await connected(host)
    await adapter.createSession({ cwd: "/w" })

    await expect(
      adapter.respondToElicitation({ requestId: "never-asked", action: "accept" })
    ).resolves.toBeUndefined()
    expect(host.lastFrame("extension_ui_response")).toBeUndefined()
  })

  /**
   * A dialog blocks its extension. Closing the session without cancelling
   * leaves that extension parked on a process that is about to be killed — and
   * on the graceful `abort` path, that wait is what stops Pi exiting.
   */
  it("cancels a still-open dialog when the session closes", async () => {
    const host = createFakeHost()
    const { adapter, iterator } = await openDialog(host)

    await adapter.closeSession("sess-1")

    const answer = host.lastFrame("extension_ui_response")
    expect(answer).toEqual({ type: "extension_ui_response", id: "dlg-1", cancelled: true })
    await iterator
  })

  it("does not answer the same dialog twice", async () => {
    const host = createFakeHost()
    const { adapter, iterator } = await openDialog(host)

    await adapter.respondToElicitation({ requestId: "dlg-1", action: "accept" })
    const first = host.sent.filter((s) => s.message.includes("extension_ui_response")).length

    await adapter.respondToElicitation({ requestId: "dlg-1", action: "accept" })
    const second = host.sent.filter((s) => s.message.includes("extension_ui_response")).length

    expect(second).toBe(first)

    host.emitStdout("agent-1:sess-1", JSON.stringify({ type: "agent_settled" }) + "\n")
    await iterator
  })
})

describe("PiRpcClientAdapter — teardown", () => {
  it("closes every live session on disconnect, killing each process", async () => {
    const host = createFakeHost()
    const adapter = await connected(host)
    await adapter.createSession({ cwd: "/a" })
    await adapter.createSession({ cwd: "/b" })

    await adapter.disconnect()

    expect(host.killed).toEqual(expect.arrayContaining(["agent-1:sess-1", "agent-1:sess-2"]))
    expect(adapter.isConnected()).toBe(false)
    // Nothing is left behind that a later resume could latch onto.
    expect(adapter.getSessions()).toHaveLength(0)
  })

  /**
   * Pi answers a frame it cannot parse with `{"command":"parse"}` and NO id, so
   * it fails no pending request. It still means Cognia wrote something
   * malformed, which must surface rather than vanish.
   */
  it("surfaces Pi rejecting one of our own frames as an error", async () => {
    const host = createFakeHost()
    const adapter = await connected(host)
    await adapter.createSession({ cwd: "/w" })

    const events: string[] = []
    const messages: string[] = []
    const iterator = (async () => {
      for await (const event of adapter.prompt("sess-1", {
        id: "m1",
        role: "user",
        content: [{ type: "text", text: "hi" }],
        timestamp: new Date(),
      })) {
        events.push(event.type)
        if (event.type === "error") messages.push(String(event.error))
      }
    })()
    await Promise.resolve()
    await Promise.resolve()
    replyTo(host, "prompt")

    host.emitStdout(
      "agent-1:sess-1",
      JSON.stringify({ type: "response", command: "parse", success: false, error: "bad json" }) +
        "\n"
    )
    host.emitStdout("agent-1:sess-1", JSON.stringify({ type: "agent_settled" }) + "\n")
    await iterator

    expect(events).toContain("error")
    expect(messages.join(" ")).toMatch(/malformed command.*bad json/)
  })
})

describe("PiRpcClientAdapter — resource limit", () => {
  it("refuses a new session when every process is mid-turn", async () => {
    const host = createFakeHost()
    const adapter = new PiRpcClientAdapter({
      host,
      maxProcesses: 1,
      generateSessionId: (() => {
        let n = 0
        return () => `s${++n}`
      })(),
    })
    const connecting = adapter.connect(config)
    await Promise.resolve()
    host.emitVersion(host.spawns[0].id, PI_CERTIFIED_VERSION)
    await connecting

    await adapter.createSession({ cwd: "/a" })
    const message: ExternalAgentMessage = {
      id: "m",
      role: "user",
      content: [{ type: "text", text: "go" }],
      timestamp: new Date(),
    }
    const running = (async () => {
      for await (const _ of adapter.prompt("s1", message)) void _
    })()
    await Promise.resolve()
    await Promise.resolve()
    replyTo(host, "prompt")

    // The only slot is busy, so evicting it would kill live work.
    await expect(adapter.createSession({ cwd: "/b" })).rejects.toBeInstanceOf(PiResourceLimitError)
    await expect(adapter.createSession({ cwd: "/b" })).rejects.toMatchObject({
      reasonCode: "resource_limit",
    })

    host.emitStdout("agent-1:s1", JSON.stringify({ type: "agent_settled" }) + "\n")
    await running
  })
})

describe("session listing and the session-less catalog", () => {
  it("lists sessions through the host, newest first, scoped to the configured cwd", async () => {
    const host = createFakeHost()
    host.setListedSessions([
      {
        id: "old",
        cwd: "/w",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-02T00:00:00Z",
      },
      { id: "new", cwd: "/w", name: "Refactor", updatedAt: "2026-01-03T00:00:00Z" },
      { id: "", cwd: "/w" },
    ])
    const adapter = await connected(host)
    // No configured cwd on this agent: the host is asked for every directory.
    const sessions = await adapter.listSessions()
    expect(host.listSessionCalls).toEqual([{}])
    expect(sessions.map((s) => s.sessionId)).toEqual(["new", "old"])
    expect(sessions[0]).toMatchObject({ title: "Refactor", cwd: "/w" })
    // An explicit cwd scopes the host call.
    await adapter.listSessions({ cwd: "/elsewhere" })
    expect(host.listSessionCalls[1]).toEqual({ cwd: "/elsewhere" })
  })

  it("lists models without a session via `pi --list-models`", async () => {
    const host = createFakeHost()
    const adapter = await connected(host)
    const pending = adapter.listAgentModels()
    await Promise.resolve()
    const probe = host.spawns.find((spawn) => spawn.args.includes("--list-models"))!
    expect(probe).toBeDefined()
    // Same isolation the session runs under, so the picker cannot offer a model
    // that `set_model` will refuse. Without it the listing read the user's whole
    // stack (extensions included) while the session had none of it.
    expect(probe.args).toContain("--no-extensions")
    host.emitStdoutLines(
      probe.id,
      "provider  model  context  max-out  thinking  images\ndeepseek  deepseek-v4-pro  1M  384K  yes  no\n"
    )
    host.emitExit(probe.id, 0)
    await expect(pending).resolves.toEqual({
      status: "ok",
      models: [
        {
          provider: "deepseek",
          id: "deepseek-v4-pro",
          context: "1M",
          maxOut: "384K",
          thinking: true,
          images: false,
        },
      ],
    })
  })
})

describe("Pi session recovery and host defaults", () => {
  it("recovers an exited session before sending the next prompt, only once", async () => {
    const host = createFakeHost()
    const adapter = await connected(host)
    await adapter.createSession({ cwd: "/original", permissionMode: "plan" })
    host.emitExit("agent-1:sess-1", 1)
    const count = host.spawns.length
    const message: ExternalAgentMessage = {
      id: "recovery",
      role: "user",
      content: [{ type: "text", text: "continue" }],
      timestamp: new Date(),
    }
    const turn = adapter.prompt("sess-1", message)[Symbol.asyncIterator]()
    const next = turn.next()
    // Attach rejection handling before waiting for the fixture's async handshake.
    const outcome = next.then(
      (value) => ({ value }),
      (error: unknown) => ({ error })
    )
    for (let i = 0; i < 30 && !host.lastCommand("prompt"); i++) await Promise.resolve()
    expect(host.spawns).toHaveLength(count + 1)
    expect(host.spawns.at(-1)?.args).toEqual(expect.arrayContaining(["--session-id", "sess-1"]))
    expect(host.sent.filter((frame) => JSON.parse(frame.message).type === "prompt")).toHaveLength(1)
    replyTo(host, "prompt")
    await adapter.closeSession("sess-1")
    expect(await outcome).not.toHaveProperty("error")
  })

  it("deduplicates concurrent recovery and retires old listeners", async () => {
    const host = createFakeHost()
    const adapter = await connected(host)
    await adapter.createSession({ cwd: "/original", permissionMode: "plan" })
    const other = await adapter.createSession({ cwd: "/other", permissionMode: "default" })
    host.emitExit("agent-1:sess-1", 1)
    const count = host.spawns.length
    const [first, second] = await Promise.all([
      adapter.resumeSession("sess-1"),
      adapter.resumeSession("sess-1"),
    ])
    expect(first).toBe(second)
    expect(host.spawns).toHaveLength(count + 1)
    expect(first.permissionMode).toBe("plan")
    expect(first.metadata?.cwd).toBe("/original")
    await adapter.closeSession("sess-1")
    await adapter.closeSession(other.id)
  })

  it("reuses a running session and respawns an exited one", async () => {
    const host = createFakeHost()
    const adapter = await connected(host)
    const first = await adapter.createSession({ cwd: "/w" })
    const count = host.spawns.length
    await expect(adapter.resumeSession(first.id)).resolves.toBe(first)
    expect(host.spawns).toHaveLength(count)
    host.emitExit(`agent-1:${first.id}`, 1)
    const resumed = await adapter.resumeSession(first.id)
    expect(resumed.id).toBe(first.id)
    expect(host.spawns).toHaveLength(count + 1)
    await adapter.closeSession(first.id)
    await expect(adapter.closeSession(first.id)).resolves.toBeUndefined()
  })

  it.each(["resume", "fork"])(
    "can %s a persisted id before any session has been opened",
    async (operation) => {
      const host = createFakeHost()
      const adapter = await connected(host)
      const result =
        operation === "resume"
          ? await adapter.resumeSession("persisted")
          : await adapter.forkSession("persisted")
      expect(result.id).toBe(operation === "resume" ? "persisted" : "sess-1")
      const spawn = host.spawns.at(-1)!
      expect(spawn.args).toContain(operation === "resume" ? "--session-id" : "--fork")
      expect(spawn.args).toContain("persisted")
    }
  )

  it.each([undefined, { command: "pi", args: [] }])(
    "supplies the native command and RPC mode for minimal process config %j",
    async (processConfig) => {
      const host = createFakeHost()
      const adapter = new PiRpcClientAdapter({ host })
      await expect(adapter.createSession()).rejects.toThrow("not connected")
      const connecting = adapter.connect({ ...config, process: processConfig })
      await Promise.resolve()
      host.emitVersion(host.spawns[0].id, PI_CERTIFIED_VERSION)
      await connecting
      const session = await adapter.createSession()
      expect(session.id).toBeTruthy()
      expect(host.spawns.at(-1)).toMatchObject({
        command: "pi",
        args: expect.arrayContaining(["--mode", "rpc", "--session-id", session.id]),
      })
      await adapter.disconnect()
    }
  )

  it("treats an absent listing as empty and sorts partial session records by available timestamps", async () => {
    const host = createFakeHost()
    const adapter = await connected(host)
    host.setListedSessions(undefined)
    await expect(adapter.listSessions()).resolves.toEqual([])
    host.setListedSessions([
      { id: "undated" },
      { id: "created", createdAt: "2026-09-01T00:00:00Z" },
      { id: "updated", updatedAt: "2026-09-02T00:00:00Z" },
      { id: "also-undated" },
    ])
    const listed = await adapter.listSessions()
    expect(listed.map((item) => item.sessionId)).toEqual([
      "updated",
      "created",
      "undated",
      "also-undated",
    ])
    expect(listed.at(-1)).toEqual({ sessionId: "also-undated" })
  })
})
