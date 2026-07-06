import { runRadarReport, NoRadarModelError } from "./radar-runner"
import { getSettings } from "@/lib/db/settings"
import { buildUtilityLlmClient } from "@/lib/ai/generation/utility-client"
import { collectRadarItems } from "./collect"
import { generateRadarReport } from "./generate"
import { getLatestRadarReport, saveRadarReport, pruneRadarReports } from "@/lib/db/radar-reports"
import type { RadarDataItem } from "@/types/radar"

jest.mock("@/lib/db/settings", () => ({ getSettings: jest.fn() }))
jest.mock("@/lib/ai/generation/utility-client", () => ({ buildUtilityLlmClient: jest.fn() }))
jest.mock("./collect", () => ({
  ...jest.requireActual("./collect"),
  collectRadarItems: jest.fn(),
}))
jest.mock("./generate", () => ({ generateRadarReport: jest.fn() }))
jest.mock("@/lib/db/radar-reports", () => ({
  getLatestRadarReport: jest.fn(),
  saveRadarReport: jest.fn(),
  pruneRadarReports: jest.fn(),
}))

const mockGetSettings = getSettings as jest.Mock
const mockBuildClient = buildUtilityLlmClient as jest.Mock
const mockCollect = collectRadarItems as jest.Mock
const mockGenerate = generateRadarReport as jest.Mock
const mockLatest = getLatestRadarReport as jest.Mock
const mockSave = saveRadarReport as jest.Mock
const mockPrune = pruneRadarReports as jest.Mock

const NOW = 100 * 86_400_000

function items(n: number): RadarDataItem[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `i${i}`,
    text: `t${i}`,
    source: "memory" as const,
    at: NOW,
  }))
}

beforeEach(() => {
  jest.clearAllMocks()
  mockGetSettings.mockResolvedValue({
    attentionRadar: { enabled: true, intervalDays: 3, windowDays: 14 },
  })
  mockBuildClient.mockReturnValue({ complete: jest.fn() })
  mockLatest.mockResolvedValue(undefined)
  mockGenerate.mockResolvedValue({
    verdict: "v",
    atAGlance: [],
    infoDiet: "",
    subconscious: "",
    graveyard: [],
    blindSpots: "",
    actions: [],
    topicCloud: [],
  })
})

describe("runRadarReport", () => {
  it("generates + persists a report on the happy path", async () => {
    mockCollect.mockResolvedValue(items(6))
    const report = await runRadarReport({ now: NOW })
    expect(report).not.toBeNull()
    expect(report?.itemCount).toBe(6)
    expect(report?.heatmap).toHaveLength(14)
    expect(mockSave).toHaveBeenCalled()
    expect(mockPrune).toHaveBeenCalled()
  })

  it("skips when the last report is within the interval", async () => {
    mockLatest.mockResolvedValue({ generatedAt: NOW - 86_400_000 }) // 1 day ago < 3
    const report = await runRadarReport({ now: NOW })
    expect(report).toBeNull()
    expect(mockCollect).not.toHaveBeenCalled()
  })

  it("forces past the interval guard", async () => {
    mockLatest.mockResolvedValue({ generatedAt: NOW - 86_400_000 })
    mockCollect.mockResolvedValue(items(6))
    expect(await runRadarReport({ now: NOW, force: true })).not.toBeNull()
  })

  it("skips when there are too few items", async () => {
    mockCollect.mockResolvedValue(items(2))
    expect(await runRadarReport({ now: NOW })).toBeNull()
    expect(mockGenerate).not.toHaveBeenCalled()
  })

  it("throws NoRadarModelError when no client resolves", async () => {
    mockCollect.mockResolvedValue(items(6))
    mockBuildClient.mockReturnValue(null)
    await expect(runRadarReport({ now: NOW })).rejects.toBeInstanceOf(NoRadarModelError)
  })
})
