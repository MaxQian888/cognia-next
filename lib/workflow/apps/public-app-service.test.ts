jest.mock("@/lib/accounts/active-account-id", () => ({ getActiveAccountId: () => "acct_a" }))
jest.mock("@/lib/db/workflow-apps", () => ({
  resolvePublishedWorkflowApp: jest.fn(),
  resolvePublishedWorkflowAppByDomain: jest.fn(),
  resolveWorkflowAppRelease: jest.fn(),
}))
jest.mock("./app-api-service", () => ({
  WorkflowAppApiError: class WorkflowAppApiError extends Error {
    code = "run_not_found"
  },
  admitWorkflowAppRun: jest.fn(),
  getWorkflowAppRun: jest.fn(),
  listWorkflowAppRunEvents: jest.fn(),
  cancelWorkflowAppRun: jest.fn(),
}))
jest.mock("./chatflow-service", () => ({
  WorkflowChatflowError: class WorkflowChatflowError extends Error {
    code = "conversation_not_found"
  },
  sendChatflowMessage: jest.fn(),
}))
jest.mock("../quality/quality-service", () => ({
  WorkflowQualityError: class WorkflowQualityError extends Error {
    code = "invalid_feedback"
  },
  submitWorkflowFeedback: jest.fn(),
}))
jest.mock("./batch-service", () => ({
  WorkflowBatchError: class WorkflowBatchError extends Error {
    code = "job_not_found"
  },
  authorizeWorkflowBatch: jest.fn(),
  cancelWorkflowBatch: jest.fn(),
  createWorkflowBatch: jest.fn(),
  exportWorkflowBatchCsv: jest.fn(),
  getWorkflowBatchPage: jest.fn(),
  getWorkflowBatchTemplate: jest.fn(),
  pauseWorkflowBatch: jest.fn(),
  resumeWorkflowBatch: jest.fn(),
  runWorkflowBatch: jest.fn(),
}))
jest.mock("./human-input-service", () => ({
  PortalHumanInputError: class PortalHumanInputError extends Error {
    code = "request_not_found"
    status = 404
  },
  listPortalHumanInputRequests: jest.fn(),
  submitPortalHumanInput: jest.fn(),
  uploadPortalHumanInputFile: jest.fn(),
}))
jest.mock("./result-sharing-service", () => ({
  WorkflowResultSharingError: class WorkflowResultSharingError extends Error {
    constructor(
      readonly code: string,
      message: string
    ) {
      super(message)
    }
  },
  createWorkflowResultShare: jest.fn(),
  revokeWorkflowResultShare: jest.fn(),
}))

import {
  resolvePublishedWorkflowApp,
  resolvePublishedWorkflowAppByDomain,
  resolveWorkflowAppRelease,
} from "@/lib/db/workflow-apps"
import { submitWorkflowFeedback } from "../quality/quality-service"
import { admitWorkflowAppRun, getWorkflowAppRun } from "./app-api-service"
import { sendChatflowMessage } from "./chatflow-service"
import { dispatchPublicWorkflowAppBridgeCommand } from "./public-app-service"
import {
  createWorkflowBatch,
  getWorkflowBatchPage,
  getWorkflowBatchTemplate,
  runWorkflowBatch,
} from "./batch-service"
import {
  listPortalHumanInputRequests,
  submitPortalHumanInput,
  uploadPortalHumanInputFile,
} from "./human-input-service"
import { WorkflowAppQuotaError } from "./quota-service"
import {
  createWorkflowResultShare,
  revokeWorkflowResultShare,
  WorkflowResultSharingError,
} from "./result-sharing-service"

const actor = { authenticated: false, externalSubjectKey: "anon_1", legalConsentGranted: true }
const resolved = {
  app: { id: "app_1", slug: "review", kind: "workflow" },
  release: {
    id: "rel_1",
    workflowInterface: { inputSchema: { type: "object" } },
    snapshot: {
      access: { mode: "anonymous" },
      embed: { enabled: true, allowedOrigins: ["https://embed.example"] },
      blocks: [{ id: "header", type: "header", showDescription: true }],
      localized: { en: { title: "Review" } },
      theme: { primaryColor: "#123456", logoRef: "javascript:alert(1)" },
      legal: { requireConsent: false },
      resultSharing: { enabled: true, defaultTtlSeconds: 3_600 },
    },
  },
}

