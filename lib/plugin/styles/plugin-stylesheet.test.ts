/** @jest-environment jsdom */

import {
  PLUGIN_ROOT_ATTRIBUTE,
  PLUGIN_STYLE_ATTRIBUTE,
  injectPluginStyles,
  loadPluginStyles,
  removePluginStyles,
  scopePluginCss,
  splitHoistedAtRules,
} from "./plugin-stylesheet"

afterEach(() => {
  document.head.querySelectorAll(`style[${PLUGIN_STYLE_ATTRIBUTE}]`).forEach((n) => n.remove())
})

describe("splitHoistedAtRules", () => {
  it("keeps ordinary style rules scoped", () => {
    const { hoisted, scoped } = splitHoistedAtRules(".a { color: red } .b { color: blue }")
    expect(hoisted).toBe("")
    expect(scoped).toContain(".a")
    expect(scoped).toContain(".b")
  })

  it("hoists top-level @keyframes, which @scope would otherwise drop", () => {
    const { hoisted, scoped } = splitHoistedAtRules(
      "@keyframes spin { from { rotate: 0deg } to { rotate: 360deg } } .x { animation: spin 1s }"
    )
    expect(hoisted).toContain("@keyframes spin")
    expect(hoisted).toContain("360deg")
    expect(scoped).toContain(".x")
    expect(scoped).not.toContain("@keyframes")
  })

  it("hoists @font-face, @property and @counter-style", () => {
    const css = [
      "@font-face { font-family: X; src: url(x.woff2) }",
      "@property --p { syntax: '<color>'; inherits: false; initial-value: red }",
      "@counter-style c { system: cyclic; symbols: '*' }",
      ".y { color: red }",
    ].join("\n")
    const { hoisted, scoped } = splitHoistedAtRules(css)
    expect(hoisted).toContain("@font-face")
    expect(hoisted).toContain("@property")
    expect(hoisted).toContain("@counter-style")
    expect(scoped).toContain(".y")
    expect(scoped).not.toContain("@font-face")
  })

  it("hoists statement at-rules that end in a semicolon, not a brace", () => {
    const { hoisted, scoped } = splitHoistedAtRules('@import url("x.css");\n.z { color: red }')
    expect(hoisted).toContain("@import")
    expect(scoped).toContain(".z")
    expect(scoped).not.toContain("@import")
  })

  it("keeps @media scoped — it styles elements rather than binding a name", () => {
    const { hoisted, scoped } = splitHoistedAtRules(
      "@media (min-width: 40px) { .m { color: red } }"
    )
    expect(hoisted).toBe("")
    expect(scoped).toContain("@media")
    expect(scoped).toContain(".m")
  })

  it("keeps @container scoped so plugins can be responsive inside their slot", () => {
    const { hoisted, scoped } = splitHoistedAtRules(
      "@container (min-width: 20rem) { .c { gap: 0 } }"
    )
    expect(hoisted).toBe("")
    expect(scoped).toContain("@container")
  })

  it("leaves @keyframes nested inside @media alone", () => {
    // Already inside a rule — hoisting it would change which media it applies to.
    const css = "@media print { @keyframes k { from { opacity: 0 } } }"
    const { hoisted, scoped } = splitHoistedAtRules(css)
    expect(hoisted).toBe("")
    expect(scoped).toContain("@media print")
    expect(scoped).toContain("@keyframes k")
  })

  it("does not miscount braces inside a string literal", () => {
    const css = `.a::after { content: "}" } @keyframes k { from { opacity: 0 } }`
    const { hoisted, scoped } = splitHoistedAtRules(css)
    expect(hoisted).toContain("@keyframes k")
    expect(scoped).toContain(".a::after")
    expect(scoped).not.toContain("@keyframes")
  })

  it("does not miscount braces inside a comment", () => {
    const css = `/* } not a brace { */ .a { color: red } @font-face { font-family: F }`
    const { hoisted, scoped } = splitHoistedAtRules(css)
    expect(hoisted).toContain("@font-face")
    expect(scoped).toContain(".a")
  })

  it("handles an escaped quote inside a string", () => {
    const css = `.a::after { content: "\\"}" } .b { color: red }`
    const { scoped } = splitHoistedAtRules(css)
    expect(scoped).toContain(".a::after")
    expect(scoped).toContain(".b")
  })

  it("returns empty halves for empty or whitespace-only input", () => {
    expect(splitHoistedAtRules("")).toEqual({ hoisted: "", scoped: "" })
    expect(splitHoistedAtRules("   \n\t ")).toEqual({ hoisted: "", scoped: "" })
  })

  it("survives an unterminated rule without hanging or throwing", () => {
    const { scoped } = splitHoistedAtRules(".a { color: red")
    expect(scoped).toContain(".a")
  })

  it("survives an unterminated string without hanging", () => {
    expect(() => splitHoistedAtRules('.a { content: "unterminated')).not.toThrow()
  })

  it("survives an unterminated comment without hanging", () => {
    expect(() => splitHoistedAtRules(".a { color: red } /* open")).not.toThrow()
  })
})

