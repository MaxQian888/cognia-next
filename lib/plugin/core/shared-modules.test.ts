/** @jest-environment jsdom */

import {
  PLUGIN_SHARED_MODULES,
  __resetSharedModulesForTest,
  createPluginRequire,
  isSharedModuleSpecifier,
  primeSharedModules,
  primeSharedModulesFor,
  sharedModulesReferencedBy,
} from "./shared-modules"

beforeEach(() => {
  __resetSharedModulesForTest()
})

describe("PLUGIN_SHARED_MODULES", () => {
  it("shares react and its jsx runtimes", () => {
    expect(PLUGIN_SHARED_MODULES).toEqual(
      expect.arrayContaining(["react", "react/jsx-runtime", "react/jsx-dev-runtime"])
    )
  })

  it("shares the plugin SDK and UI kit", () => {
    expect(PLUGIN_SHARED_MODULES).toEqual(
      expect.arrayContaining(["@cognia/plugin-sdk", "@cognia/plugin-ui", "lucide-react"])
    )
  })

  /**
   * `api/effort-surface` READS the host's settings and agent-runtime stores,
   * and most other subpaths are registries (`api/skill` exports
   * `registerSkill`, `api/i18n` exports `registerPluginI18n`): a copy inlined
   * into a bundle answers from, and writes into, state the host never sees.
   * So every published subpath binds to the host instance — and only the
   * published ones: an unpublished deep path is still refused.
   */
  it("shares every published SDK subpath and nothing else under the package", () => {
    expect(PLUGIN_SHARED_MODULES).toContain("@cognia/plugin-sdk/api/effort-surface")
    expect(isSharedModuleSpecifier("@cognia/plugin-sdk/api/effort-surface")).toBe(true)
    expect(isSharedModuleSpecifier("@cognia/plugin-sdk/api/skill")).toBe(true)
    expect(isSharedModuleSpecifier("@cognia/plugin-sdk/api/i18n")).toBe(true)
    expect(isSharedModuleSpecifier("@cognia/plugin-sdk/manifest")).toBe(true)
    expect(isSharedModuleSpecifier("@cognia/plugin-sdk/src/api/skill")).toBe(false)
    expect(isSharedModuleSpecifier("@cognia/plugin-sdk/api/not-a-subpath")).toBe(false)
  })

  it("does NOT share react-dom", () => {
    // Sharing react-dom hands plugins createPortal, which lets a slot
    // contribution render outside the slot it was mounted into — escaping both
    // the ErrorBoundary and the @scope-d stylesheet that bound it.
    expect(PLUGIN_SHARED_MODULES).not.toContain("react-dom")
    expect(PLUGIN_SHARED_MODULES).not.toContain("react-dom/client")
  })

  it("recognises exactly the listed specifiers", () => {
    for (const specifier of PLUGIN_SHARED_MODULES) {
      expect(isSharedModuleSpecifier(specifier)).toBe(true)
    }
    for (const specifier of ["react-dom", "dexie", "@/lib/utils", "react/compiler-runtime", ""]) {
      expect(isSharedModuleSpecifier(specifier)).toBe(false)
    }
  })
})