beforeEach(() => {
  jest.clearAllMocks()
  jest.mocked(resolvePublishedWorkflowApp).mockResolvedValue(resolved as never)
  jest.mocked(resolveWorkflowAppRelease).mockResolvedValue(resolved as never)
})

it("returns only a safe anonymous bootstrap projection", async () => {
  await expect(
    dispatchPublicWorkflowAppBridgeCommand("workflow_app_bootstrap", {
      appSlug: "review",
      embedOrigin: "https://embed.example",
    })
  ).resolves.toEqual({
    ok: true,
    data: {
      session: { accountId: "acct_a", appId: "app_1", appSlug: "review", releaseId: "rel_1" },
      app: {
        slug: "review",
        kind: "workflow",
        releaseId: "rel_1",
        blocks: resolved.release.snapshot.blocks,
        localized: resolved.release.snapshot.localized,
        theme: { primaryColor: "#123456" },
        inputSchema: { type: "object" },
        legal: { requireConsent: false },
        resultSharing: { enabled: true, defaultTtlSeconds: 3_600 },
      },
    },
  })
})

it("creates and revokes an owner-scoped workflow result share", async () => {
  jest.mocked(createWorkflowResultShare).mockResolvedValue({
    code: "share_1",
    url: "https://share.example/view#key",
  })
  await expect(
    dispatchPublicWorkflowAppBridgeCommand("workflow_app_result_share_create", {
      accountId: "acct_a",
      appSlug: "review",
      actor,
      runId: "run_1",
      ttlSeconds: 3_600,
    })
  ).resolves.toMatchObject({ ok: true, data: { code: "share_1" } })
  expect(createWorkflowResultShare).toHaveBeenCalledWith({
    accountId: "acct_a",
    appSlug: "review",
    actor,
    runId: "run_1",
    ttlSeconds: 3_600,
  })

  await expect(
    dispatchPublicWorkflowAppBridgeCommand("workflow_app_result_share_revoke", {
      accountId: "acct_a",
      appSlug: "review",
      actor,
      code: "share_1",
    })
  ).resolves.toEqual({ ok: true, data: { revoked: true } })
  expect(revokeWorkflowResultShare).toHaveBeenCalledWith({
    accountId: "acct_a",
    appSlug: "review",
    actor,
    code: "share_1",
  })

  jest
    .mocked(createWorkflowResultShare)
    .mockRejectedValue(
      new WorkflowResultSharingError("share_service_unavailable", "Sharing is unavailable")
    )
  await expect(
    dispatchPublicWorkflowAppBridgeCommand("workflow_app_result_share_create", {
      accountId: "acct_a",
      appSlug: "review",
      actor,
      runId: "run_1",
    })
  ).resolves.toMatchObject({
    ok: false,
    error: { code: "share_service_unavailable", status: 503 },
  })
})

it("does not expose private or OIDC manifests to anonymous callers", async () => {
  jest.mocked(resolvePublishedWorkflowApp).mockResolvedValue({
    ...resolved,
    release: {
      ...resolved.release,
      snapshot: { ...resolved.release.snapshot, access: { mode: "oidc" } },
    },
  } as never)
  await expect(
    dispatchPublicWorkflowAppBridgeCommand("workflow_app_bootstrap", { appSlug: "review" })
  ).resolves.toMatchObject({
    ok: false,
    error: { code: "authentication_required", status: 401 },
  })
})

it("resolves only a verified frozen custom domain to its application slug", async () => {
  jest.mocked(resolvePublishedWorkflowAppByDomain).mockResolvedValue(resolved as never)
  await expect(
    dispatchPublicWorkflowAppBridgeCommand("workflow_app_domain_resolve", {
      hostname: "PORTAL.EXAMPLE.COM",
    })
  ).resolves.toEqual({ ok: true, data: { appSlug: "review" } })
  expect(resolvePublishedWorkflowAppByDomain).toHaveBeenCalledWith("acct_a", "portal.example.com")

  jest.mocked(resolvePublishedWorkflowAppByDomain).mockResolvedValue(undefined)
  await expect(
    dispatchPublicWorkflowAppBridgeCommand("workflow_app_domain_resolve", {
      hostname: "unknown.example.com",
    })
  ).resolves.toMatchObject({ ok: false, error: { code: "app_not_found", status: 404 } })
})

