import en from "@/i18n/messages/en/routerFusion.json"

import { RouterFusionRefusalError } from "./faults"
import {
  isRouterFusionRefusal,
  refusalOf,
  routerFusionRefusalDiagnostic,
  type RefusalTranslator,
} from "./refusal-diagnostic"

const refusal = en.refusal as Record<string, string>

/** Mirrors the runtime translator: ICU `{code}` values, a missing key answers with its path. */
const translator = async (): Promise<RefusalTranslator> => (key, values) => {
  const template = refusal[key]
  if (template === undefined) return `routerFusion.refusal.${key}`
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => String(values?.[name] ?? ""))
}

describe("routerFusionRefusalDiagnostic", () => {
  it("[ACC:ISO-04] puts the translated refusal in the message and the evidence in detail", async () => {
    const diagnostic = await routerFusionRefusalDiagnostic({
      code: "RUN_BUDGET_EXHAUSTED",
      sessionId: "s1",
      reasons: ["HARD_CAP:openai::gpt-5", " "],
      spanId: "span-1",
      translator,
    })
    expect(diagnostic.code).toBe("routerFusionRefused")
    expect(diagnostic.retryable).toBe(false)
    expect(diagnostic.message).toBe(refusal.RUN_BUDGET_EXHAUSTED)
    expect(diagnostic.detail).toBe("RUN_BUDGET_EXHAUSTED\nHARD_CAP:openai::gpt-5")
    expect(diagnostic.meta).toEqual({
      sessionId: "s1",
      spanId: "span-1",
      extra: { refusalCode: "RUN_BUDGET_EXHAUSTED" },
    })
  })

  it("reports a cascade or panel run that stopped as a failed run, not a refusal", async () => {
    const diagnostic = await routerFusionRefusalDiagnostic({
      code: "VERIFICATION_FAILED",
      sessionId: "s1",
      kind: "failed",
      translator,
    })
    expect(diagnostic.code).toBe("routerFusionRunFailed")
    expect(diagnostic.severity).toBe("error")
    expect(diagnostic.message).toBe(refusal.VERIFICATION_FAILED)
    expect(diagnostic.meta?.extra).toEqual({ runErrorCode: "VERIFICATION_FAILED" })
  })

  it("names a code this build has no sentence for", async () => {
    const diagnostic = await routerFusionRefusalDiagnostic({
      code: "FROM_A_NEWER_HOST",
      sessionId: "s1",
      translator,
    })
    expect(diagnostic.message).toBe(refusal.unknown.replace("{code}", "FROM_A_NEWER_HOST"))
  })

  it("keeps the bare code when the translator cannot load", async () => {
    const diagnostic = await routerFusionRefusalDiagnostic({
      code: "SESSION_BUSY",
      sessionId: "s1",
      translator: async () => {
        throw new Error("bundle offline")
      },
    })
    expect(diagnostic.message).toBe("SESSION_BUSY")
  })
})

describe("refusalOf", () => {
  it("reads a refusal and its reasons, and ignores anything else", () => {
    const error = new RouterFusionRefusalError("ROUTE_NO_SOLUTION", "none", {
      reasons: ["NO_CANDIDATES:auto", 3],
    })
    expect(isRouterFusionRefusal(error)).toBe(true)
    expect(refusalOf(error)).toEqual({ code: "ROUTE_NO_SOLUTION", reasons: ["NO_CANDIDATES:auto"] })
    // Crossing a dynamic-import boundary can yield a second class identity.
    expect(
      refusalOf({ kind: "router_fusion_refusal", code: "PRICE_UNKNOWN", details: {} })
    ).toEqual({
      code: "PRICE_UNKNOWN",
      reasons: [],
    })
    expect(refusalOf(new Error("provider down"))).toBeNull()
  })
})
