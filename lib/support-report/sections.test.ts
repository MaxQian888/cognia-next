const platform = { tauri: false, capacitor: false }
jest.mock("@/lib/platform/detect", () => ({
  isTauri: () => platform.tauri,
  isCapacitor: () => platform.capacitor,
}))
const getDiagnostics = jest.fn(async (): Promise<unknown> => ({
  status: "ok",
  appVersion: "9.9.9",
}))
jest.mock("@/lib/native/local-runtime", () => ({
  getLocalRuntimeDiagnostics: () => getDiagnostics(),
}))
const listCrashReports = jest.fn(async (): Promise<unknown[]> => [])
jest.mock("@/lib/native/crash-reports", () => ({
  listCrashReports: () => listCrashReports(),
}))
jest.mock("@/lib/sync/companion-sync", () => ({
  snapshotSyncStates: () => ({ sessions: { status: "idle" } }),
}))
jest.mock("./app-facts", () => ({
  gatherDiagnostics: async () => ({
    name: "Cognia",
    version: "1.0.0",
    channel: "stable",
    commit: "abc",
    buildTime: "t",
    tauri: null,
    react: "19",
    engine: null,
    platform: "",
  }),
  formatDiagnostics: (f: { name: string; version: string }) => `${f.name} ${f.version}`,
}))

import { recordRecentErrorLog, resetRecentErrorLogsForTest } from "@cognia/logging/recent-errors"
import type { StructuredLogEntry } from "@/types/logging"

import {
  BUILTIN_SUPPORT_REPORT_SECTIONS,
  __resetSupportReportSectionsForTesting,
  defaultSupportReportSectionIds,
  listAvailableSupportReportSections,
  listSupportReportSections,
  registerSupportReportSection,
} from "./sections"
import type { SupportReportContext, SupportReportSectionSpec } from "./types"

const baseCtx: SupportReportContext = { surface: "chat" }

function section(id: string): SupportReportSectionSpec {
  const found = BUILTIN_SUPPORT_REPORT_SECTIONS.find((s) => s.id === id)
  if (!found) throw new Error(`missing built-in ${id}`)
  return found
}

beforeEach(() => {
  platform.tauri = false
  platform.capacitor = false
  resetRecentErrorLogsForTest()
  __resetSupportReportSectionsForTesting()
  getDiagnostics.mockClear()
  listCrashReports.mockReset().mockResolvedValue([])
})

describe("availability", () => {
  it("offers only sections that can say something for the context", () => {
    const ids = listAvailableSupportReportSections(baseCtx).map((s) => s.id)
    expect(ids).toEqual(["description", "app", "runtime"])
  })

  it("adds error / diagnostic / conversation when the context carries them", () => {
    const ids = listAvailableSupportReportSections({
      ...baseCtx,
      error: { name: "Error", message: "boom" },
      diagnostic: { code: "sidecarCrashed" },
      conversationSummary: "User: it broke",
    }).map((s) => s.id)
    expect(ids).toEqual(["description", "error", "diagnostic", "conversation", "app", "runtime"])
  })

  it("offers recent errors once the ring buffer has entries", () => {
    recordRecentErrorLog({
      id: "e1",
      timestamp: "2026-08-16T00:00:00.000Z",
      level: "error",
      message: "earlier",
      module: "app",
    } as StructuredLogEntry)
    expect(listAvailableSupportReportSections(baseCtx).map((s) => s.id)).toContain("recentErrors")
  })

  it("gates crash reports on the desktop shell and sync on the mobile shell", () => {
    platform.tauri = true
    expect(listAvailableSupportReportSections(baseCtx).map((s) => s.id)).toContain("crashReports")
    expect(listAvailableSupportReportSections(baseCtx).map((s) => s.id)).not.toContain("sync")
    platform.tauri = false
    platform.capacitor = true
    expect(listAvailableSupportReportSections(baseCtx).map((s) => s.id)).toContain("sync")
    expect(listAvailableSupportReportSections(baseCtx).map((s) => s.id)).not.toContain(
      "crashReports"
    )
  })

  it("defaults include every pinned and default-on section", () => {
    expect(defaultSupportReportSectionIds(baseCtx)).toEqual(["description", "app", "runtime"])
  })
})

