import { cliConfigFileSchema } from "./schema"

/**
 * The CLI `customLimitsSources` schema must stay in sync with the canonical
 * `WindowSpec`/`DescriptorExtract` (`types/subscription/descriptor.ts`) and the
 * engine (`lib/subscription/limits/descriptor/engine.ts`). When the engine
 * gained count-based windows (`usedPath`/`totalPath`/`remainingPath`) and the
 * `select` array-element picker — so Coding Plan providers like MiniMax /
 * Kimi-coding can be expressed as config — the CLI schema has to accept the same
 * shapes, or a user's `config.json` carrying one fails to parse entirely.
 */
describe("cliConfigFileSchema.customLimitsSources", () => {
  it("parses a count-based (used/total) window source", () => {
    const parsed = cliConfigFileSchema.safeParse({
      customLimitsSources: [
        {
          id: "mm",
          name: "MiniMax",
          baseUrl: "https://api.minimaxi.com",
          token: "tok",
          request: { path: "/v1/api/openplatform/coding_plan/remains" },
          extract: {
            kind: "window",
            windows: [
              {
                id: "session",
                labelKey: "subscription.limits.meter.session",
                usedPath: "model_remains.0.current_interval_usage_count",
                totalPath: "model_remains.0.current_interval_total_count",
                resetAtPath: "model_remains.0.end_time",
                resetUnit: "unix",
              },
            ],
          },
        },
      ],
    })
    expect(parsed.success).toBe(true)
  })

  it("parses a remaining/total window source", () => {
    const parsed = cliConfigFileSchema.safeParse({
      customLimitsSources: [
        {
          id: "kc",
          name: "Kimi Coding",
          baseUrl: "https://api.kimi.com",
          token: "tok",
          request: { path: "/coding/v1/usages" },
          extract: {
            kind: "window",
            windows: [
              {
                id: "session",
                labelKey: "subscription.limits.meter.session",
                remainingPath: "usage.remaining",
                totalPath: "usage.limit",
                resetAtPath: "usage.resetTime",
                resetUnit: "unix",
              },
            ],
          },
        },
      ],
    })
    expect(parsed.success).toBe(true)
  })

  it("parses a `select` (discriminated-array) window source", () => {
    const parsed = cliConfigFileSchema.safeParse({
      customLimitsSources: [
        {
          id: "glm",
          name: "GLM",
          baseUrl: "https://api.z.ai",
          token: "raw-key",
          request: {
            path: "/api/monitor/usage/quota/limit",
            headers: { Authorization: "{{token}}" },
          },
          extract: {
            kind: "window",
            windows: [
              {
                id: "session",
                labelKey: "subscription.limits.meter.session",
                usedPctPath: "percentage",
                resetAtPath: "nextResetTime",
                resetUnit: "unix",
                select: {
                  arrayPath: "data.limits",
                  by: "TOKENS_LIMIT",
                  equals: "five_hour",
                },
              },
            ],
          },
        },
      ],
    })
    expect(parsed.success).toBe(true)
  })

  it("preserves the count-based fields through parse (parity with the engine)", () => {
    const parsed = cliConfigFileSchema.parse({
      customLimitsSources: [
        {
          id: "mm",
          name: "MiniMax",
          baseUrl: "https://api.minimaxi.com",
          token: "tok",
          request: { path: "/r" },
          extract: {
            kind: "window",
            windows: [
              {
                id: "session",
                labelKey: "k",
                usedPath: "u",
                totalPath: "t",
                select: { arrayPath: "a.b", by: "tag", equals: "x" },
              },
            ],
          },
        },
      ],
    })
    const w = parsed.customLimitsSources![0].extract
    if (w.kind === "window") {
      expect(w.windows[0]).toMatchObject({
        usedPath: "u",
        totalPath: "t",
        select: { arrayPath: "a.b", by: "tag", equals: "x" },
      })
    }
  })
})
