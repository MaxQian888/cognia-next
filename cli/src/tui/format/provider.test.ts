/**
 * @jest-environment node
 */
import type { ProviderOperationProfile } from "@cognia/provider-types"

import type { ProviderLimits } from "@/types/subscription"

import type { ProviderCapabilitiesReport } from "../../provider/capabilities"
import type { ProviderProbeReport } from "../../provider/probe"
import type { ProviderUsageReport } from "../../provider/usage"
import {
  formatCapabilitiesDocument,
  formatInspectDocument,
  formatMeterSummary,
  formatProbeDocument,
  formatProfileTable,
  formatUsageDocument,
  summarizeProfile,
} from "./provider"

const NOW = 1_700_000_000_000

const PROFILE: ProviderOperationProfile = {
  providerId: "openai",
  computedAt: NOW,
  cells: [
    {
      operationId: "batches.create",
      support: "unsupported",
      availability: "unavailable",
      reason: "no batch | API",
    },
    { operationId: "models.list", support: "native", availability: "ready", note: "cached" },
    { operationId: "images.generate", support: "plugin", availability: "ready", via: "acme:img" },
    {
      operationId: "files.upload",
      support: "unknown",
      availability: "unavailable",
      provenance: "probe-failed",
      freshness: "stale",
      failure: { code: "network", retryable: true, message: "timed out" },
      retry: { on: "manual" },
    },
  ],
}

describe("profile formatting", () => {
  it("orders served cells first and escapes pipes", () => {
    const table = formatProfileTable(PROFILE)
    const rows = table.split("\n").slice(2)
    expect(rows.map((r) => r.split("|")[1]!.trim())).toEqual([
      "`models.list`",
      "`images.generate`",
      "`files.upload`",
      "`batches.create`",
    ])
    expect(table).toContain("| `batches.create` | unsupported | unavailable | no batch \\| API |")
    expect(table).toContain("| `files.upload` | unknown | unavailable | probe-failed: timed out |")
    expect(table).toContain("| `images.generate` | plugin | ready | via acme:img |")
  })

  it("summarizes the histogram", () => {
    expect(summarizeProfile(PROFILE)).toBe("2 served · 1 unsupported · 1 unknown")
  })
})

describe("formatCapabilitiesDocument", () => {
  it("renders the header, the admin commands, and one section per provider", () => {
    const report: ProviderCapabilitiesReport = {
      transport: "bridge",
      transportLabel: "Cognia desktop bridge (http://127.0.0.1:1)",
      schemaVersion: 1,
      operationCount: 50,
      adminCommands: ["provider_catalog_status"],
      operationFilter: "models.list",
      providers: [
        { providerId: "openai", profile: PROFILE },
        {
          providerId: "anthropic",
          failure: {
            ok: false,
            operationId: "capabilities.read",
            availability: "needs-auth",
            failure: { code: "authentication", retryable: false, message: "no key" },
          },
        },
      ],
    }
    const doc = formatCapabilitiesDocument(report)
    expect(doc).toContain("Transport: Cognia desktop bridge")
    expect(doc).toContain(
      "Contract v1: 50 operations, desktop admin commands: `provider_catalog_status`"
    )
    expect(doc).toContain("Filter: `models.list`")
    expect(doc).toContain("## openai\n\n2 served · 1 unsupported · 1 unknown")
    expect(doc).toContain("## anthropic\n\nneeds-auth: no key")
  })
})

describe("formatUsageDocument", () => {
  it("renders both ledgers, the attribution legend, and the unknown-cost rule", () => {
    const report: ProviderUsageReport = {
      from: Date.parse("2026-08-26T00:00:00Z"),
      to: Date.parse("2026-09-02T00:00:00Z"),
      ledger: {
        rows: [
          {
            providerId: "openai",
            model: "gpt-4o",
            attribution: "exact",
            turns: 0,
            inputTokens: 1500,
            outputTokens: 2_000_000,
            costUsd: 0.5,
            costKnown: true,
          },
        ],
        failures: [
          {
            providerId: "groq",
            failure: {
              ok: false,
              operationId: "usage.local.read",
              availability: "needs-config",
              failure: { code: "schema", retryable: false, message: "bad window" },
            },
          },
        ],
      },
      sessions: {
        rows: [
          {
            model: "mystery",
            attribution: "approximate",
            turns: 2,
            inputTokens: 10,
            outputTokens: 5,
            costUsd: 0,
            costKnown: false,
          },
        ],
        scanned: 3,
        withoutUsage: 1,
        catalogAttributed: 0,
        approximate: 1,
      },
    }
    const doc = formatUsageDocument(report)
    expect(doc).toContain("# Provider usage 2026-08-26 to 2026-09-02")
    expect(doc).toContain("| openai | `gpt-4o` | exact | 1.5k | 2.0M | $0.5000 |")
    expect(doc).toContain("- groq: bad window")
    expect(doc).toContain("## CLI sessions (3 in window, 1 without usage)")
    expect(doc).toContain("| ? | `mystery` | approximate | 10 | 5 | unknown |")
    expect(doc).toContain("`approximate` rows are aliases")
    expect(doc).toContain("It is not free.")
  })

  it("says when the database could not open", () => {
    const doc = formatUsageDocument({
      from: 0,
      to: 1,
      ledger: { rows: [], failures: [], unavailable: "snapshot corrupt" },
      sessions: { rows: [], scanned: 0, withoutUsage: 0, catalogAttributed: 0, approximate: 0 },
    })
    expect(doc).toContain("Local database unavailable: snapshot corrupt")
    expect(doc).toContain("_(no rows)_")
  })
})

