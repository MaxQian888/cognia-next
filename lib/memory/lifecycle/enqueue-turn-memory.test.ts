import { enqueueTurnMemory } from "./enqueue-turn-memory"

const mockEnqueueJob = jest.fn()
const mockClaimJob = jest.fn()
const mockResolveCharacter = jest.fn()
const mockCreateEvidence = jest.fn()

jest.mock("@/lib/db/sessions", () => ({ getSession: jest.fn() }))
jest.mock("@/lib/db/settings", () => ({ getSettings: jest.fn() }))
jest.mock("@/lib/db/characters", () => ({
  resolveCharacterById: (...args: unknown[]) => mockResolveCharacter(...args),
}))
jest.mock("@/lib/db/project-scope", () => ({
  resolveSessionProjectId: jest.fn(
    async (_id: string, explicit?: string | null) => explicit ?? "proj-active"
  ),
  resolveScopeProjectId: jest.fn(async () => "proj-active"),
}))
jest.mock("@/lib/memory/write/run-memory-extraction", () => ({
  sessionProvenance: jest.fn(() => "user"),
}))
jest.mock("@/lib/memory/lifecycle/maintenance", () => ({
  scheduleMemoryMaintenance: jest.fn(),
}))
jest.mock("@/lib/db/memory-governance", () => ({
  appendMemoryAuditEvent: jest.fn(async (event) => event),
  enqueueMemoryJob: (...args: unknown[]) => mockEnqueueJob(...args),
  claimMemoryJob: (...args: unknown[]) => mockClaimJob(...args),
  createMemoryEvidence: (...args: unknown[]) => mockCreateEvidence(...args),
}))

import { getSession } from "@/lib/db/sessions"
import { getSettings } from "@/lib/db/settings"
import { scheduleMemoryMaintenance } from "@/lib/memory/lifecycle/maintenance"
import { appendMemoryAuditEvent } from "@/lib/db/memory-governance"

const mockGetSession = getSession as jest.Mock
const mockGetSettings = getSettings as jest.Mock
const mockSchedule = scheduleMemoryMaintenance as jest.Mock
const mockAppendAudit = appendMemoryAuditEvent as jest.Mock

const TRANSCRIPT = [
  { role: "user", text: "remember my timezone is UTC+8" },
  { role: "assistant", text: "noted, UTC+8" },
]

const INPUT = {
  sessionId: "s1",
  userText: "remember my timezone is UTC+8",
  assistantText: "noted, UTC+8",
  transcript: TRANSCRIPT,
}

function setMemory(partial?: Record<string, unknown>) {
  mockGetSettings.mockResolvedValue({ memory: partial })
}

/** Long enough to close a mining window, and salient enough to clear the gate. */
const PROJECT_TRANSCRIPT = Array.from({ length: 26 }, (_, index) => ({
  id: `m${index}`,
  role: index % 2 === 0 ? "user" : "assistant",
  text:
    index % 2 === 0
      ? "why does pnpm build fail in packages/memory/src/index.ts"
      : "it must be in SERVER_ONLY_PACKAGES, because the static export breaks otherwise",
}))

beforeEach(() => {
  jest.clearAllMocks()
  mockEnqueueJob.mockResolvedValue({ id: "job-1", status: "queued" })
  mockResolveCharacter.mockResolvedValue(undefined)
  setMemory({})
  mockGetSession.mockResolvedValue({ id: "s1", characterId: "c1" })
})

function turnDraft() {
  return mockEnqueueJob.mock.calls
    .map(([draft]) => draft)
    .find((draft) => draft.kind === "turn-extraction")
}

