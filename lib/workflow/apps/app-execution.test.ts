jest.mock("@/lib/workflow/runtime/execution-authority", () => ({
  executeDeployedWorkflow: jest.fn(),
}))
jest.mock("./quota-service", () => ({
  assertWorkflowAppAdmissionQuota: jest.fn(async () => undefined),
  WorkflowAppQuotaError: class WorkflowAppQuotaError extends Error {
    constructor(readonly code: string) {
      super(code)
    }
  },
}))
jest.mock("./alert-service", () => ({ emitWorkflowAppQuotaAlert: jest.fn() }))

import { executeDeployedWorkflow } from "@/lib/workflow/runtime/execution-authority"
import { emitWorkflowAppQuotaAlert } from "./alert-service"
import { assertWorkflowAppAdmissionQuota, WorkflowAppQuotaError } from "./quota-service"
import type { ResolvedWorkflowAppRelease } from "@/types/workflow/app"
import {
  authorizeWorkflowAppRequest,
  executePublishedWorkflowApp,
  WorkflowAppAccessError,
} from "./app-execution"

const execute = executeDeployedWorkflow as jest.MockedFunction<typeof executeDeployedWorkflow>
const assertQuota = assertWorkflowAppAdmissionQuota as jest.MockedFunction<
  typeof assertWorkflowAppAdmissionQuota
>
const emitQuotaAlert = emitWorkflowAppQuotaAlert as jest.MockedFunction<
  typeof emitWorkflowAppQuotaAlert
>

const resolved = {
  app: {
    id: "wfa_1",
    accountId: "account_1",
    workflowId: "wf_1",
    kind: "workflow",
    slug: "review",
    draft: {} as never,
    draftRevision: 1,
    currentReleaseId: "wfar_1",
    publicationRevision: 1,
    createdAt: 1,
    updatedAt: 1,
  },
  release: {
    id: "wfar_1",
    appId: "wfa_1",
    accountId: "account_1",
    workflowId: "wf_1",
    appKind: "workflow",
    sequence: 1,
    appDraftRevision: 1,
    versionId: "wfv_1",
    versionDigest: "wfv1:abc",
    deploymentId: "wfd_1",
    deploymentRevision: 4,
    workflowInterface: {},
    dependencyLock: { workflows: {}, indexes: {} },
    snapshot: {
      blocks: [],
      theme: { colorMode: "system", primaryColor: "#000000" },
      localized: {},
      access: { mode: "private", oidcGroupIds: [] },
      embed: { enabled: false, allowedOrigins: [] },
      resultSharing: { enabled: false },
      mcp: { enabled: false },
      quota: {},
      contentPolicy: { inputModeration: true, outputModeration: true },
      legal: { requireConsent: false },
      knowledgeBindings: {},
    },
    createdAt: 1,
  },
  version: { id: "wfv_1" } as never,
  binding: {
    versionId: "wfv_1",
    deploymentId: "wfd_1",
    deploymentRevision: 4,
    entrypoint: "portal",
    caller: "anonymous",
    dependencyLock: { workflows: {}, indexes: {} },
  },
} satisfies ResolvedWorkflowAppRelease

beforeEach(() => {
  jest.clearAllMocks()
  execute.mockResolvedValue({ runId: "run_1" } as never)
})

describe("workflow app execution boundary", () => {
  it("keeps private apps private and enforces configured OIDC groups", () => {
    expect(() =>
      authorizeWorkflowAppRequest(resolved.release, {
        authenticated: false,
        externalSubjectKey: "anon-1",
      })
    ).toThrow(WorkflowAppAccessError)

    const oidc = {
      ...resolved.release,
      snapshot: {
        ...resolved.release.snapshot,
        access: { mode: "oidc" as const, oidcGroupIds: ["release-managers"] },
      },
    }
    expect(() =>
      authorizeWorkflowAppRequest(oidc, {
        authenticated: true,
        subjectId: "alice",
        groupIds: ["engineering"],
        externalSubjectKey: "alice",
      })
    ).toThrow(WorkflowAppAccessError)
    expect(
      authorizeWorkflowAppRequest(oidc, {
        authenticated: true,
        subjectId: "alice",
        groupIds: ["release-managers"],
        externalSubjectKey: "alice",
      })
    ).toEqual({ caller: "member:alice" })
  })

  it("keeps service credentials distinct from OIDC members", () => {
    expect(
      authorizeWorkflowAppRequest(resolved.release, {
        authenticated: false,
        externalSubjectKey: "api-key:key-1",
        serviceCredentialId: "key-1",
      })
    ).toEqual({ caller: "service:key-1" })
  })

  it("binds embed access to an enabled exact origin", () => {
    const anonymous = {
      ...resolved.release,
      snapshot: {
        ...resolved.release.snapshot,
        access: { mode: "anonymous" as const, oidcGroupIds: [] },
        embed: { enabled: true, allowedOrigins: ["https://portal.example"] },
      },
    }
    expect(() =>
      authorizeWorkflowAppRequest(anonymous, {
        authenticated: false,
        externalSubjectKey: "anon-1",
        embedOrigin: "https://evil.example",
      })
    ).toThrow(WorkflowAppAccessError)
    expect(
      authorizeWorkflowAppRequest(anonymous, {
        authenticated: false,
        externalSubjectKey: "anon-1",
        embedOrigin: "https://portal.example",
      })
    ).toEqual({ caller: "external:anon-1" })
  })

  it("executes the exact immutable release binding through ExecutionAuthority", async () => {
    const anonymous = {
      ...resolved,
      release: {
        ...resolved.release,
        snapshot: {
          ...resolved.release.snapshot,
          access: { mode: "anonymous" as const, oidcGroupIds: [] },
        },
      },
    }
    await executePublishedWorkflowApp({
      resolved: anonymous,
      actor: { authenticated: false, externalSubjectKey: "visitor-7" },
      idempotencyKey: "request-1",
      input: { topic: "release" },
    })

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowId: "wf_1",
        entrypoint: "portal",
        caller: "app:wfa_1:release:wfar_1:external:visitor-7",
        idempotencyKey: "request-1",
        payload: { input: { topic: "release" }, appId: "wfa_1", appReleaseId: "wfar_1" },
        lockedDependency: {
          workflowId: "wf_1",
          versionId: "wfv_1",
          deploymentId: "wfd_1",
          deploymentRevision: 4,
          dependencyLock: { workflows: {}, indexes: {} },
        },
      })
    )
    const admissionCheck = execute.mock.calls[0]?.[0].admissionCheck
    await admissionCheck?.({ accountId: "account_1", now: 123 })
    expect(assertQuota).toHaveBeenCalledWith({
      appId: "wfa_1",
      accountId: "account_1",
      release: anonymous.release,
      now: 123,
    })
  })

  it("alerts after an atomic budget admission rejection and preserves the quota error", async () => {
    const quotaError = new WorkflowAppQuotaError("token_budget_exhausted" as never)
    execute.mockRejectedValueOnce(quotaError)
    emitQuotaAlert.mockResolvedValueOnce({
      emitted: true,
      notificationDelivered: true,
      webhookDelivered: true,
    })

    await expect(
      executePublishedWorkflowApp({
        resolved,
        actor: {
          authenticated: true,
          subjectId: "alice",
          externalSubjectKey: "alice",
        },
        input: {},
      })
    ).rejects.toBe(quotaError)
    expect(emitQuotaAlert).toHaveBeenCalledWith({
      app: resolved.app,
      release: resolved.release,
      error: quotaError,
    })
  })
})
