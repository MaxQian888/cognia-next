import {
  appLocaleOf,
  nlsKeyOf,
  readNlsBundles,
  resolveNls,
  settingTitle,
  vscodeConfigurationToSchema,
  type NlsBundles,
} from "./vscode-configuration-schema"

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))

describe("package.nls bundles", () => {
  it("reads the default bundle and each locale, in the app's locale spelling", () => {
    const warnings: string[] = []
    const bundles = readNlsBundles(
      new Map([
        ["package.nls.json", encode({ name: "Name", comment: { message: "M", comment: ["c"] } })],
        ["package.nls.zh-cn.json", encode({ name: "名称" })],
        ["package.nls.pt-br.json", new TextEncoder().encode("{ broken")],
        ["nested/package.nls.json", encode({ ignored: "x" })],
        ["package.json", encode({})],
      ]),
      warnings
    )
    expect(bundles.defaults).toEqual({ name: "Name", comment: "M" })
    expect(bundles.locales).toEqual({
      en: { name: "Name", comment: "M" },
      "zh-CN": { name: "名称" },
    })
    expect(warnings).toEqual(["Skipped package.nls.pt-br.json: it is not valid JSON."])
    expect(appLocaleOf("pt-br")).toBe("pt-BR")
  })

  it("resolves %key% text, and leaves the rest as written", () => {
    const bundles: NlsBundles = { defaults: { a: "Alpha" }, locales: {} }
    expect(nlsKeyOf(" %a% ")).toBe("a")
    expect(nlsKeyOf("100%")).toBeUndefined()
    expect(resolveNls("%a%", bundles)).toBe("Alpha")
    expect(resolveNls("%missing%", bundles)).toBe("%missing%")
    expect(resolveNls("plain", bundles)).toBe("plain")
    expect(resolveNls(undefined, bundles)).toBeUndefined()
  })
})

describe("contributes.configuration → configSchema", () => {
  const bundles: NlsBundles = {
    defaults: { desc: "Where the server lives", choice: "Pick one" },
    locales: {},
  }

  it("maps VS Code properties onto schema properties under their full keys", () => {
    const warnings: string[] = []
    const schema = vscodeConfigurationToSchema(
      {
        configuration: [
          {
            title: "Ext",
            properties: {
              "ext.server.path": {
                type: ["string", "null"],
                default: null,
                description: "%desc%",
                pattern: "^/",
                patternErrorMessage: "Absolute",
                scope: "machine-overridable",
                order: 2,
                format: "uri",
              },
              "ext.mode": {
                type: "string",
                enum: ["a", "b"],
                enumDescriptions: ["%choice%", "B"],
                enumItemLabels: ["A", "B"],
                default: "a",
                markdownDeprecationMessage: "Use `ext.other`",
              },
              "ext.notes": { type: "string", editPresentation: "multilineText" },
              "ext.count": { type: "integer", minimum: 0, maximum: 9, default: 1 },
              "ext.inferred": { default: [1, 2] },
              "ext.unknown": {},
              "ext.paths": { type: "array", items: { type: "string", minLength: 1 } },
              "ext.env": {
                type: "object",
                properties: { HOME: { type: "string" } },
                default: {},
              },
            },
          },
          { properties: { "ext.mode": { type: "number" }, "ext.flag": { type: "boolean" } } },
        ],
        configurationDefaults: { "[markdown]": { "editor.wordWrap": "on" } },
      },
      bundles,
      warnings
    )
    expect(schema?.properties["ext.server.path"]).toEqual({
      type: "string",
      title: "Server: Path",
      default: null,
      description: "Where the server lives",
      pattern: "^/",
      patternMessage: "Absolute",
      scope: "machine",
      order: 2,
      format: "uri",
    })
    expect(schema?.properties["ext.mode"]).toEqual({
      type: "string",
      title: "Mode",
      enum: ["a", "b"],
      enumDescriptions: ["Pick one", "B"],
      enumItemLabels: ["A", "B"],
      default: "a",
      deprecationMessage: "Use `ext.other`",
    })
    expect(schema?.properties["ext.notes"].format).toBe("textarea")
    expect(schema?.properties["ext.count"]).toMatchObject({
      type: "integer",
      minimum: 0,
      maximum: 9,
    })
    expect(schema?.properties["ext.inferred"].type).toBe("array")
    expect(schema?.properties["ext.paths"].items).toEqual({ type: "string", minLength: 1 })
    expect(schema?.properties["ext.env"].properties).toEqual({ HOME: { type: "string" } })
    expect(schema?.properties["ext.flag"].type).toBe("boolean")
    expect(schema?.properties["ext.unknown"]).toBeUndefined()
    expect(warnings).toEqual([
      'Setting "ext.unknown" has no type and no default, so it is not shown in settings.',
      "configurationDefaults are not applied: settings have no language-specific values here.",
    ])
  })

  it("is absent when an extension contributes no settings", () => {
    expect(vscodeConfigurationToSchema({}, bundles, [])).toBeUndefined()
    expect(
      vscodeConfigurationToSchema({ configuration: { properties: {} } }, bundles, [])
    ).toBeUndefined()
  })

  it("titles settings the way VS Code does", () => {
    expect(settingTitle("ext.enableFooBar")).toBe("Enable Foo Bar")
    expect(settingTitle("ext.server.trace.level")).toBe("Server › Trace: Level")
    expect(settingTitle("standalone")).toBe("Standalone")
  })
})
