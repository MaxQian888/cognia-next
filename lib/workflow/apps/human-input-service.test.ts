jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({
    workflowRuns: {
      get: jest.fn(async () => ({ triggerPayload: { appId: "app_1", appReleaseId: "rel_1" } })),
    },
    workflowHumanInputSubmissions: {
      where: () => ({
        equals: () => ({
          count: jest.fn(async () => 0),
          toArray: jest.fn(async () => submissions),
        }),
      }),
    },
  }),
}))
const request = {
  id: "hir_1",
  accountId: "acct_1",
  status: "pending",
  runId: "run_1",
  workflowId: "wf_1",
  stepId: "ask",
  waitpointId: "hir_1",
  initiatorId: "anonymous:portal-1",
  title: "Review",
  fields: [{ id: "evidence", type: "file", label: "Evidence", accept: ["image/*"] }],
  actions: [{ id: "approve", label: "Approve" }],
  assignees: [{ kind: "initiator" }],
  completionPolicy: { mode: "any" },
  createdAt: 1,
  updatedAt: 1,
  expiresAt: 100,
}
const submitHumanInput = jest.fn()
jest.mock("@/lib/db/workflow-human-input", () => ({
  getHumanInputRequest: jest.fn(async () => request),
  listPendingHumanInputRequests: jest.fn(async () => [request]),
  isHumanInputAssigned: jest.fn((_request, actor) => actor.isInitiator === true),
  submitHumanInput: (...args: unknown[]) => submitHumanInput(...args),
}))
const promoteHumanInputFile = jest.fn(async () => ({ ref: "cognia-human-input-file:hif_1" }))
let submissions: Array<{ responderId: string }> = []
jest.mock("@/lib/db/workflow-human-input-files", () => ({
  promoteHumanInputFile: (...args: unknown[]) => promoteHumanInputFile(...args),
}))

import {
  listPortalHumanInputRequests,
  submitPortalHumanInput,
  uploadPortalHumanInputFile,
} from "./human-input-service"

const actor = { authenticated: false, externalSubjectKey: "anonymous:portal-1" }
const scope = { accountId: "acct_1", appId: "app_1", appReleaseId: "rel_1", actor }

beforeEach(() => {
  jest.clearAllMocks()
  submissions = []
})

it("lists only requests assigned to the signed app subject", async () => {
  await expect(listPortalHumanInputRequests(scope)).resolves.toMatchObject([
    { id: "hir_1", title: "Review", submittedCount: 0 },
  ])
  await expect(
    listPortalHumanInputRequests({
      ...scope,
      actor: { authenticated: false, externalSubjectKey: "anonymous:other" },
    })
  ).resolves.toEqual([])
})

it("does not re-offer a pending quorum request to a responder who already submitted", async () => {
  submissions = [{ responderId: "anonymous:portal-1" }]

  await expect(listPortalHumanInputRequests(scope)).resolves.toEqual([])
})

it("submits with the frozen initiator identity", async () => {
  submitHumanInput.mockResolvedValue({
    ok: true,
    completed: true,
    submission: { submittedAt: 10 },
  })
  await expect(
    submitPortalHumanInput({
      ...scope,
      requestId: "hir_1",
      actionId: "approve",
      values: { evidence: "cognia-human-input-file:hif_1" },
    })
  ).resolves.toEqual({ requestId: "hir_1", completed: true, submittedAt: 10 })
  expect(submitHumanInput).toHaveBeenCalledWith(
    expect.objectContaining({
      requestId: "hir_1",
      actor: { id: "anonymous:portal-1", isInitiator: true },
    })
  )
})

it("sniffs and promotes an allowed Portal file with bounded retention", async () => {
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  await expect(
    uploadPortalHumanInputFile({
      ...scope,
      requestId: "hir_1",
      fieldId: "evidence",
      name: "evidence.txt",
      declaredMediaType: "text/plain",
      bytes,
      now: 1_000,
    })
  ).resolves.toEqual({
    ref: "cognia-human-input-file:hif_1",
    name: "evidence.txt",
    mediaType: "image/png",
    size: bytes.byteLength,
  })
  expect(promoteHumanInputFile).toHaveBeenCalledWith(
    expect.objectContaining({
      responderId: "anonymous:portal-1",
      mediaType: "image/png",
      expiresAt: 1_000 + 30 * 24 * 60 * 60 * 1_000,
    })
  )
})
