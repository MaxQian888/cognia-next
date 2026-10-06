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

  it("covers every directory under the alias, not a hand-kept list", () => {
    // The old four-prefix list (@/lib, @/types, @/components, @/stores) let
    // `plugins/web-tools` import `@/packages/plugin-sdk/src/host` — a subpath
    // the SDK deliberately keeps out of package.json#exports and the tarball —
    // and the bundle still loaded. Nothing under `@/` resolves outside this
    // monorepo, so the alias itself is the boundary.
    expect(
      findHostPrivateImports(`
        import { gate } from "@/packages/plugin-sdk/src/host"
        import { useThing } from "@/hooks/ui/use-thing"
        import { thing } from "@/app/internal"
        import { other } from "@/plugins/sibling/src/index"
        import { util } from "@/utils/private"
        import { Button } from "@/ui/button"
      `)
    ).toEqual([
      "@/packages/plugin-sdk/src/host",
      "@/hooks/ui/use-thing",
      "@/app/internal",
      "@/plugins/sibling/src/index",
      "@/utils/private",
      "@/ui/button",
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
