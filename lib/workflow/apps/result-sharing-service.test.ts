jest.mock("@/lib/db/workflow-apps", () => ({ resolvePublishedWorkflowApp: jest.fn() }))
jest.mock("@/lib/db/shared-links", () => ({ getSharedLinkByCode: jest.fn() }))
jest.mock("@/lib/share/client", () => ({
  ShareNotConfiguredError: class ShareNotConfiguredError extends Error {},
  SharePayloadTooLargeError: class SharePayloadTooLargeError extends Error {},
  ShareRequestError: class ShareRequestError extends Error {},
  createShareLink: jest.fn(),
  revokeShareLink: jest.fn(),
}))
jest.mock("./app-api-service", () => ({ getWorkflowAppRun: jest.fn() }))

import { getSharedLinkByCode } from "@/lib/db/shared-links"
import { resolvePublishedWorkflowApp } from "@/lib/db/workflow-apps"
import { createShareLink, revokeShareLink } from "@/lib/share/client"
import { getWorkflowAppRun } from "./app-api-service"
import { createWorkflowResultShare, revokeWorkflowResultShare } from "./result-sharing-service"
import { ShareNotConfiguredError } from "@/lib/share/client"

const actor = {
  authenticated: false,
  externalSubjectKey: "anonymous:one",
  legalConsentGranted: true,
}

const resolved = {
  app: { id: "app-1", slug: "review", kind: "workflow" },
  release: {
    id: "release-1",
    snapshot: {
      access: { mode: "anonymous", oidcGroupIds: [] },
      embed: { enabled: false, allowedOrigins: [] },
      legal: { requireConsent: false },
      localized: { en: { title: "Review" } },
      resultSharing: { enabled: true, defaultTtlSeconds: 3_600 },
    },
  },
}

beforeEach(() => {
  jest.resetAllMocks()
  jest.mocked(resolvePublishedWorkflowApp).mockResolvedValue(resolved as never)
  jest.mocked(getWorkflowAppRun).mockResolvedValue({ runId: "run-1", status: "succeeded" } as never)
  jest.mocked(createShareLink).mockResolvedValue({
    code: "share-1",
    url: "https://share.example/view#key",
    expiresAt: 4_600_000,
  })
})

it("creates an encrypted, expiring share only for an owned app run", async () => {
  await expect(
    createWorkflowResultShare({
      accountId: "account-1",
      appSlug: "review",
      runId: "run-1",
      actor,
    })
  ).resolves.toMatchObject({ code: "share-1" })
  expect(getWorkflowAppRun).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-1", actor }))
  expect(createShareLink).toHaveBeenCalledWith(
    expect.objectContaining({
      ttlSeconds: 3_600,
      ownerScope: expect.stringMatching(/^workflow-result:app-1:[0-9a-f]{64}$/),
      payload: expect.objectContaining({ kind: "workflow-result", encoding: "utf8" }),
    })
  )
})

it("rejects disabled or unbounded result sharing", async () => {
  jest.mocked(resolvePublishedWorkflowApp).mockResolvedValue({
    ...resolved,
    release: {
      ...resolved.release,
      snapshot: { ...resolved.release.snapshot, resultSharing: { enabled: false } },
    },
  } as never)
  await expect(
    createWorkflowResultShare({
      accountId: "account-1",
      appSlug: "review",
      runId: "run-1",
      actor,
    })
  ).rejects.toMatchObject({ code: "result_sharing_disabled" })

  jest.mocked(resolvePublishedWorkflowApp).mockResolvedValue(resolved as never)
  await expect(
    createWorkflowResultShare({
      accountId: "account-1",
      appSlug: "review",
      runId: "run-1",
      actor,
      ttlSeconds: 31 * 24 * 60 * 60,
    })
  ).rejects.toMatchObject({ code: "invalid_share_ttl" })
})

it("revokes only a result link owned by the same app subject", async () => {
  await createWorkflowResultShare({
    accountId: "account-1",
    appSlug: "review",
    runId: "run-1",
    actor,
  })
  const created = jest.mocked(createShareLink).mock.calls[0]![0]
  jest.mocked(getSharedLinkByCode).mockResolvedValue({
    code: "share-1",
    kind: "workflow-result",
    ownerScope: created.ownerScope,
  } as never)
  await revokeWorkflowResultShare({
    accountId: "account-1",
    appSlug: "review",
    code: "share-1",
    actor,
  })
  expect(revokeShareLink).toHaveBeenCalledWith("share-1")

  jest.mocked(getSharedLinkByCode).mockResolvedValue({
    code: "share-1",
    kind: "workflow-result",
    ownerScope: "workflow-result:other:subject",
  } as never)
  await expect(
    revokeWorkflowResultShare({
      accountId: "account-1",
      appSlug: "review",
      code: "share-1",
      actor,
    })
  ).rejects.toMatchObject({ code: "share_not_found" })
})

it("normalizes share infrastructure failures without leaking configuration", async () => {
  jest.mocked(createShareLink).mockRejectedValue(new ShareNotConfiguredError())
  await expect(
    createWorkflowResultShare({
      accountId: "account-1",
      appSlug: "review",
      runId: "run-1",
      actor,
    })
  ).rejects.toMatchObject({
    code: "share_service_unavailable",
    message: "The result sharing service is unavailable",
  })
})
