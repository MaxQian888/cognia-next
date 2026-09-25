/**
 * @jest-environment jsdom
 */
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react"
import { registerPluginI18n, unregisterPluginI18n } from "@cognia/plugin-sdk/api/i18n"

import manifestJson from "../plugin.json"
import { QuestsTab } from "./quests-tab"
import { advanceQuests, ensureDay } from "./quest-engine"
import { configureQuestStore, disposeQuestStore } from "./quest-store"
import type { QuestState } from "./quest-engine"

type Grant = { grantedXp: number; grantedCoins: number }

/** Register the bundle the way the manager does on enable: keys prefixed. */
function registerBundle() {
  const prefixed = Object.fromEntries(
    Object.entries(manifestJson.i18n.locales).map(([locale, dict]) => [
      locale,
      Object.fromEntries(
        Object.entries(dict).map(([key, value]) => [`plugin.${manifestJson.id}.${key}`, value])
      ),
    ])
  )
  registerPluginI18n({ pluginId: manifestJson.id, messages: prefixed })
}

function configure(
  initial: QuestState | undefined,
  reward = jest.fn(async (_reward: { xp: number; coins: number }): Promise<Grant> => ({
    grantedXp: 3,
    grantedCoins: 5,
  }))
) {
  const reportClaimFailure = jest.fn()
  configureQuestStore(initial, {
    persist: jest.fn(),
    reward,
    getRemainingBudget: () => ({ xp: 42, coins: 77 }),
    reportClaimFailure,
    now: () => new Date("2026-07-02T12:00:00").getTime(),
  })
  return { reward, reportClaimFailure }
}

/** A state for 2026-07-02 whose interaction quests are all completed. */
function completedState(): QuestState {
  let state = ensureDay(undefined, "2026-07-02")
  for (let i = 0; i < 5; i++) {
    for (const kind of ["fed", "played", "petted", "talked", "slept", "cleaned", "treated"]) {
      state = advanceQuests(state, kind)
    }
  }
  return state
}

function claimButton(questId: string): HTMLButtonElement {
  return document.querySelector(`[data-action="claim-${questId}"]`) as HTMLButtonElement
}

beforeEach(() => registerBundle())

afterEach(() => {
  // A still-mounted tab re-renders on dispose; keep that inside act().
  act(() => disposeQuestStore())
  unregisterPluginI18n(manifestJson.id)
})

describe("QuestsTab", () => {
  it("renders the empty hint before the store is configured", () => {
    render(<QuestsTab />)
    expect(screen.getByTestId("pet-daily-quests-empty")).toHaveTextContent("Quests are warming up…")
  })

  it("renders the day's quests with localized progress and the budget footer", () => {
    configure(undefined)
    render(<QuestsTab />)
    expect(screen.getByTestId("pet-daily-quests-tab")).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Daily Quests" })).toBeInTheDocument()
    expect(document.querySelectorAll("[data-quest]")).toHaveLength(3)
    expect(screen.getByTestId("pet-daily-quests-budget")).toHaveTextContent(
      "Today's reward budget left: 42 XP · 77 coins"
    )
    // A single-prefixed bundle resolves; a double-prefixed one would print keys.
    expect(document.body.textContent).not.toMatch(/\b(?:tab|quest)\.[a-z0-9]+/)
  })

  it("enables Claim only for completed quests, with a touch-sized target", async () => {
    const state = completedState()
    const { reward } = configure(state)
    render(<QuestsTab />)
    const doneQuest = state.quests.find((q) => q.done)
    // Non-goal quests complete via the interaction sweep above; a goal-only
    // roll can't happen (the pool has a single goal quest).
    expect(doneQuest).toBeDefined()
    const claim = claimButton(doneQuest!.id)
    expect(claim).not.toBeDisabled()
    expect(claim).toHaveClass("min-h-9")
    expect(claim).toHaveAccessibleName(expect.stringMatching(/^Claim the reward for /))
    fireEvent.click(claim)
    expect(reward).toHaveBeenCalledWith({ xp: expect.any(Number), coins: expect.any(Number) })
    await waitFor(() => expect(claimButton(doneQuest!.id)).toHaveTextContent("Claimed"))
  })

  it("shows the claim in flight and refuses a second tap until it settles", async () => {
    const state = completedState()
    const doneQuest = state.quests.find((q) => q.done)!
    let settle: (grant: Grant) => void = () => undefined
    const { reward } = configure(
      state,
      jest.fn(
        (_reward: { xp: number; coins: number }) =>
          new Promise<Grant>((resolve) => {
            settle = resolve
          })
      )
    )
    render(<QuestsTab />)

    fireEvent.click(claimButton(doneQuest.id))
    await waitFor(() => expect(claimButton(doneQuest.id)).toBeDisabled())
    expect(claimButton(doneQuest.id)).toHaveTextContent("Claiming…")
    expect(claimButton(doneQuest.id)).toHaveAttribute("aria-busy", "true")
    fireEvent.click(claimButton(doneQuest.id))
    expect(reward).toHaveBeenCalledTimes(1)

    await act(async () => settle({ grantedXp: 3, grantedCoins: 5 }))
    await waitFor(() => expect(claimButton(doneQuest.id)).toHaveTextContent("Claimed"))
    expect(claimButton(doneQuest.id)).toBeDisabled()
  })

  it("reports a refused claim and leaves the quest claimable", async () => {
    const state = completedState()
    const doneQuest = state.quests.find((q) => q.done)!
    const error = new Error("pet:interact denied")
    const { reportClaimFailure } = configure(
      state,
      jest.fn(async (_reward: { xp: number; coins: number }): Promise<Grant> => {
        throw error
      })
    )
    render(<QuestsTab />)

    fireEvent.click(claimButton(doneQuest.id))

    await waitFor(() => expect(reportClaimFailure).toHaveBeenCalledWith(doneQuest.id, error))
    await waitFor(() => expect(claimButton(doneQuest.id)).not.toBeDisabled())
    expect(claimButton(doneQuest.id)).toHaveTextContent("Claim")
  })
})
