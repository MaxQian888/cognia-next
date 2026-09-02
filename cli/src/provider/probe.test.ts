/**
 * @jest-environment node
 */
import { DEFAULT_BUILTIN_TOOLS } from "@cognia/agent-config-types"

import type { ResolvedConfig } from "../config/schema"
import type { CliProviderExecutor } from "./local"
import {
  GATEWAY_PROBE_COMMAND,
  formatGatewayProbeRow,
  formatLocalProbeRow,
  probeProviders,
} from "./probe"
import { localProviderTransport, type ProviderTransport } from "./transport"

const CONFIG: ResolvedConfig = {
  provider: "openai",
  permissionMode: "default",
  builtinTools: { ...DEFAULT_BUILTIN_TOOLS },
  providers: { openai: { apiKey: "o" }, anthropic: { apiKey: "a" } },
  cwd: "/w",
}

const executor: CliProviderExecutor = {
  execute: jest.fn(async (operationId, providerId) =>
    providerId === "anthropic"
      ? {
          ok: false as const,
          operationId,
          availability: "needs-auth" as const,
          failure: { code: "authentication" as const, retryable: false, message: "401" },
        }
      : {
          ok: true as const,
          operationId,
          providerId,
          support: "native" as const,
          output: {
            reachable: true,
            authenticated: true,
            capabilityVerified: true,
            durationMs: 120,
            httpStatus: 200,
          },
        }
  ) as CliProviderExecutor["execute"],
}

function attached(
  kind: "bridge" | "rpc",
  supports: boolean | null,
  execute: ProviderTransport["execute"]
): ProviderTransport {
  return { kind, label: `${kind} plane`, manifest: null, supportsCommand: () => supports, execute }
}

describe("probeProviders", () => {
  beforeEach(() => jest.clearAllMocks())

  it("probes every configured provider locally through health.probe when nothing is attached", async () => {
    const report = await probeProviders({
      config: CONFIG,
      executor,
      transport: localProviderTransport(),
      timeoutMs: 5000,
    })
    expect(report.via).toBe("local")
    if (report.via !== "local") return
    expect(report.degraded).toBeUndefined()
    expect(report.rows.map((r) => r.providerId)).toEqual(["openai", "anthropic"])
    expect(report.rows[0]!.result?.reachable).toBe(true)
    expect(report.rows[1]!.failure?.availability).toBe("needs-auth")
    expect(executor.execute).toHaveBeenCalledWith("health.probe", "openai", { timeoutMs: 5000 }, {})
  })

  it("runs the gateway probe when the attached desktop exposes it and a model is named", async () => {
    const execute = jest.fn(async () => ({
      ok: true as const,
      result: [
        { providerId: "openai", modelId: "gpt-4o", ok: true, status: 200, latencyMs: 310 },
        {
          providerId: "azure",
          modelId: "gpt-4o",
          ok: false,
          status: 401,
          latencyMs: 90,
          error: "bad key",
        },
        "junk",
      ],
    }))
    const report = await probeProviders({
      config: CONFIG,
      executor,
      transport: attached("bridge", true, execute),
      model: "gpt-4o",
    })
    expect(execute).toHaveBeenCalledWith(GATEWAY_PROBE_COMMAND, { model: "gpt-4o" })
    expect(executor.execute).not.toHaveBeenCalled()
    expect(report.via).toBe("gateway")
    if (report.via !== "gateway") return
    expect(report.model).toBe("gpt-4o")
    expect(report.rows).toEqual([
      { providerId: "openai", modelId: "gpt-4o", ok: true, status: 200, latencyMs: 310 },
      {
        providerId: "azure",
        modelId: "gpt-4o",
        ok: false,
        status: 401,
        latencyMs: 90,
        error: "bad key",
      },
    ])
  })

  it("degrades to the local probe when the desktop does not carry the command", async () => {
    const execute = jest.fn()
    const report = await probeProviders({
      config: CONFIG,
      executor,
      transport: attached("bridge", false, execute),
      model: "gpt-4o",
      providerId: "openai",
    })
    expect(execute).not.toHaveBeenCalled()
    expect(report.via).toBe("local")
    if (report.via !== "local") return
    expect(report.degraded).toMatch(/does not expose gateway_probe_upstream/)
    expect(report.rows.map((r) => r.providerId)).toEqual(["openai"])
    expect(report.rows[0]!.model).toBe("gpt-4o")
  })

  it("tries the rpc plane, then degrades when it answers unknown_command", async () => {
    const execute = jest.fn(async () => ({
      ok: false as const,
      reason: "unavailable" as const,
      message: "no such command",
    }))
    const report = await probeProviders({
      config: CONFIG,
      executor,
      transport: attached("rpc", null, execute),
      model: "gpt-4o",
    })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(report.via).toBe("local")
    if (report.via !== "local") return
    expect(report.degraded).toBe("rpc plane: no such command")
  })

  it("explains that the gateway probe needs a model", async () => {
    const execute = jest.fn()
    const report = await probeProviders({
      config: CONFIG,
      executor,
      transport: attached("bridge", true, execute),
    })
    expect(execute).not.toHaveBeenCalled()
    expect(report.via).toBe("local")
    if (report.via !== "local") return
    expect(report.degraded).toMatch(/needs --model/)
  })
})

describe("format rows", () => {
  it("renders gateway rows with status and error", () => {
    expect(
      formatGatewayProbeRow({
        providerId: "openai",
        modelId: "gpt-4o",
        ok: true,
        status: 200,
        latencyMs: 310,
      })
    ).toBe("ok   openai           gpt-4o                       310ms HTTP 200")
    expect(
      formatGatewayProbeRow({
        providerId: "azure",
        modelId: "gpt-4o",
        ok: false,
        latencyMs: 9,
        error: "bad key",
      })
    ).toBe("FAIL azure            gpt-4o                       9ms  bad key")
  })

  it("renders local rows from the probe result or the failure", () => {
    expect(
      formatLocalProbeRow({
        providerId: "openai",
        result: {
          reachable: true,
          authenticated: true,
          capabilityVerified: true,
          durationMs: 120,
          httpStatus: 200,
        },
      })
    ).toBe("ok   openai           120ms auth HTTP 200")
    expect(
      formatLocalProbeRow({
        providerId: "openai",
        result: {
          reachable: true,
          authenticated: false,
          capabilityVerified: false,
          durationMs: 80,
          httpStatus: 401,
          failure: { code: "authentication", retryable: false, message: "invalid key" },
        },
      })
    ).toBe("FAIL openai           80ms no-auth HTTP 401  invalid key")
    expect(
      formatLocalProbeRow({
        providerId: "anthropic",
        failure: {
          ok: false,
          operationId: "health.probe",
          availability: "needs-auth",
          failure: { code: "authentication", retryable: false, message: "no key" },
        },
      })
    ).toBe("FAIL anthropic        needs-auth: no key")
  })
})