describe("createPluginRequire", () => {
  it("hands back the host's react instance after priming", async () => {
    await primeSharedModules()
    const req = createPluginRequire("/plugins/demo/dist/index.js")
    const react = req("react") as { useState?: unknown; createElement?: unknown }
    expect(typeof react.useState).toBe("function")
    expect(typeof react.createElement).toBe("function")
  })

  it("hands back the SAME react the host renders with", async () => {
    // The whole point: one dispatcher. If these differ, hooks inside a plugin
    // component throw "Invalid hook call" at render time.
    await primeSharedModules()
    const hostReact = await import("react")
    const req = createPluginRequire("/plugins/demo/dist/index.js")
    const pluginReact = req("react") as { useState: unknown }
    expect(pluginReact.useState).toBe(hostReact.useState)
  })

  it("hands back the jsx runtime esbuild's automatic transform emits", async () => {
    await primeSharedModules()
    const req = createPluginRequire("/plugins/demo/dist/index.js")
    const runtime = req("react/jsx-runtime") as Record<string, unknown>
    expect(typeof runtime.jsx).toBe("function")
    expect(typeof runtime.jsxs).toBe("function")
  })

  it("hands back the plugin UI kit", async () => {
    await primeSharedModules()
    const req = createPluginRequire("/plugins/demo/dist/index.js")
    const kit = req("@cognia/plugin-ui") as Record<string, unknown>
    expect(typeof kit.Button).toBe("function")
    expect(typeof kit.cn).toBe("function")
  })

  it("hands back the host lucide registry", async () => {
    await primeSharedModules()
    const req = createPluginRequire("/plugins/demo/dist/index.js")
    const lucide = req("lucide-react") as Record<string, unknown>
    expect(lucide.Search).toBeDefined()
    expect(typeof lucide.icons).toBe("object")
  })

  it("throws for a non-whitelisted specifier and names it", async () => {
    await primeSharedModules()
    const req = createPluginRequire("/plugins/demo/dist/index.js")
    expect(() => req("dexie")).toThrow(/require\("dexie"\) is not available to plugins/)
  })

  it("names react-dom as unavailable rather than silently returning undefined", async () => {
    await primeSharedModules()
    const req = createPluginRequire("/plugins/demo/dist/index.js")
    expect(() => req("react-dom")).toThrow(/not available to plugins/)
  })

  it("puts the offending plugin path in the error", async () => {
    await primeSharedModules()
    const req = createPluginRequire("/plugins/broken/dist/index.js")
    expect(() => req("node:fs")).toThrow(/\/plugins\/broken\/dist\/index\.js/)
  })

  it("lists the shared modules in the error so the author knows the way out", async () => {
    await primeSharedModules()
    const req = createPluginRequire("/plugins/demo/dist/index.js")
    expect(() => req("lodash")).toThrow(/react, react\/jsx-runtime/)
  })

  it("reports a whitelisted-but-unprimed specifier distinctly", () => {
    // Never primed: the specifier is legal but the instance is missing, which
    // is a host problem and reads differently from a plugin bundling mistake.
    const req = createPluginRequire("/plugins/demo/dist/index.js")
    expect(() => req("react")).toThrow(/shared by the host but was not available/)
  })
})

describe("primeSharedModules", () => {
  it("is idempotent and shares one in-flight promise", async () => {
    const a = primeSharedModules()
    const b = primeSharedModules()
    expect(a).toBe(b)
    await Promise.all([a, b])
    const req = createPluginRequire("/plugins/demo/dist/index.js")
    expect(() => req("react")).not.toThrow()
  })

  it("resolves every whitelisted specifier in this runtime", async () => {
    await primeSharedModules()
    const req = createPluginRequire("/plugins/demo/dist/index.js")
    for (const specifier of PLUGIN_SHARED_MODULES) {
      expect(() => req(specifier)).not.toThrow()
    }
  })
})

describe("SDK subpaths referenced by a bundle", () => {
  it("finds exactly the published subpaths an esbuild CJS bundle requires", () => {
    const code = [
      'var i18n = require("@cognia/plugin-sdk/api/i18n");',
      "var sdk = require('@cognia/plugin-sdk');",
      'var nope = require("@cognia/plugin-sdk/api/not-a-subpath");',
      'var again = require( "@cognia/plugin-sdk/api/i18n" );',
    ].join("\n")
    expect(sharedModulesReferencedBy(code)).toEqual(["@cognia/plugin-sdk/api/i18n"])
  })

  it("primes a referenced subpath so require() returns the host's own module", async () => {
    await primeSharedModulesFor('require("@cognia/plugin-sdk/api/i18n")')
    const hostModule = await import("@cognia/plugin-sdk/api/i18n")
    const required = createPluginRequire("/plugins/x/index.js")(
      "@cognia/plugin-sdk/api/i18n"
    ) as typeof hostModule
    expect(required.registerPluginI18n).toBe(hostModule.registerPluginI18n)
  })
})