describe("scopePluginCss", () => {
  it("binds style rules to the plugin's own root attribute", () => {
    const out = scopePluginCss(".badge { color: red }", "demo")
    expect(out).toContain(`@scope ([${PLUGIN_ROOT_ATTRIBUTE}="demo"])`)
    expect(out).toContain(".badge")
  })

  it("emits hoisted at-rules outside the scope block", () => {
    const out = scopePluginCss("@keyframes k { from { opacity: 0 } } .a { color: red }", "demo")
    expect(out.indexOf("@keyframes k")).toBeLessThan(out.indexOf("@scope ("))
  })

  it("emits no scope block when the sheet is only hoisted rules", () => {
    const out = scopePluginCss("@keyframes k { from { opacity: 0 } }", "demo")
    expect(out).toContain("@keyframes k")
    expect(out).not.toContain("@scope (")
  })

  it("returns an empty string for an empty stylesheet", () => {
    expect(scopePluginCss("", "demo")).toBe("")
  })

  it("escapes quotes in the plugin id so the selector cannot be broken out of", () => {
    const out = scopePluginCss(".a { color: red }", 'ev"il')
    expect(out).toContain('\\"')
    // The attribute selector must still be a single well-formed selector.
    expect(out).toContain(`@scope ([${PLUGIN_ROOT_ATTRIBUTE}="ev\\"il"])`)
  })
})

describe("injectPluginStyles", () => {
  it("appends a tagged style element", () => {
    injectPluginStyles("demo", ".a { color: red }")
    const el = document.head.querySelector(`style[${PLUGIN_STYLE_ATTRIBUTE}="demo"]`)
    expect(el).not.toBeNull()
    expect(el?.textContent).toContain("@scope")
  })

  it("replaces rather than stacks on repeat injection", () => {
    injectPluginStyles("demo", ".a { color: red }")
    injectPluginStyles("demo", ".b { color: blue }")
    const all = document.head.querySelectorAll(`style[${PLUGIN_STYLE_ATTRIBUTE}="demo"]`)
    expect(all).toHaveLength(1)
    expect(all[0].textContent).toContain(".b")
    expect(all[0].textContent).not.toContain(".a")
  })

  it("keeps two plugins' sheets separate", () => {
    injectPluginStyles("one", ".a { color: red }")
    injectPluginStyles("two", ".a { color: blue }")
    expect(document.head.querySelectorAll(`style[${PLUGIN_STYLE_ATTRIBUTE}]`)).toHaveLength(2)
    const one = document.head.querySelector(`style[${PLUGIN_STYLE_ATTRIBUTE}="one"]`)
    expect(one?.textContent).toContain('[data-plugin-root="one"]')
  })
})

