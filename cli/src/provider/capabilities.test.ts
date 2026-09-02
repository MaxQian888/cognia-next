/**
 * @jest-environment node
 */
import { DEFAULT_BUILTIN_TOOLS } from "@cognia/agent-config-types"
import type { ProviderOperationCell, ProviderOperationProfile } from "@cognia/provider-types"

import { PROVIDER_OPERATION_MANIFEST } from "@/lib/ai/operations"

import type { ResolvedConfig } from "../config/schema"
import { formatCapabilityCell, readProviderCapabilities } from "./capabilities"
import type { CliProviderExecutor } from "./local"
import { localProviderTransport, type ProviderTransport } from "./transport"

const CONFIG: ResolvedConfig = {
  provider: "openai",
  permissionMode: "default",
  builtinTools: { ...DEFAULT_BUILTIN_TOOLS },
  providers: { openai: { apiKey: "sk" }, anthropic: { apiKey: "ak" } },
  cwd: "/w",
}

function profile(providerId: string): ProviderOperationProfile {
  return {
    providerId,
    computedAt: 1,
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
}

const executor: CliProviderExecutor = {
  execute: jest.fn(async (operationId, providerId) =>
    providerId === "anthropic"
      ? {
          ok: false as const,
          operationId,
          availability: "needs-auth" as const,
          failure: { code: "authentication" as const, retryable: false, message: "no key" },
        }
      : {
          ok: true as const,
          operationId,
          providerId,
          support: "derived" as const,
          output: profile(providerId),
        }
  ) as CliProviderExecutor["execute"],
}

describe("readProviderCapabilities", () => {
  it("reads one profile per configured provider off the local contract", async () => {
    const report = await readProviderCapabilities({
      config: CONFIG,
      executor,
      transport: localProviderTransport(),
    })
    expect(report.transport).toBe("local")
    expect(report.schemaVersion).toBe(PROVIDER_OPERATION_MANIFEST.schemaVersion)
    expect(report.operationCount).toBe(PROVIDER_OPERATION_MANIFEST.operations.length)
    expect(report.adminCommands).toEqual([])
    expect(report.providers.map((p) => p.providerId)).toEqual(["openai", "anthropic"])
    expect(report.providers[0]!.profile?.cells).toHaveLength(2)
    expect(report.providers[1]!.failure?.availability).toBe("needs-auth")
  })

  it("narrows to one provider and one operation", async () => {
    const report = await readProviderCapabilities({
      config: CONFIG,
      executor,
      transport: localProviderTransport(),
      providerId: "openai",
      operationId: "batches.create",
    })
    expect(report.operationFilter).toBe("batches.create")
    expect(report.providers).toHaveLength(1)
    expect(report.providers[0]!.profile?.cells.map((c) => c.operationId)).toEqual([
      "batches.create",
    ])
  })

  it("reports the attached desktop's contract version and admin commands", async () => {
    const bridge: ProviderTransport = {
      kind: "bridge",
      label: "desktop",
      manifest: {
        schemaVersion: 1,
        operations: PROVIDER_OPERATION_MANIFEST.operations.slice(0, 3),
        adminCommands: ["provider_catalog_status"],
      },
      supportsCommand: () => true,
      execute: async () => ({ ok: true, result: null }),
    }
    const report = await readProviderCapabilities({ config: CONFIG, executor, transport: bridge })
    expect(report.transport).toBe("bridge")
    expect(report.operationCount).toBe(3)
    expect(report.adminCommands).toEqual(["provider_catalog_status"])
  })
})

describe("formatCapabilityCell", () => {
  it("states the reason, the plugin, or the note", () => {
    const cells: ProviderOperationCell[] = [
      { operationId: "models.list", support: "native", availability: "ready", note: "cached" },
      {
        operationId: "batches.create",
        support: "unsupported",
        availability: "unavailable",
        reason: "no batch API",
      },
      {
        operationId: "images.generate",
        support: "plugin",
        availability: "ready",
        via: "acme:images",
      },
      {
        operationId: "files.upload",
        support: "unknown",
        availability: "unavailable",
        provenance: "probe-failed",
        freshness: "stale",
        failure: { code: "network", retryable: true, message: "timed out" },
        retry: { on: "manual" },
      },
    ]
    expect(cells.map(formatCapabilityCell)).toEqual([
      "models.list              native      ready        cached",
      "batches.create           unsupported unavailable  no batch API",
      "images.generate          plugin      ready        via acme:images",
      "files.upload             unknown     unavailable  probe-failed: timed out",
    ])
  })
})