it("bootstraps an OIDC app only for a verified allowed group", async () => {
  jest.mocked(resolvePublishedWorkflowApp).mockResolvedValue({
    ...resolved,
    release: {
      ...resolved.release,
      snapshot: {
        ...resolved.release.snapshot,
        access: { mode: "oidc", oidcGroupIds: ["release-managers"] },
      },
    },
  } as never)
  const payload = {
    appSlug: "review",
    actor: {
      authenticated: true,
      subjectId: "user-1",
      groupIds: ["release-managers"],
      externalSubjectKey: "oidc:user-1",
    },
  }

  await expect(
    dispatchPublicWorkflowAppBridgeCommand("workflow_app_bootstrap", payload)
  ).resolves.toMatchObject({ ok: true, data: { session: { appSlug: "review" } } })

  await expect(
    dispatchPublicWorkflowAppBridgeCommand("workflow_app_bootstrap", {
      ...payload,
      actor: { ...payload.actor, groupIds: ["engineering"] },
    })
  ).resolves.toMatchObject({ ok: false, error: { code: "group_denied", status: 403 } })
})

it("runs the current immutable release through the shared app authority", async () => {
  jest.mocked(admitWorkflowAppRun).mockResolvedValue({
    runId: "run_1",
    releaseId: "rel_1",
    completion: Promise.resolve({ runId: "run_1" }),
  } as never)
  jest.mocked(getWorkflowAppRun).mockResolvedValue({ runId: "run_1", status: "succeeded" } as never)
  await expect(
    dispatchPublicWorkflowAppBridgeCommand("workflow_app_run_create", {
      accountId: "acct_a",
      appSlug: "review",
      actor,
      idempotencyKey: "idem_1",
      input: { topic: "security" },
      responseMode: "blocking",
    })
  ).resolves.toMatchObject({ ok: true, data: { runId: "run_1", status: "succeeded" } })
  expect(admitWorkflowAppRun).toHaveBeenCalledWith(
    expect.objectContaining({
      accountId: "acct_a",
      appSlug: "review",
      actor,
      idempotencyKey: "idem_1",
    })
  )
})

it("returns a stable 429 application error when atomic admission exhausts quota", async () => {
  jest
    .mocked(admitWorkflowAppRun)
    .mockRejectedValue(
      new WorkflowAppQuotaError("concurrency_exhausted", "Application capacity is exhausted", 1)
    )

  await expect(
    dispatchPublicWorkflowAppBridgeCommand("workflow_app_run_create", {
      accountId: "acct_a",
      appSlug: "review",
      actor,
      idempotencyKey: "idem_quota",
      input: {},
    })
  ).resolves.toEqual({
    ok: false,
    error: {
      code: "concurrency_exhausted",
      status: 429,
      message: "Application capacity is exhausted",
    },
  })
})

it("creates, starts, and pages an owner-scoped fixed-release CSV batch", async () => {
  jest.mocked(getWorkflowBatchTemplate).mockResolvedValue("topic\r\n")
  await expect(
    dispatchPublicWorkflowAppBridgeCommand("workflow_app_batch_template", {
      accountId: "acct_a",
      appSlug: "review",
      actor,
    })
  ).resolves.toEqual({ ok: true, data: "topic\r\n" })

  jest.mocked(createWorkflowBatch).mockResolvedValue({
    id: "batch_1",
    status: "queued",
  } as never)
  jest.mocked(runWorkflowBatch).mockResolvedValue({ id: "batch_1", status: "running" } as never)
  await expect(
    dispatchPublicWorkflowAppBridgeCommand("workflow_app_batch_create", {
      accountId: "acct_a",
      appSlug: "review",
      actor,
      csv: "topic\r\nRelease",
      concurrency: 4,
      deadlineMs: 60_000,
      idempotencyKey: "batch-request-1",
    })
  ).resolves.toMatchObject({ ok: true, data: { id: "batch_1", status: "queued" } })
  expect(createWorkflowBatch).toHaveBeenCalledWith({
    accountId: "acct_a",
    appSlug: "review",
    actor,
    csv: "topic\r\nRelease",
    concurrency: 4,
    deadlineMs: 60_000,
    idempotencyKey: "batch-request-1",
  })
  expect(runWorkflowBatch).toHaveBeenCalledWith("acct_a", "batch_1")

  jest.mocked(getWorkflowBatchPage).mockResolvedValue({
    job: { id: "batch_1" },
    rows: [],
  } as never)
  await dispatchPublicWorkflowAppBridgeCommand("workflow_app_batch_get", {
    accountId: "acct_a",
    appSlug: "review",
    actor,
    jobId: "batch_1",
    afterRowNumber: 10,
    limit: 50,
  })
  expect(getWorkflowBatchPage).toHaveBeenCalledWith({
    accountId: "acct_a",
    appSlug: "review",
    actor,
    jobId: "batch_1",
    afterRowNumber: 10,
    limit: 50,
  })
})