describe("removePluginStyles", () => {
  it("removes only the named plugin's sheet", () => {
    injectPluginStyles("one", ".a { color: red }")
    injectPluginStyles("two", ".b { color: blue }")
    removePluginStyles("one")
    expect(document.head.querySelector(`style[${PLUGIN_STYLE_ATTRIBUTE}="one"]`)).toBeNull()
    expect(document.head.querySelector(`style[${PLUGIN_STYLE_ATTRIBUTE}="two"]`)).not.toBeNull()
  })

  it("is a no-op when nothing was injected", () => {
    expect(() => removePluginStyles("never")).not.toThrow()
  })
})

describe("loadPluginStyles default reader", () => {
  it("reads through the contained-path Tauri command", async () => {
    // The default path, exercised without a `readFile` override. `plugin_read_entry`
    // is the host's no-follow reader — plugin assets must never be fetched as
    // arbitrary file:// URLs from the renderer.
    const invoke = jest.fn().mockResolvedValue(".from-disk { gap: 1px }")
    jest.doMock("@tauri-apps/api/core", () => ({ invoke }), { virtual: true })

    const { loadPluginStyles: load } = await import("./plugin-stylesheet")
    const injected = await load({
      pluginId: "demo",
      pluginRoot: "/plugins/demo",
      stylesEntry: "src/panel.css",
    })

    expect(injected).toBe(true)
    expect(invoke).toHaveBeenCalledWith("plugin_read_entry", {
      pluginId: "demo",
      pluginPath: "/plugins/demo",
      entry: "src/panel.css",
    })
    jest.dontMock("@tauri-apps/api/core")
  })
})

describe("loadPluginStyles", () => {
  it("reads the declared entry and injects it", async () => {
    const readFile = jest.fn<Promise<string>, [string, string, string]>(
      async () => ".panel { gap: 4px }"
    )
    const injected = await loadPluginStyles({
      pluginId: "demo",
      pluginRoot: "/plugins/demo",
      stylesEntry: "dist/panel.css",
      readFile,
    })
    expect(injected).toBe(true)
    expect(readFile).toHaveBeenCalledWith("demo", "/plugins/demo", "dist/panel.css")
    expect(
      document.head.querySelector(`style[${PLUGIN_STYLE_ATTRIBUTE}="demo"]`)?.textContent
    ).toContain(".panel")
  })

  it("does nothing when the manifest declares no stylesheet", async () => {
    const readFile = jest.fn()
    const injected = await loadPluginStyles({
      pluginId: "demo",
      pluginRoot: "/plugins/demo",
      stylesEntry: undefined,
      readFile,
    })
    expect(injected).toBe(false)
    expect(readFile).not.toHaveBeenCalled()
  })

  it("skips built-ins, which have no fetchable install directory", async () => {
    const readFile = jest.fn()
    const injected = await loadPluginStyles({
      pluginId: "demo",
      pluginRoot: "builtin://cognia-demo",
      stylesEntry: "dist/panel.css",
      readFile,
    })
    expect(injected).toBe(false)
    expect(readFile).not.toHaveBeenCalled()
  })

  it("injects styles bundled with a built-in registry entry", async () => {
    const readFile = jest.fn()
    const injected = await loadPluginStyles({
      pluginId: "reference",
      pluginRoot: "builtin://reference",
      stylesEntry: "styles.css",
      bundledCss: ".ref-badge { color: red }",
      readFile,
    })

    expect(injected).toBe(true)
    expect(readFile).not.toHaveBeenCalled()
    expect(
      document.head.querySelector(`style[${PLUGIN_STYLE_ATTRIBUTE}="reference"]`)?.textContent
    ).toContain(".ref-badge")
  })

  it("keeps the plugin loadable when the stylesheet is unreadable", async () => {
    const readFile = jest.fn(async () => {
      throw new Error("ENOENT")
    })
    await expect(
      loadPluginStyles({
        pluginId: "demo",
        pluginRoot: "/plugins/demo",
        stylesEntry: "missing.css",
        readFile,
      })
    ).resolves.toBe(false)
    expect(document.head.querySelector(`style[${PLUGIN_STYLE_ATTRIBUTE}="demo"]`)).toBeNull()
  })
})
