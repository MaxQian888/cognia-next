/**
 * @jest-environment node
 */
import { DEFAULT_BUILTIN_TOOLS } from "@cognia/agent-config-types"
import type { ProviderOperationProfile } from "@cognia/provider-types"

import type { ProviderLimits } from "@/types/subscription"

import type { ResolvedConfig } from "../config/schema"
import type { CliProviderExecutor } from "../provider/local"
import { localProviderTransport, type ProviderTransportResolution } from "../provider/transport"
import { parseArgv } from "./args"
import { PROVIDER_HELP, providerCommand } from "./provider-command"

const CONFIG: ResolvedConfig = {
  provider: "openai",
  permissionMode: "default",
  builtinTools: { ...DEFAULT_BUILTIN_TOOLS },
  providers: { openai: { apiKey: "sk" }, deepseek: { apiKey: "d" } },
  cwd: "/w",
}

const NOW = Date.parse("2026-09-02T12:00:00Z")

function sink() {
  const stdout: string[] = []
  const stderr: string[] = []
  const records: unknown[] = []
  return {
    out: {
      write: (t: string) => stdout.push(t),
      error: (t: string) => stderr.push(t),
      json: (v: unknown) => records.push(v),
    },
    stdout: () => stdout.join(""),
    stderr: () => stderr.join(""),
    records,
  }
}

const PROFILE: ProviderOperationProfile = {
  providerId: "openai",
  computedAt: NOW,
  cells: [
    { operationId: "models.list", support: "native", availability: "ready" },
    {
      operationId: "batches.create",
      support: "unsupported",
      availability: "unavailable",
      reason: "no batch API",
    },
  ],
}

const executor: CliProviderExecutor = {
  execute: jest.fn(async (operationId, providerId) => {
    switch (operationId) {
      case "capabilities.read":
        return {
          ok: true as const,
          operationId,
          providerId,
          support: "derived" as const,
          output: PROFILE,
        }
      case "models.list":
        return {
          ok: true as const,
          operationId,
          providerId,
          support: "native" as const,
          output: {
            models: [{ id: "gpt-4o", name: "GPT-4o", contextLength: 128_000 }],
            source: "catalog-static",
            freshness: "static",
            fetchedAt: NOW,
          },
        }
      case "health.probe":
        return {
          ok: true as const,
          operationId,
          providerId,
          support: "native" as const,
          output: {
            reachable: true,
            authenticated: true,
            capabilityVerified: true,
            durationMs: 42,
            httpStatus: 200,
          },
        }
      case "usage.local.read":
        return {
          ok: true as const,
          operationId,
          providerId,
          support: "derived" as const,
          output: { rows: [] },
        }
      default:
        throw new Error(`unexpected ${operationId}`)
    }
  }) as CliProviderExecutor["execute"],
}

const localResolution: ProviderTransportResolution = {
  transport: localProviderTransport(),
  skipped: [
    { kind: "bridge", message: "no desktop" },
    { kind: "rpc", message: "no server" },
  ],
}

const emptyFs = {
  exists: () => false,
  isDirectory: () => false,
  readFile: () => null,
  writeFileAtomic: () => undefined,
  appendFile: () => undefined,
  mkdirp: () => undefined,
  readdir: () => [],
  removeFile: () => undefined,
  removeDir: () => undefined,
  writeFileExclusive: () => true,
  mtimeMs: () => null,
}

function run(argv: string[], extra: Parameters<typeof providerCommand>[1] = {}) {
  const s = sink()
  const code = providerCommand(parseArgv(argv), {
    out: s.out,
    loadConfig: () => CONFIG,
    resolveTransport: async () => localResolution,
    createExecutor: () => executor,
    now: () => NOW,
    env: { COGNIA_HOME: "/home/u/.cognia" },
    ensureDb: async () => undefined,
    fsx: emptyFs,
    ...extra,
  })
  return { ...s, code }
}

