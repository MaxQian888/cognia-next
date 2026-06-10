/**
 * @jest-environment node
 */
import { DEFAULT_RESOLVED_CONFIG } from "../../config/schema"
import type { ResolvedConfig } from "../../config/schema"

import { collectModelOptions } from "./model-options"

const base = (over: Partial<ResolvedConfig>): ResolvedConfig => ({
  ...DEFAULT_RESOLVED_CONFIG,
  cwd: "/work",
  ...over,
})

describe("collectModelOptions", () => {
  it("includes the active model and each provider model, de-duplicated", () => {
    const cfg = base({
      model: "a",
      providers: { p1: { model: "b" }, p2: { model: "a" }, p3: {} },
    })
    expect(collectModelOptions(cfg)).toEqual(["a", "b"])
  })

  it("returns [] when no models are configured", () => {
    expect(collectModelOptions(base({ providers: {} }))).toEqual([])
  })
})
