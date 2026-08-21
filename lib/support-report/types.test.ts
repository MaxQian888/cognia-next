// Type-only module — no runtime code lives here. The side-effect import keeps
// the (empty) module body in coverage; the literals below pin the two registry
// contracts (sections, channels) every report surface plugs into.
import "./types"
import type {
  SupportReport,
  SupportReportChannelSpec,
  SupportReportContext,
  SupportReportSectionSpec,
  SupportReportSurface,
} from "./types"

describe("SupportReportSurface", () => {
  it("enumerates the five surfaces that can raise a report", () => {
    const surfaces: SupportReportSurface[] = [
      "chat",
      "mobile",
      "error-page",
      "notification",
      "tray",
    ]
    expect(new Set(surfaces).size).toBe(5)
  })
})

describe("SupportReportContext", () => {
  it("requires only the surface — the error boundary knows little else", () => {
    const ctx: SupportReportContext = { surface: "error-page" }
    expect(ctx.description).toBeUndefined()
    expect(ctx.error).toBeUndefined()
  })

  it("distinguishes 'no error' (null) from 'not asked' (undefined)", () => {
    const noError: SupportReportContext = { surface: "chat", error: null, diagnostic: null }
    expect(noError.error).toBeNull()
    expect(noError.route).toBeUndefined()
  })

  it("carries a serialisable error — never the Error instance itself", () => {
    const ctx: SupportReportContext = {
      surface: "error-page",
      error: { name: "TypeError", message: "x is not a function", digest: "abc123" },
      category: "runtime",
    }
    expect(ctx.error?.stack).toBeUndefined()
    expect(ctx.error?.digest).toBe("abc123")
  })
})

describe("SupportReportSectionSpec", () => {
  function section(overrides: Partial<SupportReportSectionSpec> = {}): SupportReportSectionSpec {
    return {
      id: "app-version",
      labelKey: "appVersion",
      descriptionKey: "appVersionHint",
      heading: "App version",
      pinned: true,
      defaultIncluded: true,
      sensitive: false,
      isAvailable: () => true,
      collect: () => "1.2.3",
      ...overrides,
    }
  }

  it("keeps isAvailable synchronous so the checklist renders immediately", () => {
    const spec = section()
    expect(spec.isAvailable({ surface: "chat" })).toBe(true)
  })

  it("lets collect return null to mean 'nothing to report'", async () => {
    // `collect` is sync-or-async by design, so the caller always awaits it.
    const spec = section({ pinned: false, collect: () => null })
    await expect(Promise.resolve(spec.collect({ surface: "chat" }))).resolves.toBeNull()
  })

  it("accepts an async collect for sections that read live runtime state", async () => {
    const spec = section({
      id: "diagnostics",
      sensitive: true,
      pinned: false,
      collect: async () => "- ok",
    })
    await expect(spec.collect({ surface: "tray" })).resolves.toBe("- ok")
    expect(spec.sensitive).toBe(true)
  })

  it("headings stay English — the audience is maintainers, not the user", () => {
    // The i18n keys drive the checkbox; the heading lands in the issue body.
    const spec = section()
    expect(spec.heading).toMatch(/^[\x20-\x7e]+$/)
    expect(spec.labelKey).not.toContain("support.report.section.")
  })
})

describe("SupportReport", () => {
  it("records only the sections that actually contributed a body", () => {
    const report: SupportReport = {
      title: "Crash on launch",
      markdown: "### App version\n1.2.3",
      filename: "cognia-report-2026-08-20.md",
      generatedAt: "2026-08-20T00:00:00.000Z",
      sectionIds: ["app-version"],
    }
    expect(report.sectionIds).toEqual(["app-version"])
  })
})

describe("SupportReportChannelSpec", () => {
  it("gates delivery on the current shell via a synchronous isAvailable", async () => {
    const delivered: SupportReport[] = []
    const channel: SupportReportChannelSpec = {
      id: "github",
      labelKey: "github",
      primary: true,
      isAvailable: () => true,
      deliver: async (report) => {
        delivered.push(report)
      },
    }
    expect(channel.isAvailable()).toBe(true)
    await channel.deliver({
      title: "t",
      markdown: "m",
      filename: "f.md",
      generatedAt: "2026-08-20T00:00:00.000Z",
      sectionIds: [],
    })
    expect(delivered).toHaveLength(1)
  })

  it("leaves `primary` optional — a channel that omits it is a secondary action", () => {
    const channel: SupportReportChannelSpec = {
      id: "clipboard",
      labelKey: "clipboard",
      isAvailable: () => true,
      deliver: async () => undefined,
    }
    expect(channel.primary).toBeUndefined()
  })
})
