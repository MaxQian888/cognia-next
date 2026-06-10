/**
 * @jest-environment node
 */
import { DEFAULT_RESOLVED_CONFIG } from "../../config/schema"
import type { ResolvedConfig } from "../../config/schema"

import { createInitialState } from "./initial"
import { canSubmit, hasInflight, hasOverlay, isBusy } from "./selectors"

const config: ResolvedConfig = { ...DEFAULT_RESOLVED_CONFIG, cwd: "/work" }
const base = () => createInitialState(config, "ses1")

describe("selectors", () => {
  it("isBusy reflects a non-idle turn", () => {
    expect(isBusy(base())).toBe(false)
    expect(isBusy({ ...base(), turnStatus: "streaming" })).toBe(true)
  })

  it("hasOverlay reflects an open modal", () => {
    expect(hasOverlay(base())).toBe(false)
    expect(hasOverlay({ ...base(), overlay: { kind: "help" } })).toBe(true)
  })

  it("canSubmit requires idle and no overlay", () => {
    expect(canSubmit(base())).toBe(true)
    expect(canSubmit({ ...base(), turnStatus: "streaming" })).toBe(false)
    expect(canSubmit({ ...base(), overlay: { kind: "help" } })).toBe(false)
  })

  it("hasInflight reflects pending text or reasoning", () => {
    expect(hasInflight(base())).toBe(false)
    expect(hasInflight({ ...base(), inflight: { text: "x", thinking: "" } })).toBe(true)
    expect(hasInflight({ ...base(), inflight: { text: "", thinking: "y" } })).toBe(true)
  })
})
