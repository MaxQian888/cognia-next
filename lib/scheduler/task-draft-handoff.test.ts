import {
  __clearScheduledTaskDraftForTesting,
  consumeScheduledTaskDraft,
  DRAFT_TTL_MS,
  stageScheduledTaskDraft,
} from "./task-draft-handoff"

beforeEach(() => {
  __clearScheduledTaskDraftForTesting()
})

describe("scheduled-task draft handoff", () => {
  it("hands the staged draft to the first consumer", () => {
    stageScheduledTaskDraft({ name: "Morning triage", type: "chat" }, { summary: "every morning" })

    const taken = consumeScheduledTaskDraft()
    expect(taken?.input.name).toBe("Morning triage")
    expect(taken?.summary).toBe("every morning")
  })

  it("only hands it over once", () => {
    stageScheduledTaskDraft({ name: "One" })
    expect(consumeScheduledTaskDraft()).not.toBeNull()
    // A StrictMode double-effect or a back-navigation must not reopen the
    // sheet with a draft the user already saw.
    expect(consumeScheduledTaskDraft()).toBeNull()
  })

  it("keeps only the newest draft", () => {
    stageScheduledTaskDraft({ name: "Old" })
    stageScheduledTaskDraft({ name: "New" })
    expect(consumeScheduledTaskDraft()?.input.name).toBe("New")
  })

  it("drops a draft nobody picked up in time", () => {
    stageScheduledTaskDraft({ name: "Stale" }, { nowMs: 0 })
    expect(consumeScheduledTaskDraft({ nowMs: DRAFT_TTL_MS + 1 })).toBeNull()
  })

  it("keeps a draft that is still inside the window", () => {
    stageScheduledTaskDraft({ name: "Fresh" }, { nowMs: 0 })
    expect(consumeScheduledTaskDraft({ nowMs: DRAFT_TTL_MS - 1 })?.input.name).toBe("Fresh")
  })

  it("returns null when nothing was staged", () => {
    expect(consumeScheduledTaskDraft()).toBeNull()
  })
})
