import {
  MAX_PROJECT_BORROW_TOKENS,
  PROJECT_RECALL_CEILING_TOKENS,
  maxCombinedRecallTokens,
  resolveProjectRecallBudget,
} from "./recall-budget"
import { DEFAULT_MEMORY_CONFIG } from "../types/memory"

describe("resolveProjectRecallBudget", () => {
  it("gives the project section its own budget when personal spent everything", () => {
    // The personal budget is NOT carved up — this is the whole reason the
    // combined ceiling rises instead of personal recall shrinking on upgrade.
    expect(
      resolveProjectRecallBudget({ personalLimit: 900, personalUsed: 900, projectBudget: 450 })
    ).toEqual({ limit: 450, borrowed: 0 })
  })

  it("lends unused personal headroom to the project section", () => {
    expect(
      resolveProjectRecallBudget({ personalLimit: 900, personalUsed: 700, projectBudget: 450 })
    ).toEqual({ limit: 650, borrowed: 200 })
  })

  it("caps borrowing so a quiet personal turn cannot buy an enormous project block", () => {
    const { limit, borrowed } = resolveProjectRecallBudget({
      personalLimit: 900,
      personalUsed: 0,
      projectBudget: 450,
    })
    expect(borrowed).toBe(MAX_PROJECT_BORROW_TOKENS)
    expect(limit).toBe(900)
  })

  it("never exceeds the project ceiling however generous the config", () => {
    expect(
      resolveProjectRecallBudget({ personalLimit: 5_000, personalUsed: 0, projectBudget: 5_000 })
        .limit
    ).toBe(PROJECT_RECALL_CEILING_TOKENS)
  })

  it("does not go negative when personal overspent its limit", () => {
    expect(
      resolveProjectRecallBudget({ personalLimit: 900, personalUsed: 1_200, projectBudget: 450 })
    ).toEqual({ limit: 450, borrowed: 0 })
  })

  it("pins the combined ceiling the settings copy promises", () => {
    expect(
      maxCombinedRecallTokens(
        DEFAULT_MEMORY_CONFIG.recallTokenBudget,
        DEFAULT_MEMORY_CONFIG.projectRecallTokenBudget
      )
    ).toBe(1_350)
  })

  it("cannot be exceeded at ANY level of personal spend", () => {
    // Searched rather than argued: the advertised ceiling is what the settings
    // copy tells the user their turns can cost, and `personalLimit + maxProject`
    // is the plausible-looking figure that is actually unreachable — every token
    // the project section borrows is a token personal did not spend.
    const personalLimit = DEFAULT_MEMORY_CONFIG.recallTokenBudget
    const projectBudget = DEFAULT_MEMORY_CONFIG.projectRecallTokenBudget
    const advertised = maxCombinedRecallTokens(personalLimit, projectBudget)
    let worst = 0
    for (let personalUsed = 0; personalUsed <= personalLimit; personalUsed += 1) {
      const { limit } = resolveProjectRecallBudget({ personalLimit, personalUsed, projectBudget })
      worst = Math.max(worst, personalUsed + limit)
    }
    expect(worst).toBe(advertised)
  })
})