describe("collectors", () => {
  it("description trims and returns null when empty", async () => {
    expect(await section("description").collect({ ...baseCtx, description: "  " })).toBeNull()
    expect(await section("description").collect({ ...baseCtx, description: " hi " })).toBe("hi")
  })

  it("app renders the shared build facts in a code fence", async () => {
    expect(await section("app").collect(baseCtx)).toBe("```\nCognia 1.0.0\n```")
  })

  it("error includes the stack when present", async () => {
    const withStack = await section("error").collect({
      ...baseCtx,
      error: { name: "TypeError", message: "x is null", stack: "at foo" },
    })
    expect(withStack).toContain("TypeError: x is null")
    expect(withStack).toContain("at foo")
    expect(await section("error").collect(baseCtx)).toBeNull()
  })

  it("diagnostic lists code / source / message and dumps meta as JSON", async () => {
    const body = await section("diagnostic").collect({
      ...baseCtx,
      diagnostic: {
        code: "rateLimited",
        source: "provider",
        message: "429",
        meta: { httpStatus: 429 },
      },
    })
    expect(body).toContain("- Code: rateLimited")
    expect(body).toContain("- Source: provider")
    expect(body).toContain("- Message: 429")
    expect(body).toContain('"httpStatus": 429')
    expect(
      await section("diagnostic").collect({ ...baseCtx, diagnostic: { code: "x", meta: {} } })
    ).not.toContain("```")
    expect(await section("diagnostic").collect(baseCtx)).toBeNull()
  })

  it("runtime serialises the snapshot and yields null when unavailable", async () => {
    expect(await section("runtime").collect(baseCtx)).toContain('"appVersion": "9.9.9"')
    getDiagnostics.mockRejectedValueOnce(new Error("no ipc"))
    expect(await section("runtime").collect(baseCtx)).toBeNull()
  })

  it("recentErrors lists entries and yields null when empty", async () => {
    expect(await section("recentErrors").collect(baseCtx)).toBeNull()
    recordRecentErrorLog({
      id: "e1",
      timestamp: "2026-08-16T00:00:00.000Z",
      level: "error",
      message: "earlier",
      module: "app",
    } as StructuredLogEntry)
    expect(await section("recentErrors").collect(baseCtx)).toBe(
      "- 2026-08-16T00:00:00.000Z [error] app: earlier"
    )
  })

  it("crashReports summarises the newest reports and counts the rest", async () => {
    expect(await section("crashReports").collect(baseCtx)).toBeNull()
    listCrashReports.mockResolvedValue(
      Array.from({ length: 7 }, (_, i) => ({
        stem: `crash-${i}`,
        capturedAt: i === 0 ? undefined : `2026-08-1${i}T00:00:00Z`,
        kind: i === 0 ? undefined : "panic",
        sizeBytes: 10 + i,
        hasTxt: true,
        hasJson: false,
        hasDmp: false,
      }))
    )
    const body = await section("crashReports").collect(baseCtx)
    expect(body).toContain("- unknown time · crash · crash-0 (10 bytes)")
    expect(body).toContain("crash-4")
    expect(body).not.toContain("crash-5")
    expect(body).toContain("- … 2 more")
    listCrashReports.mockRejectedValueOnce(new Error("ipc down"))
    expect(await section("crashReports").collect(baseCtx)).toBeNull()
  })

  it("sync dumps the companion sync snapshot", async () => {
    expect(await section("sync").collect(baseCtx)).toContain('"sessions"')
  })

  it("conversation passes the summary through and yields null when blank", async () => {
    expect(
      await section("conversation").collect({ ...baseCtx, conversationSummary: " " })
    ).toBeNull()
    expect(
      await section("conversation").collect({ ...baseCtx, conversationSummary: "User: hi" })
    ).toBe("User: hi")
  })
})

describe("registry", () => {
  const custom: SupportReportSectionSpec = {
    id: "workflowTrace",
    labelKey: "workflowTrace.label",
    descriptionKey: "workflowTrace.description",
    heading: "Workflow trace",
    pinned: false,
    defaultIncluded: false,
    sensitive: true,
    isAvailable: () => true,
    collect: () => "trace",
  }

  it("appends registrations after the built-ins and honours unregister", () => {
    const off = registerSupportReportSection(custom)
    expect(listSupportReportSections().at(-1)?.id).toBe("workflowTrace")
    expect(defaultSupportReportSectionIds(baseCtx)).not.toContain("workflowTrace")
    off()
    expect(listSupportReportSections().some((s) => s.id === "workflowTrace")).toBe(false)
  })

  it("refuses duplicate ids, built-in or registered", () => {
    expect(() => registerSupportReportSection({ ...custom, id: "runtime" })).toThrow(/runtime/)
    registerSupportReportSection(custom)
    expect(() => registerSupportReportSection(custom)).toThrow(/workflowTrace/)
  })

  it("unregister is a no-op for a stale handle", () => {
    const off = registerSupportReportSection(custom)
    off()
    const again = registerSupportReportSection({ ...custom })
    off()
    expect(listSupportReportSections().some((s) => s.id === "workflowTrace")).toBe(true)
    again()
  })
})
