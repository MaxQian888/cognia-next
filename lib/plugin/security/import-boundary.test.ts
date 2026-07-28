import { assertNoHostPrivateImports, findHostPrivateImports } from "./import-boundary"

describe("plugin import boundary", () => {
  it("detects all host-private aliases", () => {
    expect(
      findHostPrivateImports(`
        import type { Plugin } from "@/types/plugin"
        import "@/lib/plugin/private"
        const component = require("@/components/private")
        const store = import("@/stores/private")
      `)
    ).toEqual([
      "@/types/plugin",
      "@/lib/plugin/private",
      "@/components/private",
      "@/stores/private",
    ])
  })

  it("allows public SDK, UI, and third-party modules", () => {
    expect(
      findHostPrivateImports(`
        import { definePlugin } from "@cognia/plugin-sdk"
        import { Button } from "@cognia/plugin-ui"
        import ky from "ky"
      `)
    ).toEqual([])
  })

  it("reports the plugin source when rejecting a bundle", () => {
    expect(() =>
      assertNoHostPrivateImports('require("@/lib/secrets")', "/plugins/demo/index.js")
    ).toThrow(
      "Marketplace plugin /plugins/demo/index.js imports host-private modules: @/lib/secrets"
    )
  })
})