it("lists, submits, and uploads files for Portal Human Input through the signed release", async () => {
  jest.mocked(listPortalHumanInputRequests).mockResolvedValue([{ id: "hir_1" }] as never)
  await dispatchPublicWorkflowAppBridgeCommand("workflow_app_human_input_list", {
    accountId: "acct_a",
    appId: "app_1",
    appReleaseId: "rel_1",
    appSlug: "review",
    actor,
  })
  expect(listPortalHumanInputRequests).toHaveBeenCalledWith({
    accountId: "acct_a",
    appId: "app_1",
    appReleaseId: "rel_1",
    appSlug: "review",
    actor,
  })

  jest.mocked(submitPortalHumanInput).mockResolvedValue({ completed: true } as never)
  await dispatchPublicWorkflowAppBridgeCommand("workflow_app_human_input_submit", {
    accountId: "acct_a",
    appId: "app_1",
    appReleaseId: "rel_1",
    appSlug: "review",
    actor,
    requestId: "hir_1",
    actionId: "approve",
    values: { note: "Ready" },
  })
  expect(submitPortalHumanInput).toHaveBeenCalledWith(
    expect.objectContaining({ requestId: "hir_1", actionId: "approve", values: { note: "Ready" } })
  )

  jest.mocked(uploadPortalHumanInputFile).mockResolvedValue({ ref: "hif_1" } as never)
  await dispatchPublicWorkflowAppBridgeCommand("workflow_app_human_input_file_upload", {
    accountId: "acct_a",
    appId: "app_1",
    appReleaseId: "rel_1",
    appSlug: "review",
    actor,
    requestId: "hir_1",
    fieldId: "evidence",
    name: "evidence.png",
    mediaType: "image/png",
    dataBase64: btoa("PNG"),
  })
  expect(uploadPortalHumanInputFile).toHaveBeenCalledWith(
    expect.objectContaining({
      requestId: "hir_1",
      fieldId: "evidence",
      bytes: new Uint8Array([80, 78, 71]),
    })
  )
})

it("returns Chatflow answers and revision for optimistic continuation", async () => {
  jest.mocked(sendChatflowMessage).mockResolvedValue({
    conversation: { id: "conv_1", revision: 2 },
    runId: "run_2",
    answer: { text: "Done", citations: [], files: [], suggestions: [] },
    reused: false,
  } as never)
  await expect(
    dispatchPublicWorkflowAppBridgeCommand("workflow_app_chat_message", {
      accountId: "acct_a",
      appSlug: "review",
      actor,
      idempotencyKey: "idem_2",
      query: "Hello",
    })
  ).resolves.toMatchObject({
    ok: true,
    data: { conversationId: "conv_1", conversationRevision: 2, answer: { text: "Done" } },
  })
})

it("accepts feedback only against the signed app release and stores no plaintext response", async () => {
  jest.mocked(submitWorkflowFeedback).mockResolvedValue({
    id: "feedback_1",
    status: "candidate",
  } as never)
  await expect(
    dispatchPublicWorkflowAppBridgeCommand("workflow_app_feedback_submit", {
      accountId: "acct_a",
      appId: "app_1",
      appReleaseId: "rel_1",
      appSlug: "review",
      actor,
      rating: "dislike",
      input: "Question",
      output: "Wrong answer",
      correction: "Reviewed answer",
      tags: ["quality"],
      runId: "run_1",
    })
  ).resolves.toEqual({ ok: true, data: { id: "feedback_1", status: "candidate" } })
  expect(resolveWorkflowAppRelease).toHaveBeenCalledWith("acct_a", "app_1", "rel_1")
  expect(submitWorkflowFeedback).toHaveBeenCalledWith(
    expect.objectContaining({
      accountId: "acct_a",
      appId: "app_1",
      appReleaseId: "rel_1",
      externalSubjectKey: "anon_1",
      rating: "dislike",
      payload: {
        input: "Question",
        output: "Wrong answer",
        correction: "Reviewed answer",
        tags: ["quality"],
      },
    })
  )
})
