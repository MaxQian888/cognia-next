jest.mock("@/lib/app-version", () => ({ APP_VERSION: "2.4.0" }))

import { buildSupportReport, deriveSupportReportTitle, MAX_SECTION_CHARS } from "./build"
import type { SupportReportContext, SupportReportSectionSpec } from "./types"

function spec(
  id: string,
  body: string | null,
  overrides: Partial<SupportReportSectionSpec> = {}
): SupportReportSectionSpec {
  return {
    id,
    labelKey: `${id}.label`,
    descriptionKey: `${id}.description`,
    heading: id.toUpperCase(),
    pinned: false,
    defaultIncluded: true,
    sensitive: true,
    isAvailable: () => true,
    collect: () => body,
    ...overrides,
  }
}

const ctx: SupportReportContext = {
  surface: "error-page",
  category: "render",
  route: "/x",
  locale: "en",
  error: { name: "Error", message: "boom", stack: "at foo", digest: "d1" },
}

describe("deriveSupportReportTitle", () => {
  it("prefers the error message tagged with the category", () => {
    expect(deriveSupportReportTitle(ctx)).toBe("[render] boom")
  })

  it("falls back to the diagnostic code tagged with its source", () => {
    expect(
      deriveSupportReportTitle({
        surface: "notification",
        diagnostic: { code: "sidecarCrashed", source: "tauri" },
      })
    ).toBe("[tauri] sidecarCrashed")
  })

  it("falls back to the first description line, then a generic title", () => {
    expect(
      deriveSupportReportTitle({ surface: "chat", description: "  Chat stopped\nmore detail" })
    ).toBe("Chat stopped")
    expect(deriveSupportReportTitle({ surface: "chat" })).toBe("Cognia support report")
  })

  it("caps a very long title", () => {
    expect(
      deriveSupportReportTitle({ surface: "chat", description: "x".repeat(500) }).length
    ).toBeLessThanOrEqual(100)
  })
})

describe("buildSupportReport", () => {
  it("writes the header, includes pinned + chosen sections, and skips empty ones", async () => {
    const report = await buildSupportReport({
      context: ctx,
      sectionIds: ["error", "runtime"],
      sections: [
        spec("description", null, { pinned: true }),
        spec("app", "Cognia 2.4.0", { pinned: true }),
        spec("error", "```\nError: boom\nat foo\n```"),
        spec("runtime", "{}"),
        spec("recentErrors", "- earlier"),
      ],
      generatedAt: "2026-08-16T10:00:00.000Z",
    })
    expect(report.filename).toBe("cognia-support-report-2026-08-16.md")
    expect(report.title).toBe("[render] boom")
    expect(report.sectionIds).toEqual(["app", "error", "runtime"])
    expect(report.markdown).toContain("## Cognia support report")
    expect(report.markdown).toContain("- App version: 2.4.0")
    expect(report.markdown).toContain("- Generated: 2026-08-16T10:00:00.000Z")
    expect(report.markdown).toContain("- Surface: error-page")
    expect(report.markdown).toContain("- Category: render")
    expect(report.markdown).toContain("- Route: /x")
    expect(report.markdown).toContain("- Locale: en")
    expect(report.markdown).toContain("- Error ID: d1")
    expect(report.markdown).toContain("### APP\n\nCognia 2.4.0")
    expect(report.markdown).toContain("### ERROR")
    expect(report.markdown).not.toContain("### RECENTERRORS")
    expect(report.markdown.endsWith("\n")).toBe(true)
  })

  it("includes every available section when no ids are given, and omits absent header lines", async () => {
    const report = await buildSupportReport({
      context: { surface: "chat" },
      sections: [spec("a", "one"), spec("b", "two", { isAvailable: () => false })],
      generatedAt: "2026-08-16T10:00:00.000Z",
    })
    expect(report.sectionIds).toEqual(["a"])
    expect(report.markdown).not.toContain("- Category")
    expect(report.markdown).not.toContain("- Route")
    expect(report.markdown).not.toContain("- Error ID")
  })

  it("redacts PII inside section bodies and the title", async () => {
    const report = await buildSupportReport({
      context: { surface: "chat", description: "mail me at jane.doe@example.com" },
      sections: [spec("description", "mail me at jane.doe@example.com", { pinned: true })],
      generatedAt: "2026-08-16T10:00:00.000Z",
    })
    expect(report.markdown).not.toContain("jane.doe@example.com")
    expect(report.title).not.toContain("jane.doe@example.com")
  })

  it("caps each section body", async () => {
    const report = await buildSupportReport({
      context: { surface: "chat" },
      sections: [spec("big", "z".repeat(MAX_SECTION_CHARS * 3))],
      generatedAt: "2026-08-16T10:00:00.000Z",
    })
    expect(report.markdown.length).toBeLessThan(MAX_SECTION_CHARS + 500)
  })

  it("defaults generatedAt to now and uses the live section registry", async () => {
    const report = await buildSupportReport({
      context: { surface: "chat", description: "hello" },
      sectionIds: [],
    })
    expect(report.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    // Pinned built-ins (description, app) still land with an empty selection.
    expect(report.sectionIds).toEqual(expect.arrayContaining(["description", "app"]))
    expect(report.sectionIds).not.toContain("runtime")
  })
})
