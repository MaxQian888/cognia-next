import { collectRadarItems, computeHeatmap } from "./collect"
import { listMemories } from "@/lib/db/memories"
import type { Memory } from "@/types/memory/memory"
import type { RadarDataItem } from "@/types/radar"

jest.mock("@/lib/db/memories", () => ({ listMemories: jest.fn() }))
jest.mock("@/lib/db/captured-items", () => ({ listCapturedItemsSince: jest.fn(async () => []) }))
const mockList = listMemories as jest.Mock

function mem(id: string, text: string, updatedAt: number, importance = 5): Memory {
  return {
    id,
    scope: "global",
    type: "semantic",
    text,
    tags: [],
    importance,
    createdAt: updatedAt,
    updatedAt,
    lastAccessedAt: updatedAt,
    accessCount: 0,
    version: 1,
    status: "active",
    pinned: false,
    provenance: "distilled",
  } as unknown as Memory
}

const NOW = 10 * 86_400_000

beforeEach(() => jest.clearAllMocks())

describe("collectRadarItems", () => {
  it("maps in-window memories and drops out-of-window ones", async () => {
    mockList.mockResolvedValue([
      mem("recent", "learned about vector databases today", NOW - 86_400_000),
      mem("old", "ancient note", NOW - 40 * 86_400_000),
    ])
    const out = await collectRadarItems({ windowDays: 14, now: NOW })
    expect(out.map((i) => i.id)).toEqual(["recent"])
    expect(out[0].source).toBe("memory")
  })

  it("drops items that would leak PII", async () => {
    mockList.mockResolvedValue([
      mem("clean", "notes about rust ownership", NOW),
      mem("leak", "email me at bob@example.com", NOW),
    ])
    const out = await collectRadarItems({ windowDays: 14, now: NOW })
    expect(out.map((i) => i.id)).toEqual(["clean"])
  })

  it("folds in extra items (captures)", async () => {
    mockList.mockResolvedValue([])
    const extra: RadarDataItem[] = [
      { id: "cap1", text: "saved article about kubernetes", source: "capture", at: NOW },
    ]
    const out = await collectRadarItems({ windowDays: 14, now: NOW, extra })
    expect(out.map((i) => i.id)).toEqual(["cap1"])
  })
})

describe("computeHeatmap", () => {
  it("produces one cell per window day with correct counts", () => {
    const items: RadarDataItem[] = [
      { id: "a", text: "x", source: "memory", at: NOW },
      { id: "b", text: "y", source: "memory", at: NOW },
      { id: "c", text: "z", source: "memory", at: NOW - 86_400_000 },
    ]
    const heat = computeHeatmap(items, 3, NOW)
    expect(heat).toHaveLength(3)
    const today = new Date(NOW).toISOString().slice(0, 10)
    expect(heat.find((h) => h.day === today)?.count).toBe(2)
  })
})
