/**
 * Config canary for the AI SDK 7 upgrade — not a test of our own code.
 *
 * AI SDK 7 is ESM-only (`"type": "module"`, no CJS dist). Jest runs on the
 * CommonJS runtime here, so every `ai` / `@ai-sdk/*` package (and their
 * ESM-only transitive deps) must be transformed, which takes entries in BOTH:
 *
 *   - `transpilePackages` in `next.config.ts` — next/jest prepends two
 *     `transformIgnorePatterns` built from this list, and its `.pnpm` rule
 *     excludes every virtual-store path not named there.
 *   - `transformIgnorePatterns` in `jest.config.ts` — evaluated at every
 *     `/node_modules/` boundary, including the inner one of pnpm's
 *     `.pnpm/<pkg>@<ver>/node_modules/<scope>/<pkg>` layout.
 *
 * Miss either one and the failure is `SyntaxError: Cannot use import statement
 * outside a module` from deep inside a vendor file — which reads like a broken
 * test, not a broken config. This suite makes that failure say what it is.
 *
 * It deliberately does NOT mock `ai`: the point is to load the real ESM build.
 */

import { generateText, isStepCount, streamText, tool } from "ai"
import { createOpenAI } from "@ai-sdk/openai"
import { createAnthropic } from "@ai-sdk/anthropic"

describe("AI SDK 7 ESM interop under Jest", () => {
  it("loads the real (unmocked) ESM build of `ai`", () => {
    expect(typeof streamText).toBe("function")
    expect(typeof generateText).toBe("function")
    expect(typeof tool).toBe("function")
  })

  it("exposes the v7 stop-condition helper name", () => {
    // `stepCountIs` was renamed to `isStepCount` in v7 (the old name survives as
    // a deprecated alias). Importing the new name proves we are really on v7.
    expect(typeof isStepCount).toBe("function")
  })

  it("loads provider packages, which are ESM-only too", () => {
    expect(typeof createOpenAI).toBe("function")
    expect(typeof createAnthropic).toBe("function")
  })

  it("pulls the ESM-only transitive dependency chain without a CJS trip", async () => {
    // `@ai-sdk/provider-utils@5` depends on `@workflow/serde` and
    // `@standard-schema/spec`, both `"type": "module"`. Reaching a symbol that
    // lives behind that chain is what actually exercises it.
    const provider = createOpenAI({ apiKey: "test-key-not-used" })
    expect(typeof provider.languageModel).toBe("function")
  })
})
