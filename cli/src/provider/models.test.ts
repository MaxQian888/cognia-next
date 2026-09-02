/**
 * @jest-environment node
 */
import { DEFAULT_BUILTIN_TOOLS } from "@cognia/agent-config-types"
import { modelsListOutput } from "@cognia/provider-types"

import type { ResolvedConfig } from "../config/schema"
import type { CliProviderExecutor } from "./local"
import { formatModelLine, listProviderModels } from "./models"

const CONFIG: ResolvedConfig = {
  provider: "openai",
  permissionMode: "default",
  builtinTools: { ...DEFAULT_BUILTIN_TOOLS },
  providers: { openai: { apiKey: "sk" } },
  cwd: "/w",
}

const LISTING = modelsListOutput.parse({
  models: [{ id: "gpt-4o", name: "GPT-4o", contextLength: 128_000 }, { id: "o3-mini" }],
  source: "remote-discovered",
  freshness: "fresh",
  fetchedAt: 1_700_000_000_000,
})

describe("listProviderModels", () => {
  it("asks the active provider through models.list and forwards --refresh", async () => {
    const execute = jest.fn(async () => ({
      ok: true as const,
      operationId: "models.list" as const,
      providerId: "openai",
      support: "native" as const,
      output: LISTING,
    }))
    const report = await listProviderModels({
      config: CONFIG,
      executor: { execute } as unknown as CliProviderExecutor,
      refresh: true,
    })
    expect(execute).toHaveBeenCalledWith("models.list", "openai", { refresh: true }, {})
    expect(report.providerId).toBe("openai")
    expect(report.listing?.models.map((m) => m.id)).toEqual(["gpt-4o", "o3-mini"])
  })

  it("sends an empty input without --refresh and honours --provider", async () => {
    const execute = jest.fn(async () => ({
      ok: false as const,
      operationId: "models.list" as const,
      availability: "needs-auth" as const,
      failure: { code: "authentication" as const, retryable: false, message: "no key" },
    }))
    const report = await listProviderModels({
      config: CONFIG,
      executor: { execute } as unknown as CliProviderExecutor,
      providerId: "anthropic",
    })
    expect(execute).toHaveBeenCalledWith("models.list", "anthropic", {}, {})
    expect(report.failure?.availability).toBe("needs-auth")
    expect(report.listing).toBeUndefined()
  })
})

describe("formatModelLine", () => {
  it("adds the display name only when it differs, and the context in k", () => {
    expect(formatModelLine(LISTING.models[0]!)).toBe("gpt-4o  GPT-4o  128k ctx")
    expect(formatModelLine(LISTING.models[1]!)).toBe("o3-mini")
    expect(formatModelLine({ id: "x", name: "x", contextLength: 4096 })).toBe("x  4k ctx")
  })
})
