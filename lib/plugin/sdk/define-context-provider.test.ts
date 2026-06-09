import { defineContextProvider } from "./define-context-provider"
import type { PluginContextProvider } from "@/types/plugin/plugin-context-provider"

describe("defineContextProvider", () => {
  it("returns the provider unchanged (identity pass-through)", () => {
    const p: PluginContextProvider = { id: "ctx", provide: () => "x" }
    expect(defineContextProvider(p)).toBe(p)
  })
})
