import { prepareBestOfNChat, startPreparedBestOfN } from "./entry"
import { getSession } from "@/lib/db/sessions"
import { commitMessageDelta } from "@/lib/db/messages"
import { startBestOfN } from "./service"
import { canManageBestOfNRuns, projectBestOfNGroup } from "./projection"
import { readReviewPolicyAtRef } from "@/lib/scm/review/review-policy"

const mockScm = {
  status: jest.fn(),
  history: jest.fn(),
  branches: jest.fn(),
  readFileAt: jest.fn(),
}
const mockAppend = jest.fn()
jest.mock("@/lib/db/sessions", () => ({ getSession: jest.fn() }))
jest.mock("@/lib/db/messages", () => ({ commitMessageDelta: jest.fn() }))
jest.mock("@/hooks/chat/use-effective-cwd", () => ({
  resolveEffectiveCwdForSession: async () => "/repo",
}))
jest.mock("@/lib/scm/service", () => ({ getSourceControlService: () => mockScm }))
jest.mock("@/lib/scm/review/review-policy", () => ({ readReviewPolicyAtRef: jest.fn() }))
jest.mock("@/stores/chat/chat-store", () => ({
  useChatStore: { getState: () => ({ appendMessageToSession: mockAppend }) },
}))
jest.mock("@/lib/i18n/runtime-translator", () => ({
  getRuntimeTranslator: async () => (key: string) => key,
}))
jest.mock("./service", () => ({ startBestOfN: jest.fn() }))
jest.mock("./projection", () => ({
  canManageBestOfNRuns: jest.fn(() => true),
  projectBestOfNGroup: jest.fn(),
}))

beforeEach(() => {
  jest.clearAllMocks()
  jest.mocked(canManageBestOfNRuns).mockReturnValue(true)
  jest.mocked(getSession).mockResolvedValue({
    id: "s",
    characterId: "agent",
    kind: "direct",
    model: "model",
  } as never)
  mockScm.status.mockResolvedValue({ staged: [{}], changes: [], merge: [] })
  mockScm.history.mockResolvedValue([{ hash: "a".repeat(40) }])
  mockScm.branches.mockResolvedValue([
    { name: "main", isRemote: false },
    { name: "origin/main", isRemote: true },
  ])
  jest
    .mocked(readReviewPolicyAtRef)
    .mockResolvedValue({ ok: true, policy: { requiredChecks: ["unit"] }, declared: true } as never)
})
it("previews committed SHA, dirty exclusion and explicit local targets without starting", async () => {
  const prepared = await prepareBestOfNChat("s", "fix this", 3)
  expect(prepared).toMatchObject({
    baseSha: "a".repeat(40),
    dirty: true,
    n: 3,
    branches: ["main"],
    requiredChecks: ["unit"],
  })
  expect(prepared.targetRef).toBe(`best-of-n/${prepared.requestId}`)
  expect(startBestOfN).not.toHaveBeenCalled()
})
it("fails closed on a malformed policy or missing committed base", async () => {
  jest.mocked(readReviewPolicyAtRef).mockResolvedValue({ ok: false, problems: [] })
  await expect(prepareBestOfNChat("s", "fix", 2)).rejects.toThrow("invalidPolicy")
  mockScm.history.mockResolvedValue([])
  await expect(prepareBestOfNChat("s", "fix", 2)).rejects.toThrow("needsCommit")
  expect(startBestOfN).not.toHaveBeenCalled()
})
it("calls the single service once, persists one parent pair, and binds the projection", async () => {
  const prepared = await prepareBestOfNChat("s", "fix", 4)
  const group = {
    groupId: "g",
    baseSha: prepared.baseSha,
    targetRef: prepared.targetRef,
    checkoutHadUncommittedChanges: true,
  }
  jest
    .mocked(startBestOfN)
    .mockResolvedValue({ group, completion: Promise.resolve(group) } as never)
  await startPreparedBestOfN(prepared, { targetRef: prepared.targetRef, targetIsNew: true })
  expect(startBestOfN).toHaveBeenCalledTimes(1)
  expect(startBestOfN).toHaveBeenCalledWith(
    expect.objectContaining({
      requestId: prepared.requestId,
      baseRef: prepared.baseSha,
      requiredChecks: ["unit"],
      candidates: Array.from({ length: 4 }, () => ({ agentId: "agent", model: "model" })),
    })
  )
  expect(commitMessageDelta).toHaveBeenCalledWith("s", {
    upserts: [
      expect.objectContaining({ role: "user" }),
      expect.objectContaining({
        id: prepared.requestId,
        role: "assistant",
        metadata: { bestOfN: { groupId: "g", sessionId: "s" } },
      }),
    ],
  })
  expect(mockAppend).toHaveBeenCalledTimes(2)
  expect(projectBestOfNGroup).toHaveBeenCalledWith(
    group,
    expect.objectContaining({ parentMessageId: prepared.requestId, parentSessionId: "s" })
  )
})

it("refuses starts from paired observers before accessing the Host", async () => {
  const prepared = await prepareBestOfNChat("s", "fix", 2)
  jest.mocked(canManageBestOfNRuns).mockReturnValue(false)
  await expect(prepareBestOfNChat("s", "fix", 2)).rejects.toThrow("unavailable")
  await expect(
    startPreparedBestOfN(prepared, { targetRef: "main", targetIsNew: false })
  ).rejects.toThrow("unavailable")
  expect(startBestOfN).not.toHaveBeenCalled()
})