describe("enqueueTurnMemory", () => {
  it("queues one turn-extraction job and schedules maintenance on a clean turn", async () => {
    await expect(enqueueTurnMemory(INPUT)).resolves.toEqual({ enqueued: true, jobId: "job-1" })
    expect(turnDraft()).toMatchObject({ kind: "turn-extraction", scope: "global" })
    expect(mockSchedule).toHaveBeenCalledTimes(1)
    expect(mockSchedule.mock.calls[0][0]).toMatchObject({ sessionId: "s1", provenance: "user" })
  })

  // The whole point of the split: the enqueue decides, the worker runs.
  it("never claims or runs the job it queued", async () => {
    await enqueueTurnMemory(INPUT)
    expect(mockClaimJob).not.toHaveBeenCalled()
  })

  // These rows carried no memoryId, were stored as `job.evidenceIds` that the
  // worker never read, and `deleteMemoryEvidence` keys on memoryId, so every
  // turn leaked two permanently unreachable rows.
  it("creates no evidence before the job exists", async () => {
    await enqueueTurnMemory(INPUT)
    expect(mockCreateEvidence).not.toHaveBeenCalled()
    expect(turnDraft()).toMatchObject({ evidenceIds: [] })
  })

  it("reads settings from Dexie so it works off the renderer", async () => {
    await enqueueTurnMemory(INPUT)
    expect(mockGetSettings).toHaveBeenCalledTimes(1)
  })

  it("prefers settings the caller already has", async () => {
    await enqueueTurnMemory({ ...INPUT, settings: { memory: {} } as never })
    expect(mockGetSettings).not.toHaveBeenCalled()
    expect(turnDraft()).toBeDefined()
  })

  it("pins the job to a message-id checkpoint keyed by the last id and count", async () => {
    mockGetSession.mockResolvedValue({ id: "s1", characterId: "c1", transcriptRevision: 6 })
    await enqueueTurnMemory({
      ...INPUT,
      transcript: [
        { id: "m1", role: "user", text: "remember my timezone is UTC+8" },
        { id: "m2", role: "assistant", text: "noted, UTC+8" },
      ],
    })
    expect(turnDraft()).toMatchObject({
      dedupeKey: "turn-extraction:s1:m2:2",
      checkpoint: {
        transcriptRevision: 6,
        firstMessageId: "m1",
        lastMessageId: "m2",
        messageCount: 2,
      },
    })
  })

  it("keeps the legacy dedupe-key shape when the transcript carries no ids", async () => {
    // Shipped databases hold queued jobs keyed `turn-extraction:<session>:turn:<n>`.
    // Emitting a different shape would orphan them and re-enqueue the work.
    await enqueueTurnMemory(INPUT)
    expect(turnDraft()).toMatchObject({
      dedupeKey: "turn-extraction:s1:turn:2",
      checkpoint: undefined,
    })
  })

  it("carries the workspace namespace onto the job", async () => {
    setMemory({ scopeDefault: "workspace" })
    mockGetSession.mockResolvedValue({ id: "s1", projectId: "project-a", characterId: "c1" })
    await enqueueTurnMemory(INPUT)
    expect(turnDraft()).toMatchObject({ scope: "workspace", projectId: "project-a" })
  })

  // The user's own setting IS the applicability rationale ADR-0115 asks for, so
  // a configured narrow scope is honoured rather than silently widened.
  it("honours a configured agent scope when the namespace exists", async () => {
    setMemory({ scopeDefault: "agent" })
    mockResolveCharacter.mockResolvedValue({ id: "c1", twinId: "alice" })
    await enqueueTurnMemory(INPUT)
    expect(turnDraft()).toMatchObject({ scope: "agent", agentId: "twin:alice" })
  })

  it("falls back rather than narrowing to a namespace that does not exist", async () => {
    setMemory({ scopeDefault: "agent" })
    mockGetSession.mockResolvedValue({ id: "s1" })
    await enqueueTurnMemory(INPUT)
    expect(turnDraft()).toMatchObject({ scope: "workspace", agentId: undefined })
  })

  it.each([
    ["empty user text", { userText: "   " }, "empty"],
    ["a missing session row", {}, "session_missing"],
  ])("declines %s", async (_label, over, reason) => {
    if (reason === "session_missing") mockGetSession.mockResolvedValue(undefined)
    await expect(enqueueTurnMemory({ ...INPUT, ...over })).resolves.toMatchObject({
      enqueued: false,
      reason,
    })
    expect(mockEnqueueJob).not.toHaveBeenCalled()
  })

  it("declines before reading settings when the user text is empty", async () => {
    await enqueueTurnMemory({ ...INPUT, userText: "   " })
    expect(mockGetSettings).not.toHaveBeenCalled()
    expect(mockGetSession).not.toHaveBeenCalled()
  })

  it("declines when there are no settings at all", async () => {
    mockGetSettings.mockResolvedValue(undefined)
    await expect(enqueueTurnMemory(INPUT)).resolves.toMatchObject({
      enqueued: false,
      reason: "settings_unavailable",
    })
  })

  it.each([
    ["memory is disabled", { enabled: false }],
    ["the session is temporary", { temporary: true }],
  ])("declines when %s", async (_label, memory) => {
    setMemory(memory)
    await expect(enqueueTurnMemory(INPUT)).resolves.toMatchObject({
      enqueued: false,
      reason: "disabled",
    })
    expect(mockGetSession).not.toHaveBeenCalled()
    expect(mockSchedule).not.toHaveBeenCalled()
  })

  it("declines when autoExtract is off", async () => {
    setMemory({ autoExtract: false })
    await expect(enqueueTurnMemory(INPUT)).resolves.toMatchObject({ reason: "learn_denied" })
  })

  it("honours the per-chat learning override", async () => {
    mockGetSession.mockResolvedValue({ id: "s1", characterId: "c1", memoryLearn: false })
    await expect(enqueueTurnMemory(INPUT)).resolves.toMatchObject({ reason: "learn_denied" })
    expect(mockSchedule).not.toHaveBeenCalled()
    expect(mockAppendAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "learn-denied", reason: "disabled_for_chat" })
    )
  })

  it("enforces the Agent automatic-learning policy", async () => {
    mockResolveCharacter.mockResolvedValue({
      id: "c1",
      memoryPolicy: {
        operations: { recall: true, create: true, update: true, forget: true },
        readableScopes: ["global"],
        writableScopes: ["global"],
        autoLearn: false,
      },
    })
    await expect(enqueueTurnMemory(INPUT)).resolves.toMatchObject({ reason: "learn_denied" })
    expect(mockAppendAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "learn-denied", reason: "agent_policy" })
    )
  })

  it("does not let an explicit chat opt in above the global learning ceiling", async () => {
    setMemory({ learnFromChats: false, autoExtract: false })
    mockGetSession.mockResolvedValue({ id: "s1", characterId: "c1", memoryLearn: true })
    await expect(enqueueTurnMemory(INPUT)).resolves.toMatchObject({ reason: "learn_denied" })
    expect(mockSchedule).not.toHaveBeenCalled()
  })

  it("blocks contaminated external context but permits local code tools", async () => {
    await expect(
      enqueueTurnMemory({ ...INPUT, externalContext: ["web-search"] })
    ).resolves.toMatchObject({ reason: "learn_denied" })
    expect(mockAppendAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "learn-denied", reason: "external_context" })
    )

    jest.clearAllMocks()
    setMemory({})
    mockEnqueueJob.mockResolvedValue({ id: "job-1" })
    mockGetSession.mockResolvedValue({ id: "s1", characterId: "c1" })
    await expect(
      enqueueTurnMemory({ ...INPUT, externalContext: ["local-tool"] })
    ).resolves.toMatchObject({ enqueued: true })
  })

  it("labels allowed external-context learning instead of treating it as clean", async () => {
    setMemory({ disableLearningOnExternalContext: false })
    await enqueueTurnMemory({ ...INPUT, externalContext: ["web-search"] })
    expect(mockSchedule).toHaveBeenCalledWith(
      expect.objectContaining({ contaminationState: "external-context" })
    )
  })
})

