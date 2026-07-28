import type { PluginErrorEventDetail } from "@/lib/plugin/error-bus"

import { diagnosePluginError } from "./from-plugin-error"

const detail = (overrides: Partial<PluginErrorEventDetail> = {}): PluginErrorEventDetail => ({
  pluginId: "acme.tool",
  stage: "activation",
  message: "activation timed out",
  severity: "error",
  recoverable: true,
  ...overrides,
})

describe("diagnosePluginError", () => {
  it("keeps the bus's own recoverable verdict as retryability", () => {
    expect(diagnosePluginError(detail({ recoverable: true })).retryable).toBe(true)
    expect(diagnosePluginError(detail({ recoverable: false })).retryable).toBe(false)
  })

  it("treats a permanent plugin failure as a lasting condition", () => {
    // It stays true until the plugin itself ships a fix, so it belongs on a
    // durable record rather than a toast the user may never see.
    expect(diagnosePluginError(detail({ recoverable: false })).persistent).toBe(true)
    expect(diagnosePluginError(detail({ recoverable: true })).persistent).toBe(false)
  })

  it("maps the bus severity onto the diagnostic severity", () => {
    expect(diagnosePluginError(detail({ severity: "warning" })).severity).toBe("warning")
    expect(diagnosePluginError(detail({ severity: "error" })).severity).toBe("error")
  })

  it("records the pipeline stage as metadata, not as a cause", () => {
    // The bus classifies by WHERE it broke, never WHY — deriving a cause code
    // from `stage` would be a guess.
    const out = diagnosePluginError(detail({ stage: "config" }))
    expect(out.code).toBe("unknown")
    expect(out.meta).toEqual({ pluginId: "acme.tool", extra: { stage: "config" } })
  })

  it("includes the display name when the bus supplied one", () => {
    expect(diagnosePluginError(detail({ pluginName: "Acme Tool" })).meta.extra).toEqual({
      stage: "activation",
      pluginName: "Acme Tool",
    })
  })

  it("carries the raw message through untranslated", () => {
    expect(diagnosePluginError(detail()).message).toBe("activation timed out")
  })
})
