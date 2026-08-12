import { reviewTwinDraft } from "./review-draft"

function deps(draft: Record<string, unknown>) {
  return {
    getDraft: jest.fn(async () => draft),
    createCharacter: jest.fn(async () => ({ id: "character-1" })),
    createSkill: jest.fn(async () => ({ id: "skill-1" })),
    accept: jest.fn(async (..._args: unknown[]) => undefined),
    reject: jest.fn(async (..._args: unknown[]) => undefined),
    getProfile: jest.fn(async () => ({
      playbooks: [
        {
          id: "playbook-1",
          title: "Triage",
          trigger: "Issue arrives",
          steps: [],
          examples: [],
          confidence: 0.9,
        },
      ],
    })),
    updatePlaybook: jest.fn(async (..._args: unknown[]) => undefined),
  }
}

it("accepts a Character draft through one idempotent service", async () => {
  const d = deps({
    id: "draft-1",
    twinId: "twin-1",
    status: "pending",
    payload: { kind: "character", data: { name: "Alice", systemPrompt: "Be concise" } },
  })

  await expect(
    reviewTwinDraft({ action: "accept", draftId: "draft-1" }, d as never)
  ).resolves.toEqual({ status: "accepted", acceptedAsId: "character-1" })
  expect(d.createCharacter).toHaveBeenCalledWith(
    expect.objectContaining({ name: "Alice", twinId: "twin-1", systemPrompt: "Be concise" })
  )
  expect(d.accept).toHaveBeenCalledWith("draft-1", "character-1", undefined)
})

it("accepts a Skill and marks its source playbook promoted", async () => {
  const d = deps({
    id: "draft-2",
    twinId: "twin-1",
    status: "pending",
    payload: {
      kind: "skill",
      data: { name: "Triage", content: "# Steps" },
      sourcePlaybookId: "playbook-1",
    },
  })

  const result = await reviewTwinDraft({ action: "accept", draftId: "draft-2" }, d as never)

  expect(result.acceptedAsId).toBe("skill-1")
  expect(d.updatePlaybook).toHaveBeenCalledWith("twin-1", "playbook-1", {
    id: "playbook-1",
    title: "Triage",
    trigger: "Issue arrives",
    steps: [],
    examples: [],
    confidence: 0.9,
    promotedToSkillId: "skill-1",
  })
})

it("returns an already accepted draft without creating another artifact", async () => {
  const d = deps({
    id: "draft-3",
    twinId: "twin-1",
    status: "accepted",
    acceptedAsId: "existing-1",
    payload: { kind: "character", data: {} },
  })

  await expect(
    reviewTwinDraft({ action: "accept", draftId: "draft-3" }, d as never)
  ).resolves.toEqual({ status: "accepted", acceptedAsId: "existing-1" })
  expect(d.createCharacter).not.toHaveBeenCalled()
  expect(d.createSkill).not.toHaveBeenCalled()
})

it("rejects a pending draft without creating an artifact", async () => {
  const d = deps({
    id: "draft-4",
    twinId: "twin-1",
    status: "pending",
    payload: { kind: "character", data: {} },
  })

  await expect(
    reviewTwinDraft({ action: "reject", draftId: "draft-4" }, d as never)
  ).resolves.toEqual({ status: "rejected" })
  expect(d.reject).toHaveBeenCalledWith("draft-4", undefined)
})

it("coalesces concurrent reviews of the same draft into one artifact", async () => {
  let status: "pending" | "accepted" = "pending"
  let acceptedAsId: string | undefined
  const d = deps({})
  d.getDraft.mockImplementation(async () => ({
    id: "draft-concurrent",
    twinId: "twin-1",
    status,
    acceptedAsId,
    payload: { kind: "character", data: { name: "Alice" } },
  }))
  d.accept.mockImplementation(async (...args) => {
    const artifactId = args[1]
    status = "accepted"
    acceptedAsId = typeof artifactId === "string" ? artifactId : undefined
  })

  const results = await Promise.all([
    reviewTwinDraft({ action: "accept", draftId: "draft-concurrent" }, d as never),
    reviewTwinDraft({ action: "accept", draftId: "draft-concurrent" }, d as never),
  ])

  expect(results).toEqual([
    { status: "accepted", acceptedAsId: "character-1" },
    { status: "accepted", acceptedAsId: "character-1" },
  ])
  expect(d.createCharacter).toHaveBeenCalledTimes(1)
  expect(d.accept).toHaveBeenCalledTimes(1)
})

it("rejects a conflicting concurrent review action explicitly", async () => {
  let releaseCreate: (() => void) | undefined
  const d = deps({
    id: "draft-conflict",
    twinId: "twin-1",
    status: "pending",
    payload: { kind: "character", data: { name: "Alice" } },
  })
  d.createCharacter.mockImplementation(
    () =>
      new Promise((resolve) => {
        releaseCreate = () => resolve({ id: "character-1" })
      })
  )

  const accepting = reviewTwinDraft({ action: "accept", draftId: "draft-conflict" }, d as never)
  await Promise.resolve()
  await expect(
    reviewTwinDraft({ action: "reject", draftId: "draft-conflict" }, d as never)
  ).rejects.toThrow("review conflict")
  releaseCreate!()
  await expect(accepting).resolves.toMatchObject({ status: "accepted" })
  expect(d.reject).not.toHaveBeenCalled()
})
