jest.mock("@/lib/db/seed", () => ({ seedBuiltIns: jest.fn().mockResolvedValue(undefined) }))

import { createDbTestFixture } from "@/lib/db/test-fixture"
import { createWorkflowApp } from "@/lib/db/workflow-apps"
import { getDb } from "@/lib/db/schema"
import {
  requestWorkflowCustomDomainVerification,
  verifyWorkflowCustomDomain,
} from "./custom-domain-service"

const fixture = createDbTestFixture()

beforeAll(fixture.initialize)
beforeEach(async () => {
  await fixture.restore()
  await getDb().workflowApps.clear()
})
afterAll(fixture.dispose)

it("issues a DNS TXT challenge and freezes the verified domain into the draft", async () => {
  const app = await createWorkflowApp({
    accountId: "account-1",
    workflowId: "workflow-1",
    kind: "workflow",
    slug: "review",
    now: 1,
  })
  const requested = await requestWorkflowCustomDomainVerification({
    accountId: "account-1",
    appId: app.id,
    expectedRevision: 1,
    hostname: "Portal.Example.COM.",
    now: 2,
  })
  expect(requested.dnsName).toBe("_cognia.portal.example.com")
  expect(requested.dnsValue).toMatch(/^cognia-verification=[A-Za-z0-9_-]{20,128}$/)

  await expect(
    verifyWorkflowCustomDomain({
      accountId: "account-1",
      appId: app.id,
      expectedRevision: 2,
      now: 3,
      resolveTxt: async () => [requested.dnsValue],
    })
  ).resolves.toMatchObject({
    draft: {
      customDomain: {
        hostname: "portal.example.com",
        verificationStatus: "verified",
        verifiedAt: 3,
      },
    },
  })
})

it("does not mark a domain verified when the exact TXT proof is absent", async () => {
  const app = await createWorkflowApp({
    accountId: "account-1",
    workflowId: "workflow-1",
    kind: "workflow",
    slug: "review",
  })
  await requestWorkflowCustomDomainVerification({
    accountId: "account-1",
    appId: app.id,
    expectedRevision: 1,
    hostname: "portal.example.com",
  })
  await expect(
    verifyWorkflowCustomDomain({
      accountId: "account-1",
      appId: app.id,
      expectedRevision: 2,
      resolveTxt: async () => ["cognia-verification=wrong"],
    })
  ).rejects.toMatchObject({ code: "verification_failed" })
  expect((await getDb().workflowApps.get(app.id))?.draft.customDomain?.verificationStatus).toBe(
    "pending"
  )
})