describe("enqueueTurnMemory project mining", () => {
  function miningDrafts() {
    return mockEnqueueJob.mock.calls
      .map(([draft]) => draft)
      .filter((draft) => draft.kind === "project-mining")
  }

  it("queues closed mining windows for a project-bound session", async () => {
    mockGetSession.mockResolvedValue({ id: "s1", projectId: "p1", transcriptRevision: 3 })
    await enqueueTurnMemory({ ...INPUT, transcript: PROJECT_TRANSCRIPT })

    const drafts = miningDrafts()
    expect(drafts.length).toBeGreaterThan(0)
    expect(drafts[0]).toMatchObject({
      kind: "project-mining",
      projectId: "p1",
      scope: "workspace",
      checkpoint: expect.objectContaining({ firstMessageId: "m0", transcriptRevision: 3 }),
    })
    // The still-growing tail is left for the idle flush, so a send does not
    // re-mine overlapping text every turn.
    expect(drafts.some((draft) => draft.checkpoint.lastMessageId === "m25")).toBe(false)
  })

  it("queues nothing for a session with no workspace", async () => {
    mockGetSession.mockResolvedValue({ id: "s1" })
    await enqueueTurnMemory({ ...INPUT, transcript: PROJECT_TRANSCRIPT })
    expect(miningDrafts()).toEqual([])
  })

  it("queues nothing when project mining is switched off", async () => {
    setMemory({ mineProjectContext: false })
    mockGetSession.mockResolvedValue({ id: "s1", projectId: "p1" })
    await enqueueTurnMemory({ ...INPUT, transcript: PROJECT_TRANSCRIPT })
    expect(miningDrafts()).toEqual([])
  })

  it("queues nothing from small talk, however long the conversation", async () => {
    mockGetSession.mockResolvedValue({ id: "s1", projectId: "p1" })
    await enqueueTurnMemory({
      ...INPUT,
      transcript: PROJECT_TRANSCRIPT.map((entry) => ({ ...entry, text: "sounds good, thanks" })),
    })
    expect(miningDrafts()).toEqual([])
  })
})
