/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({ useLocale: () => "en" }))

import { QuestsTab } from "./quests-tab"
import { advanceQuests, ensureDay } from "./quest-engine"
import { configureQuestStore, disposeQuestStore } from "./quest-store"
import type { QuestState } from "./quest-engine"

function configure(initial: QuestState | undefined, reward = jest.fn()) {
  configureQuestStore(initial, {
    persist: jest.fn(),
    reward: reward.mockResolvedValue({ grantedXp: 3, grantedCoins: 5 }),
    getRemainingBudget: () => ({ xp: 42, coins: 77 }),
    now: () => new Date("2026-07-02T12:00:00").getTime(),
  })
  return reward
}

afterEach(() => {
  disposeQuestStore()
})

describe("QuestsTab", () => {
  it("renders the empty hint before the store is configured", () => {
    render(<QuestsTab />)
    expect(screen.getByTestId("pet-daily-quests-empty")).toBeInTheDocument()
  })

  it("renders the day's quests with progress and the budget footer", () => {
    configure(undefined)
    render(<QuestsTab />)
    expect(screen.getByTestId("pet-daily-quests-tab")).toBeInTheDocument()
    expect(document.querySelectorAll("[data-quest]")).toHaveLength(3)
    expect(screen.getByTestId("pet-daily-quests-budget").textContent).toContain("42")
    expect(screen.getByTestId("pet-daily-quests-budget").textContent).toContain("77")
  })

  it("enables Claim only for completed quests and routes it to the reward effect", () => {
    // Seed a state whose first quest is completed.
    let state = ensureDay(undefined, "2026-07-02")
    const first = state.quests[0]
    for (let i = 0; i < 10 && !state.quests.find((q) => q.id === first.id)!.done; i++) {
      for (const kind of ["fed", "played", "petted", "talked", "slept", "cleaned", "treated"]) {
        state = advanceQuests(state, kind)
      }
    }
    const reward = configure(state)
    render(<QuestsTab />)
    const doneQuest = state.quests.find((q) => q.done)
    // Non-goal quests complete via the interaction sweep above; a goal-only
    // roll can't happen (the pool has a single goal quest).
    expect(doneQuest).toBeDefined()
    const claim = document.querySelector(
      `[data-action="claim-${doneQuest!.id}"]`
    ) as HTMLButtonElement
    expect(claim).not.toBeDisabled()
    fireEvent.click(claim)
    expect(reward).toHaveBeenCalledWith({ xp: expect.any(Number), coins: expect.any(Number) })
  })
})
