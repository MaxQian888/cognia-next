/**
 * Drift guard: the renderer's protocol-adapter contracts and the sidecar's
 * executing implementation are maintained in two packages (sidecar/ is not
 * in the pnpm workspace). This test cross-imports the sidecar `.mjs` modules
 * (same precedent as `lib/a2ui/mcp-tool-schemas.test.ts`) and pins:
 *
 *  1. the builtin protocol sets stay in sync (renderer `gemini` ↔ sidecar
 *     `google` naming mapped explicitly),
 *  2. the declarative spec the renderer forwards validates against the
 *     sidecar adapter's own `validateSpec`,
 *  3. the spec's required keys match the sidecar's `SPEC_REQUIRED_KEYS`.
 */

import { BUILTIN_API_PROTOCOLS } from "@cognia/provider-types/provider"
import type { OpenAiCompatibleVariantSpec } from "./protocol-adapter-registry"
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain ESM JS from the sidecar package (no type declarations).
import { BUILTIN_PROTOCOLS as SIDECAR_BUILTIN_PROTOCOLS } from "../../../../sidecar/dispatch/protocol-adapters/registry.mjs"
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain ESM JS from the sidecar package (no type declarations).
import {
  SPEC_REQUIRED_KEYS,
  validateSpec,
} from "../../../../sidecar/dispatch/protocol-adapters/openai-compatible-variant-adapter.mjs"

/** The renderer name → sidecar/AI-SDK family name map (provider-consumption.ts). */
const RENDERER_TO_SIDECAR: Record<string, string> = { gemini: "google" }

describe("protocol-adapter renderer ↔ sidecar parity", () => {
  it("every renderer builtin protocol maps onto a sidecar builtin", () => {
    const sidecarSet = SIDECAR_BUILTIN_PROTOCOLS as Set<string>
    for (const p of BUILTIN_API_PROTOCOLS) {
      const sidecarName = RENDERER_TO_SIDECAR[p] ?? p
      expect(sidecarSet.has(sidecarName)).toBe(true)
    }
  })

  it("sidecar builtins not in the renderer set are AI-SDK-only families", () => {
    // mistral/cohere/azure/bedrock have no custom-provider picker entry — they're
    // configured as built-in catalog providers (azure/bedrock) or dispatched via
    // an aggregator — but all must be dispatchable; google is gemini's wire name.
    // Pin the exact remainder so an unnoticed addition forces a conscious update.
    const rendererMapped = new Set(BUILTIN_API_PROTOCOLS.map((p) => RENDERER_TO_SIDECAR[p] ?? p))
    const remainder = [...(SIDECAR_BUILTIN_PROTOCOLS as Set<string>)]
      .filter((p) => !rendererMapped.has(p))
      .sort()
    expect(remainder).toEqual(["azure", "bedrock", "cohere", "mistral"])
  })

  it("a canonical renderer spec validates against the sidecar adapter", () => {
    const spec: OpenAiCompatibleVariantSpec = {
      kind: "openai-compatible-variant",
      urlTemplate: "{baseURL}/v1/chat/completions",
      headers: { Authorization: "Bearer {apiKey}" },
      requestRenames: { maxOutputTokens: "max_tokens" },
      requestInject: { stream_options: { include_usage: true } },
      responsePaths: {
        textDelta: "choices[0].delta.content",
        reasoningDelta: "choices[0].delta.reasoning_content",
        finishReason: "choices[0].finish_reason",
        usage: {
          input: "usage.prompt_tokens",
          output: "usage.completion_tokens",
          cacheRead: "usage.prompt_tokens_details.cached_tokens",
          cacheCreation: "usage.prompt_tokens_details.cache_creation_tokens",
          reasoning: "usage.completion_tokens_details.reasoning_tokens",
        },
      },
    }
    expect(validateSpec(spec)).toBeNull()
  })

  it("the renderer's required spec keys match the sidecar contract", () => {
    // TypeScript enforces these as required on OpenAiCompatibleVariantSpec;
    // the sidecar enforces them at runtime. Keep the lists identical.
    expect([...SPEC_REQUIRED_KEYS].sort()).toEqual(["kind", "responsePaths", "urlTemplate"])
  })

  it("specs the sidecar rejects are also rejected by the renderer bridge shape", () => {
    expect(validateSpec({ kind: "openai-compatible-variant" })).toMatch(/urlTemplate/)
    expect(
      validateSpec({ kind: "openai-compatible-variant", urlTemplate: "u", responsePaths: {} })
    ).toMatch(/textDelta/)
    expect(validateSpec({ kind: "other" })).toMatch(/unknown spec kind/)
  })
})