describe("formatProbeDocument", () => {
  it("renders gateway candidates", () => {
    const report: ProviderProbeReport = {
      via: "gateway",
      transportLabel: "desktop",
      model: "gpt-4o",
      rows: [
        { providerId: "openai", modelId: "gpt-4o", ok: true, status: 200, latencyMs: 310 },
        { providerId: "azure", modelId: "gpt-4o", ok: false, latencyMs: 9, error: "bad key" },
      ],
    }
    const doc = formatProbeDocument(report)
    expect(doc).toContain("Gateway probe for `gpt-4o` (2 candidates)")
    expect(doc).toContain("| ok | openai | `gpt-4o` | 310ms | 200 |  |")
    expect(doc).toContain("| FAIL | azure | `gpt-4o` | 9ms |  | bad key |")
  })

  it("renders local rows with the degradation note", () => {
    const report: ProviderProbeReport = {
      via: "local",
      transportLabel: "rpc plane",
      degraded: "rpc plane: no such command",
      rows: [
        {
          providerId: "openai",
          result: {
            reachable: true,
            authenticated: true,
            capabilityVerified: true,
            durationMs: 42,
          },
        },
        {
          providerId: "anthropic",
          failure: {
            ok: false,
            operationId: "health.probe",
            availability: "needs-auth",
            failure: { code: "authentication", retryable: false, message: "no key" },
          },
        },
      ],
    }
    const doc = formatProbeDocument(report)
    expect(doc).toContain("Note: rpc plane: no such command")
    expect(doc).toContain("| ok | openai | 42ms | yes |  |  |")
    expect(doc).toContain("| FAIL | anthropic | | | needs-auth | no key |")
    expect(formatProbeDocument({ via: "local", transportLabel: "x", rows: [] })).toContain(
      "_(no configured provider to probe)_"
    )
  })
})

describe("formatInspectDocument", () => {
  it("combines the inventory and the profile", () => {
    const doc = formatInspectDocument({
      providerId: "openai",
      transportLabel: "local",
      capabilities: { providerId: "openai", profile: PROFILE },
      models: {
        providerId: "openai",
        listing: {
          models: [{ id: "gpt-4o", name: "GPT-4o", contextLength: 128_000 }, { id: "o3" }],
          source: "remote-discovered",
          freshness: "fresh",
          fetchedAt: NOW,
        },
      },
    })
    expect(doc).toContain("# openai")
    expect(doc).toContain("2 models (remote-discovered, fresh, fetched 2023-11-14T22:13:20.000Z)")
    expect(doc).toContain("- `gpt-4o` GPT-4o · 128k ctx")
    expect(doc).toContain("- `o3`")
    expect(doc).toContain("2 served · 1 unsupported · 1 unknown")
  })
})

describe("formatMeterSummary", () => {
  it("reuses the /limits labels and countdowns", () => {
    const snapshots: ProviderLimits[] = [
      {
        provider: "anthropic",
        accountId: "anthropic",
        fetchedAt: NOW,
        meters: [
          { id: "session", kind: "window", usedPct: 42, resetAt: NOW + 95 * 60_000, status: "ok" },
        ],
      },
      {
        provider: "deepseek",
        accountId: "deepseek",
        fetchedAt: NOW,
        meters: [
          {
            id: "credit",
            kind: "balance",
            usedPct: null,
            remaining: 8.5,
            currency: "CNY",
            status: "ok",
          },
        ],
        error: "stale",
      },
    ]
    expect(formatMeterSummary(snapshots, NOW)).toBe(
      [
        "anthropic: Current session 42% used (Resets in 1h 35m)",
        "deepseek: stale",
        "deepseek: Credit balance ¥8.50 left",
      ].join("\n")
    )
    expect(formatMeterSummary([], NOW)).toBe("")
  })
})
