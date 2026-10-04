import { bindCliToolPluginRoot, findPluginRootToken } from "./plugin-root-binding"
import { CliTemplateError } from "./template"
import { PLUGIN_ROOT_TOKENS } from "@/lib/plugin/utils/plugin-root-tokens"
import type { PluginCliToolDef } from "@/types/plugin"

const TOOL: Pick<PluginCliToolDef, "name" | "argv" | "env"> = {
  name: "latexwb_build",
  argv: [
    { literal: "${COGNIA_PLUGIN_ROOT}/vendor/packages/cli/src/bin.ts" },
    { literal: "build" },
    { param: "project", eachPrefixedBy: "--project" },
  ],
  env: { LATEXWB_REPO_ROOT: "${COGNIA_PLUGIN_ROOT}/vendor", LATEXWB_PRINCIPAL: "cognia-agent" },
}

describe("findPluginRootToken", () => {
  it.each(PLUGIN_ROOT_TOKENS)("recognises %s", (token) => {
    expect(findPluginRootToken(`${token}/bin`)).toBe(token)
  })

  it("returns undefined for strings without a token", () => {
    expect(findPluginRootToken("--json")).toBeUndefined()
    expect(findPluginRootToken("$COGNIA_PLUGIN_ROOT/x")).toBeUndefined()
  })
})

describe("bindCliToolPluginRoot", () => {
  it("expands literal argv tokens and static env values to the install dir", () => {
    const bound = bindCliToolPluginRoot(TOOL, "/Users/me/.cognia/plugins/latex/")
    expect(bound.argv).toEqual([
      { literal: "/Users/me/.cognia/plugins/latex/vendor/packages/cli/src/bin.ts" },
      { literal: "build" },
      { param: "project", eachPrefixedBy: "--project" },
    ])
    expect(bound.env).toEqual({
      LATEXWB_REPO_ROOT: "/Users/me/.cognia/plugins/latex/vendor",
      LATEXWB_PRINCIPAL: "cognia-agent",
    })
  })

  it("binds every spelling of the token family, Windows roots included", () => {
    const bound = bindCliToolPluginRoot(
      { name: "t", argv: PLUGIN_ROOT_TOKENS.map((token) => ({ literal: `${token}/x` })) },
      "C:\\plugins\\latex\\"
    )
    expect(bound.argv).toEqual(PLUGIN_ROOT_TOKENS.map(() => ({ literal: "C:\\plugins\\latex/x" })))
  })

  it("never touches param tokens or their flag prefixes", () => {
    const def = {
      name: "t",
      argv: [
        { param: "path", eachPrefixedBy: "${COGNIA_PLUGIN_ROOT}" },
        { literal: "${extensionPath}" },
      ],
    }
    const bound = bindCliToolPluginRoot(def, "/p")
    expect(bound.argv[0]).toBe(def.argv[0])
    expect(bound.argv[1]).toEqual({ literal: "/p" })
  })

  it("returns the manifest values untouched when nothing references the root", () => {
    const def = { name: "rg", argv: [{ literal: "--json" }], env: { A: "1" } }
    const bound = bindCliToolPluginRoot(def, "builtin://ripgrep-tools")
    expect(bound.argv).toBe(def.argv)
    expect(bound.env).toBe(def.env)
    expect(bindCliToolPluginRoot({ name: "rg", argv: [] }, "").env).toEqual({})
  })

  it("does not mutate the manifest definition", () => {
    const snapshot = JSON.parse(JSON.stringify(TOOL))
    bindCliToolPluginRoot(TOOL, "/p")
    expect(TOOL).toEqual(snapshot)
  })

  it.each([
    ["a builtin:// plugin", "builtin://cognia-pi-latex-workbench"],
    ["an empty install path", ""],
  ])("refuses %s when a literal references the root", (_label, root) => {
    expect(() => bindCliToolPluginRoot(TOOL, root)).toThrow(CliTemplateError)
    expect(() => bindCliToolPluginRoot(TOOL, root)).toThrow(/no on-disk install directory/)
  })

  it("refuses a builtin:// plugin whose env alone references the root", () => {
    expect(() =>
      bindCliToolPluginRoot(
        { name: "t", argv: [{ literal: "x" }], env: { HOME_DIR: "${CLAUDE_PLUGIN_ROOT}" } },
        "builtin://x"
      )
    ).toThrow(/\$\{CLAUDE_PLUGIN_ROOT\}/)
  })
})
