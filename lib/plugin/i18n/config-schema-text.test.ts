import {
  collectConfigSchemaI18nKeys,
  localizeConfigSchema,
  resolvePluginI18nText,
} from "./config-schema-text"

const i18n = {
  locales: {
    en: {
      "config.project.title": "Default project id",
      "config.project.description": "Project the skills use.",
      "config.protection.title": "Protection mode",
      "config.protection.strict": "Strict",
      "config.protection.authoring": "Authoring",
      "config.protection.strict.description": "Every protected change needs approval.",
      "config.nested.title": "Nested",
    },
    "zh-CN": {
      "config.project.title": "默认项目 ID",
      "config.protection.strict": "严格",
      "config.protection.authoring": "",
    },
  },
}

const schema = {
  type: "object",
  properties: {
    project: {
      type: "string",
      title: "Default project id (raw)",
      titleKey: "config.project.title",
      description: "raw description",
      descriptionKey: "config.project.description",
    },
    protection: {
      type: "string",
      title: "raw protection",
      titleKey: "config.protection.title",
      enum: ["strict", "authoring"],
      enumItemLabels: ["strict raw", "authoring raw"],
      enumItemLabelKeys: ["config.protection.strict", "config.protection.authoring"],
      enumDescriptionKeys: ["config.protection.strict.description", "missing.key"],
      enumDescriptions: ["raw strict desc", "raw authoring desc"],
    },
    group: {
      type: "object",
      properties: { inner: { type: "string", titleKey: "config.nested.title" } },
    },
    plain: { type: "string", title: "Untouched" },
  },
}

describe("localizeConfigSchema", () => {
  it("resolves keys in the user's locale, then English, then the literal", () => {
    const zh = localizeConfigSchema(schema, i18n, "zh-CN") as typeof schema
    expect(zh.properties.project.title).toBe("默认项目 ID")
    // Missing in zh-CN → English.
    expect(zh.properties.project.description).toBe("Project the skills use.")
    expect(zh.properties.protection.title).toBe("Protection mode")
    // An empty zh-CN string falls through to English.
    expect(zh.properties.protection.enumItemLabels).toEqual(["严格", "Authoring"])
    // A key missing everywhere keeps the literal at that index.
    expect(zh.properties.protection.enumDescriptions).toEqual([
      "Every protected change needs approval.",
      "raw authoring desc",
    ])
    expect((zh.properties.group.properties.inner as { title?: string }).title).toBe("Nested")
    expect(zh.properties.plain.title).toBe("Untouched")
  })

  it("leaves literals alone without a bundle, and never mutates its input", () => {
    const before = JSON.stringify(schema)
    const plain = localizeConfigSchema(schema, undefined, "en") as typeof schema
    expect(plain.properties.project.title).toBe("Default project id (raw)")
    expect(JSON.stringify(schema)).toBe(before)
    expect(localizeConfigSchema("not a schema", i18n, "en")).toBe("not a schema")
  })
})

describe("collectConfigSchemaI18nKeys", () => {
  it("lists every referenced key with its field path", () => {
    expect(collectConfigSchemaI18nKeys(schema)).toEqual([
      { field: "configSchema.properties.project.titleKey", key: "config.project.title" },
      {
        field: "configSchema.properties.project.descriptionKey",
        key: "config.project.description",
      },
      { field: "configSchema.properties.protection.titleKey", key: "config.protection.title" },
      {
        field: "configSchema.properties.protection.enumItemLabelKeys[0]",
        key: "config.protection.strict",
      },
      {
        field: "configSchema.properties.protection.enumItemLabelKeys[1]",
        key: "config.protection.authoring",
      },
      {
        field: "configSchema.properties.protection.enumDescriptionKeys[0]",
        key: "config.protection.strict.description",
      },
      {
        field: "configSchema.properties.protection.enumDescriptionKeys[1]",
        key: "missing.key",
      },
      {
        field: "configSchema.properties.group.properties.inner.titleKey",
        key: "config.nested.title",
      },
    ])
  })
})

describe("resolvePluginI18nText", () => {
  it("resolves UI text from the manifest locale, English, then the literal", () => {
    expect(resolvePluginI18nText("raw", "config.project.title", i18n, "zh-CN")).toBe("默认项目 ID")
    expect(resolvePluginI18nText("raw", "config.project.description", i18n, "zh-CN")).toBe(
      "Project the skills use."
    )
    expect(resolvePluginI18nText("raw", "config.protection.authoring", i18n, "zh-CN")).toBe(
      "Authoring"
    )
    expect(resolvePluginI18nText("raw", "config.project.title", i18n, "fr")).toBe(
      "Default project id"
    )
    expect(resolvePluginI18nText("raw", "missing", i18n, "zh-CN")).toBe("raw")
    expect(resolvePluginI18nText("raw", "config.project.title", undefined, "zh-CN")).toBe("raw")
    expect(resolvePluginI18nText("raw", undefined, i18n, "zh-CN")).toBe("raw")
  })
})
