import {
  CHAT_ROW_BUDGET_HYSTERESIS_PX,
  DOCK_OVERLAY_CHAT_PEEK_PX,
  dockFloorPx,
  dockOverlayWidthPx,
  resolveChatRowBudget,
  type ChatRowBudgetInput,
} from "./chat-row-budget"

const WORKSPACE_FLOOR = { minPx: 480, minPercent: 0 }
const ARTIFACT_FLOOR = { minPx: 0, minPercent: 24 }

/** A left-edge sidebar: 260px open (the icon rail hides), the 56px rail folded. */
function input(overrides: Partial<ChatRowBudgetInput>): ChatRowBudgetInput {
  return {
    totalPx: 1400,
    sidebar: "expanded",
    expandedSidebarPx: 260,
    foldedSidebarPx: 56,
    foldAllowed: true,
    dockOpen: true,
    dockFloor: WORKSPACE_FLOOR,
    chatMinPx: 420,
    ...overrides,
  }
}

describe("resolveChatRowBudget", () => {
  // Workspace profile: the chat (420) and the dock floor (480) need 900px.
  it.each([
    ["room for everything", 1300, { autoFold: false, needsFold: false, overlay: false }, 1040],
    ["exactly enough with the sidebar open", 1160, { autoFold: false, overlay: false }, 900],
    ["one pixel short: fold", 1159, { autoFold: true, needsFold: true, overlay: false }, 1103],
    ["folded still fits", 956, { autoFold: true, overlay: false }, 900],
    ["folded is short too: overlay", 955, { autoFold: true, overlay: true }, 899],
  ])("%s (%ipx)", (_label, totalPx, expected, groupPx) => {
    const budget = resolveChatRowBudget(input({ totalPx }))
    expect(budget).toMatchObject({ ...expected, groupPx })
  })

  it("keeps an auto fold until the open sidebar clears the floor with slack", () => {
    const folded = (totalPx: number) =>
      resolveChatRowBudget(input({ totalPx, sidebar: "auto-folded" }))
    // 1160 fits exactly, so a fresh evaluation would not fold — but an existing
    // fold holds until the hysteresis is cleared too.
    expect(folded(1160)).toMatchObject({ autoFold: true, needsFold: true })
    expect(folded(1160 + CHAT_ROW_BUDGET_HYSTERESIS_PX - 1)).toMatchObject({ autoFold: true })
    expect(folded(1160 + CHAT_ROW_BUDGET_HYSTERESIS_PX)).toMatchObject({
      autoFold: false,
      needsFold: false,
      overlay: false,
    })
  })

  it("floats the dock instead of folding once the user re-opened the sidebar", () => {
    expect(resolveChatRowBudget(input({ totalPx: 1100, foldAllowed: false }))).toEqual({
      autoFold: false,
      needsFold: true,
      overlay: true,
      groupPx: 840,
    })
  })

  it("releases the fold, and never overlays, while the dock is closed", () => {
    expect(
      resolveChatRowBudget(input({ totalPx: 900, sidebar: "auto-folded", dockOpen: false }))
    ).toEqual({ autoFold: false, needsFold: false, overlay: false, groupPx: 640 })
  })

  it("leaves a sidebar the user folded to the user", () => {
    const userFolded = (totalPx: number) =>
      resolveChatRowBudget(input({ totalPx, sidebar: "user-folded" }))
    expect(userFolded(1000)).toEqual({
      autoFold: false,
      needsFold: false,
      overlay: false,
      groupPx: 944,
    })
    expect(userFolded(900)).toMatchObject({ autoFold: false, overlay: true, groupPx: 844 })
    expect(
      resolveChatRowBudget(input({ totalPx: 900, sidebar: "user-folded", dockOpen: false }))
    ).toMatchObject({ overlay: false })
  })

  it("scales an artifact dock's floor with the row", () => {
    // 24% floor: the group needs 420 / 0.76 ≈ 553px.
    const artifact = (totalPx: number) =>
      resolveChatRowBudget(input({ totalPx, dockFloor: ARTIFACT_FLOOR }))
    expect(artifact(813)).toMatchObject({ autoFold: false, groupPx: 553 })
    expect(artifact(812)).toMatchObject({ autoFold: true, overlay: false })
    expect(artifact(608)).toMatchObject({ autoFold: true, overlay: true })
  })

  it("holds while the row is unmeasured", () => {
    expect(resolveChatRowBudget(input({ totalPx: 0 }))).toBeNull()
    expect(resolveChatRowBudget(input({ totalPx: Number.NaN }))).toBeNull()
  })
})

describe("dockFloorPx", () => {
  it("takes the larger of the absolute and the proportional floor", () => {
    expect(dockFloorPx(WORKSPACE_FLOOR, 1000)).toBe(480)
    expect(dockFloorPx(ARTIFACT_FLOOR, 1000)).toBe(240)
    expect(dockFloorPx({ minPx: 300, minPercent: 24 }, 1000)).toBe(300)
  })
})

describe("dockOverlayWidthPx", () => {
  it("keeps the in-row width, the floor, and a strip of the chat in view", () => {
    expect(dockOverlayWidthPx(1000, 34, ARTIFACT_FLOOR)).toBe(340)
    // The floor wins over a narrow preference…
    expect(dockOverlayWidthPx(800, 45, WORKSPACE_FLOOR)).toBe(480)
    // …and the chat's strip wins over the floor.
    expect(dockOverlayWidthPx(500, 45, WORKSPACE_FLOOR)).toBe(500 - DOCK_OVERLAY_CHAT_PEEK_PX)
    expect(dockOverlayWidthPx(20, 45, WORKSPACE_FLOOR)).toBe(0)
  })
})
