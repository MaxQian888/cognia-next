import { gatherTwinRoster, MAX_TWIN_ROSTER } from "./twin-roster"
import { gatherTeamTwins } from "../twin-context"
import type { TeamTwinSummary } from "../team-run-context"

jest.mock("../twin-context", () => ({ gatherTeamTwins: jest.fn() }))
const mockGather = gatherTeamTwins as jest.MockedFunction<typeof gatherTeamTwins>

describe("gatherTwinRoster", () => {
  afterEach(() => {
    jest.clearAllMocks()
  })

  it("maps id -> twinId, carrying name + expertise through", async () => {
    mockGather.mockResolvedValueOnce([{ id: "t1", name: "Alice", expertise: "security" }])
    const roster = await gatherTwinRoster({ gather: mockGather })
    expect(roster).toEqual([{ twinId: "t1", name: "Alice", expertise: "security" }])
  })

  it("caps the roster at MAX_TWIN_ROSTER when more twins are available", async () => {
    const many: TeamTwinSummary[] = Array.from({ length: 30 }, (_, i) => ({
      id: `t${i}`,
      name: `Twin ${i}`,
      expertise: "",
    }))
    mockGather.mockResolvedValueOnce(many)
    const roster = await gatherTwinRoster({ gather: mockGather })
    expect(roster).toHaveLength(MAX_TWIN_ROSTER)
    expect(roster[0].twinId).toBe("t0")
    expect(roster[MAX_TWIN_ROSTER - 1].twinId).toBe(`t${MAX_TWIN_ROSTER - 1}`)
  })

  it("fails open to [] when the gather rejects", async () => {
    mockGather.mockRejectedValueOnce(new Error("registry down"))
    const roster = await gatherTwinRoster({ gather: mockGather })
    expect(roster).toEqual([])
  })

  it("falls back to the live gatherTeamTwins when deps.gather is omitted", async () => {
    mockGather.mockResolvedValueOnce([{ id: "t9", name: "Default", expertise: "x" }])
    const roster = await gatherTwinRoster()
    expect(mockGather).toHaveBeenCalled()
    expect(roster).toEqual([{ twinId: "t9", name: "Default", expertise: "x" }])
  })
})