describe("providerCommand", () => {
  beforeEach(() => jest.clearAllMocks())

  it("prints help on --help and usage on a missing or unknown verb", async () => {
    const help = run(["provider", "--help"])
    expect(await help.code).toBe(0)
    expect(help.stdout()).toBe(PROVIDER_HELP)

    const missing = run(["provider"])
    expect(await missing.code).toBe(2)
    expect(missing.stderr()).toContain("provider capabilities")

    const unknown = run(["provider", "frobnicate"])
    expect(await unknown.code).toBe(2)
    expect(unknown.stderr()).toMatch(/Unknown provider verb: "frobnicate"/)
  })

  it("refuses billed reads without --live and a probe without --yes, before touching any plane", async () => {
    const resolveTransport = jest.fn(async () => localResolution)
    for (const verb of ["balance", "limits", "probe"]) {
      const r = run(["provider", verb], { resolveTransport })
      expect(await r.code).toBe(2)
      expect(r.stderr()).toMatch(/--live/)
    }
    const probe = run(["provider", "probe", "--live"], { resolveTransport })
    expect(await probe.code).toBe(2)
    expect(probe.stderr()).toMatch(/--yes/)
    expect(resolveTransport).not.toHaveBeenCalled()
  })

  it("rejects an unknown --transport, --operation, or --provider", async () => {
    const transport = run(["provider", "capabilities", "--transport", "carrier-pigeon"])
    expect(await transport.code).toBe(2)
    expect(transport.stderr()).toMatch(/--transport must be one of/)

    const operation = run(["provider", "capabilities", "--operation", "nope.nothing"])
    expect(await operation.code).toBe(2)
    expect(operation.stderr()).toMatch(/Unknown operation "nope.nothing"/)

    const provider = run(["provider", "capabilities", "--provider", "ghost"])
    expect(await provider.code).toBe(2)
    expect(provider.stderr()).toMatch(/not configured/)
  })

  it("reports a config error as exit 2", async () => {
    const r = run(["provider", "models"], {
      loadConfig: () => {
        throw new Error("config.json is not valid JSON")
      },
    })
    expect(await r.code).toBe(2)
    expect(r.stderr()).toMatch(/Config error: config.json/)
  })

  it("capabilities: lists every cell per provider with the transport header", async () => {
    const r = run(["provider", "capabilities"])
    expect(await r.code).toBe(0)
    const text = r.stdout()
    expect(text).toContain("Transport: this process (local operation executor)")
    expect(text).toContain("skipped bridge: no desktop")
    expect(text).toMatch(/Contract v1: 50 operations/)
    expect(text).toContain("\nopenai\n")
    expect(text).toContain("\ndeepseek\n")
    expect(text).toContain("batches.create           unsupported unavailable  no batch API")
  })

  it("capabilities --json --operation: one record, filtered cells", async () => {
    const r = run([
      "provider",
      "capabilities",
      "--json",
      "--provider",
      "openai",
      "--operation",
      "models.list",
    ])
    expect(await r.code).toBe(0)
    expect(r.stdout()).toBe("")
    expect(r.records).toHaveLength(1)
    const record = r.records[0] as {
      verb: string
      operationFilter: string
      providers: Array<{ providerId: string; profile: ProviderOperationProfile }>
    }
    expect(record.verb).toBe("capabilities")
    expect(record.operationFilter).toBe("models.list")
    expect(record.providers.map((p) => p.providerId)).toEqual(["openai"])
    expect(record.providers[0]!.profile.cells.map((c) => c.operationId)).toEqual(["models.list"])
  })

  it("models: forwards --refresh and prints the inventory line", async () => {
    const r = run(["provider", "models", "--refresh"])
    expect(await r.code).toBe(0)
    expect(executor.execute).toHaveBeenCalledWith("models.list", "openai", { refresh: true }, {})
    expect(r.stdout()).toContain(
      "openai: 1 models (catalog-static, static, fetched 2026-09-02T12:00:00.000Z)"
    )
    expect(r.stdout()).toContain("  gpt-4o  GPT-4o  128k ctx")
  })

  it("balance/limits --live: run the shared enumerator once and print meters", async () => {
    const snapshots: ProviderLimits[] = [
      {
        provider: "deepseek",
        accountId: "deepseek",
        fetchedAt: NOW,
        meters: [
          {
            id: "credit",
            kind: "balance",
            usedPct: null,
            remaining: 3,
            total: 10,
            currency: "USD",
            status: "ok",
          },
          { id: "session", kind: "window", usedPct: 10, status: "ok" },
        ],
      },
    ]
    const loadLimits = jest.fn(async () => snapshots)
    const balance = run(["provider", "balance", "--live"], { loadLimits })
    expect(await balance.code).toBe(0)
    expect(loadLimits).toHaveBeenCalledWith(CONFIG, NOW)
    expect(balance.stdout()).toContain("credit             3 USD of 10 USD remaining  [ok]")
    expect(balance.stdout()).not.toContain("session")

    const limits = run(["provider", "limits", "--live", "--json"], { loadLimits })
    expect(await limits.code).toBe(0)
    expect(
      (limits.records[0] as { snapshots: ProviderLimits[] }).snapshots[0]!.meters.map((m) => m.id)
    ).toEqual(["session"])
  })

  it("balance: exit 1 when a snapshot carries an error", async () => {
    const loadLimits = async (): Promise<ProviderLimits[]> => [
      { provider: "openai", accountId: "openai", fetchedAt: NOW, meters: [], error: "HTTP 401" },
    ]
    const r = run(["provider", "balance", "--live"], { loadLimits })
    expect(await r.code).toBe(1)
    expect(r.stdout()).toContain("error: HTTP 401")
  })

  it("usage: reads the ledger over the given window and says how rows were attributed", async () => {
    const r = run(["provider", "usage", "--days", "3"])
    expect(await r.code).toBe(0)
    expect(executor.execute).toHaveBeenCalledWith("usage.local.read", "openai", {
      from: NOW - 3 * 86_400_000,
      to: NOW,
      providerId: "openai",
    })
    expect(r.stdout()).toContain("Usage 2026-08-30 to 2026-09-02")
    expect(r.stdout()).toContain("Recorded ledger (exact attribution)")
    expect(r.stdout()).toContain("CLI sessions (0 in window, 0 without usage)")
  })

  it("usage: rejects a non-positive --days", async () => {
    const r = run(["provider", "usage", "--days", "0"])
    expect(await r.code).toBe(2)
    expect(r.stderr()).toMatch(/--days must be a positive number/)
  })

  it("probe --live --yes: probes locally when no plane is attached", async () => {
    const r = run(["provider", "probe", "--live", "--yes", "--provider", "openai"])
    expect(await r.code).toBe(0)
    expect(executor.execute).toHaveBeenCalledWith("health.probe", "openai", {}, {})
    expect(r.stdout()).toContain("ok   openai           42ms auth HTTP 200")
  })

  it("probe --json: exit 1 when a provider is unreachable", async () => {
    const failing: CliProviderExecutor = {
      execute: jest.fn(async (operationId, providerId) => ({
        ok: true as const,
        operationId,
        providerId,
        support: "native" as const,
        output: { reachable: false, capabilityVerified: false, durationMs: 1 },
      })) as CliProviderExecutor["execute"],
    }
    const r = run(["provider", "probe", "--live", "--yes", "--json"], {
      createExecutor: () => failing,
    })
    expect(await r.code).toBe(1)
    expect((r.records[0] as { via: string }).via).toBe("local")
  })
})
