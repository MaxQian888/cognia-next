import {
  A2UI_APP_EXPORT_VERSION,
  A2UI_MAX_IMPORT_BYTES,
  parseA2UIAppImport,
  parseA2UIBackupImport,
} from "./app-import"

function appPayload(app: Record<string, unknown>, version = A2UI_APP_EXPORT_VERSION): string {
  return JSON.stringify({ version, app })
}

const validComponents = [
  { id: "custom-root", component: "Column", children: ["label"] },
  { id: "label", component: "Text", text: { path: "/message" } },
]

describe("A2UI app import validation", () => {
  it("normalizes a complete export while preserving its explicit root and surface metadata", () => {
    const result = parseA2UIAppImport(
      appPayload({
        name: "Imported app",
        templateId: "custom",
        locale: "zh-CN",
        components: validComponents,
        dataModel: { message: "你好" },
        surfaceType: "panel",
        catalogId: "catalog-v1",
        title: "Panel title",
        rootId: "custom-root",
        widget: {
          hostStrategy: "artifact-preview",
          sizing: "fixed-height",
          theme: "dark",
          status: "ready",
          showChrome: true,
          fallbackText: "Fallback",
          minHeight: 320,
        },
      }),
      "en"
    )

    expect(result).toEqual({
      success: true,
      value: expect.objectContaining({
        name: "Imported app",
        templateId: "custom",
        locale: "zh-CN",
        surfaceType: "panel",
        catalogId: "catalog-v1",
        title: "Panel title",
        rootId: "custom-root",
        dataModel: { message: "你好" },
      }),
    })
  })

  it("infers the unique graph root for legacy exports without rootId", () => {
    const result = parseA2UIAppImport(
      appPayload({
        name: "Legacy app",
        components: validComponents,
        dataModel: { message: "hello" },
      }),
      "en"
    )

    expect(result.success).toBe(true)
    if (result.success) expect(result.value.rootId).toBe("custom-root")
  })

  it("uses the active locale only when the export has no supported locale", () => {
    const missing = parseA2UIAppImport(
      appPayload({ name: "Missing locale", components: validComponents }),
      "zh-CN"
    )
    const invalid = parseA2UIAppImport(
      appPayload({ name: "Invalid locale", locale: "fr", components: validComponents }),
      "en"
    )

    expect(missing.success && missing.value.locale).toBe("zh-CN")
    expect(invalid.success && invalid.value.locale).toBe("en")
  })

  it.each([
    ["unsupported version", appPayload({ name: "App", components: validComponents }, "2.0")],
    ["missing app", JSON.stringify({ version: A2UI_APP_EXPORT_VERSION })],
    ["empty components", appPayload({ name: "App", components: [] })],
    [
      "duplicate ids",
      appPayload({
        name: "App",
        components: [
          { id: "root", component: "Column" },
          { id: "root", component: "Text", text: "duplicate" },
        ],
      }),
    ],
    [
      "missing structural reference",
      appPayload({
        name: "App",
        components: [{ id: "root", component: "Column", children: ["missing"] }],
      }),
    ],
    [
      "reference cycle",
      appPayload({
        name: "App",
        components: [
          { id: "root", component: "Column", children: ["child"] },
          { id: "child", component: "Column", children: ["root"] },
        ],
      }),
    ],
    [
      "orphan component",
      appPayload({
        name: "App",
        components: [
          { id: "root", component: "Column" },
          { id: "orphan", component: "Text", text: "orphan" },
        ],
        rootId: "root",
      }),
    ],
    [
      "shared child",
      appPayload({
        name: "App",
        components: [
          { id: "root", component: "Column", children: ["left", "right"] },
          { id: "left", component: "Column", children: ["shared"] },
          { id: "right", component: "Column", children: ["shared"] },
          { id: "shared", component: "Text", text: "shared" },
        ],
      }),
    ],
    [
      "invalid data pointer",
      appPayload({
        name: "App",
        components: [{ id: "root", component: "Text", text: { path: "message" } }],
      }),
    ],
    [
      "non-string path binding",
      appPayload({
        name: "App",
        components: [{ id: "root", component: "Text", text: { path: 42 } }],
      }),
    ],
    [
      "malformed structural collection",
      appPayload({
        name: "App",
        components: [{ id: "root", component: "Column", children: [42] }],
      }),
    ],
    [
      "unsafe data model key",
      '{"version":"1.0","app":{"name":"App","components":[{"id":"root","component":"Column"}],"dataModel":{"__proto__":{"polluted":true}}}}',
    ],
    [
      "invalid surface type",
      appPayload({ name: "App", components: validComponents, surfaceType: "popover" }),
    ],
  ])("rejects %s", (_label, payload) => {
    expect(parseA2UIAppImport(payload, "en").success).toBe(false)
  })

  it("rejects an input before parsing when it exceeds the resource limit", () => {
    const result = parseA2UIAppImport(" ".repeat(A2UI_MAX_IMPORT_BYTES + 1), "en")
    expect(result).toEqual({
      success: false,
      error: expect.objectContaining({ code: "input_too_large" }),
    })
  })
})

describe("A2UI backup import validation", () => {
  it("preserves validated instance metadata needed for a full backup restore", () => {
    const result = parseA2UIBackupImport(
      JSON.stringify({
        version: A2UI_APP_EXPORT_VERSION,
        apps: [
          {
            name: "Backup app",
            templateId: "custom",
            locale: "en",
            components: validComponents,
            rootId: "custom-root",
            dataModel: { message: "hello" },
            createdAt: 100,
            lastModified: 200,
            description: "Description",
            version: "3.2.1",
            author: { name: "Author", email: "author@example.com", url: "https://example.com" },
            category: "utility",
            tags: ["one", "two"],
            thumbnail: "data:image/png;base64,AA==",
            thumbnailUpdatedAt: 150,
            stats: { views: 2, uses: 3, rating: 4.5, ratingCount: 2 },
            publishedAt: 175,
            isPublished: true,
            storeId: "store-1",
            screenshots: ["data:image/png;base64,AA=="],
          },
        ],
      }),
      "zh-CN"
    )

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.value.apps[0].metadata).toEqual({
        createdAt: 100,
        lastModified: 200,
        description: "Description",
        version: "3.2.1",
        author: { name: "Author", email: "author@example.com", url: "https://example.com" },
        category: "utility",
        tags: ["one", "two"],
        thumbnail: "data:image/png;base64,AA==",
        thumbnailUpdatedAt: 150,
        stats: { views: 2, uses: 3, rating: 4.5, ratingCount: 2 },
        publishedAt: 175,
        isPublished: true,
        storeId: "store-1",
        screenshots: ["data:image/png;base64,AA=="],
      })
    }
  })

  it("rejects the whole backup when any app is invalid", () => {
    const result = parseA2UIBackupImport(
      JSON.stringify({
        version: A2UI_APP_EXPORT_VERSION,
        apps: [
          { name: "Valid", components: [{ id: "root", component: "Column" }] },
          { name: "Invalid", components: [{ id: "root", component: "Column", children: ["x"] }] },
        ],
      }),
      "en"
    )

    expect(result).toEqual({
      success: false,
      error: expect.objectContaining({ code: "invalid_app", appIndex: 1 }),
    })
  })
})
