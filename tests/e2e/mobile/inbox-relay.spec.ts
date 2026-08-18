/**
 * E2E: cross-shell inbox relay (ADR-0131).
 *
 * The sibling `connector-draft-approval.spec.ts` proves a phone's approval
 * reaches the desktop command boundary at all. This suite proves the two
 * things ADR-0131 changed about that boundary:
 *
 *  1. the approval now carries the SEGMENTS the operator approved, so the
 *     host sends what was on screen rather than re-reading the draft; and
 *  2. a shell that can neither run connectors nor relay to a host says so,
 *     instead of rendering an empty conversation list with inert controls.
 */

import { expect, test, type Page } from "@/tests/e2e/fixtures/test"
import { bootstrapCogniaMobile, readDexieRows } from "../helpers/db-reset"
import { injectCapacitor } from "../helpers/inject-capacitor"
import { companionConfigSecureStorage, provisionMockCompanionConfig } from "./companion-fixture"

interface QueueRowView {
  command: string
  payload: { draftId?: string; segments?: Array<{ type: string; text?: string }> }
  status: string
  attempts: number
  idempotencyKey: string
  lastError?: string
}

function mockV2BaseUrl(): string {
  const baseUrl = process.env.E2E_V2_BASE_URL
  if (!baseUrl) {
    throw new Error("E2E_V2_BASE_URL not published — global-setup didn't boot the mock V2 server")
  }
  return baseUrl
}

/** Seed one pending draft directly into whichever Cognia database is live. */
async function seedConnectorDraft(
  page: Page,
  draft: { adapterId: string; conversationKey: string; content: string }
): Promise<string> {
  const id = `cdr_relay_${crypto.randomUUID()}`
  const row = {
    id,
    conversationKey: draft.conversationKey,
    sessionId: "sess_relay_e2e",
    segments: [{ type: "text", text: draft.content }],
    status: "pending",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  const writes = await page.evaluate(async (seed) => {
    let count = 0
    for (const info of await indexedDB.databases()) {
      if (!info.name?.startsWith("cognia-")) continue
      count += await new Promise<number>((resolve, reject) => {
        const req = indexedDB.open(info.name!)
        req.onerror = () => reject(req.error)
        req.onsuccess = () => {
          const db = req.result
          if (!db.objectStoreNames.contains("connectorDrafts")) {
            db.close()
            resolve(0)
            return
          }
          const tx = db.transaction("connectorDrafts", "readwrite")
          tx.objectStore("connectorDrafts").put(seed)
          tx.oncomplete = () => {
            db.close()
            resolve(1)
          }
          tx.onerror = () => reject(tx.error)
        }
      })
    }
    return count
  }, row)
  expect(writes, "draft should be seeded into an active Cognia database").toBeGreaterThan(0)
  return id
}

async function restoreNetwork(page: Page): Promise<void> {
  await page.evaluate(() => {
    ;(
      window as unknown as {
        __cogniaCapMock: {
          setNetwork: (network: { connected: boolean; connectionType: string }) => void
        }
      }
    ).__cogniaCapMock.setNetwork({ connected: true, connectionType: "wifi" })
  })
}

async function waitForOutboundRunner(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      (window as unknown as { __cogniaCapMock: { getNetworkListenerCount: () => number } })
        .__cogniaCapMock.getNetworkListenerCount() > 0
  )
}

async function openDrafts(page: Page): Promise<void> {
  await page.getByTestId("mobile-inbox-trigger").click()
  await expect(page.getByTestId("mobile-inbox-body")).toBeVisible()
  await page.getByTestId("mobile-inbox-tab-drafts").click()
  await expect(page.getByTestId("draft-approval-panel")).toBeVisible()
}

test.describe("mobile — inbox relay", () => {
  test.beforeEach(async ({ page }) => {
    const companionConfig = await provisionMockCompanionConfig(
      mockV2BaseUrl(),
      "e2e-inbox-relay-device"
    )
    await injectCapacitor(page, {
      platform: "android",
      network: { connected: false, connectionType: "none" },
      secureStorage: companionConfigSecureStorage(companionConfig),
    })
    await page.goto("/onboarding")
    await bootstrapCogniaMobile(page, "paired")
    await expect(page.getByTestId("mobile-inbox-trigger")).toBeVisible({ timeout: 15_000 })
  })

  test("an approval carries the approved segments and one stable idempotency key", async ({
    page,
  }) => {
    const content = "Ship it — relayed from the phone"
    const draftId = await seedConnectorDraft(page, {
      adapterId: "adapter-relay",
      conversationKey: "lark:adapter-relay:chat-relay",
      content,
    })

    // Fail the first RPC so the retry path is exercised: a relayed write must
    // replay under the SAME key, or the host would send twice.
    const rpcUrl = `${mockV2BaseUrl()}/api/_rpc/connector_approve_draft`
    const idempotencyKeys: string[] = []
    let attempts = 0
    await page.route(rpcUrl, async (route) => {
      attempts += 1
      idempotencyKeys.push(route.request().headers()["idempotency-key"] ?? "")
      if (attempts === 1) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ message: "transient E2E failure" }),
        })
        return
      }
      await route.continue()
    })

    await openDrafts(page)
    await expect(page.getByText(content)).toBeVisible({ timeout: 15_000 })
    await waitForOutboundRunner(page)
    await page.getByTestId(`draft-approve-${draftId}`).click()
    await expect(page.getByText(content)).toBeHidden()

    // The queue row is the relay's unit of durability. ADR-0131 added
    // `segments`, so the host delivers what the operator approved rather than
    // re-reading the draft it may no longer agree with.
    const findQueueRow = async (): Promise<QueueRowView | undefined> => {
      const rows = await readDexieRows<QueueRowView>(page, { table: "mobileOutboundQueue" })
      return rows.find(
        (candidate) =>
          candidate.command === "connector_approve_draft" && candidate.payload.draftId === draftId
      )
    }

    await expect
      .poll(async () => (await findQueueRow()) !== undefined, { timeout: 15_000 })
      .toBe(true)
    const queued = (await findQueueRow())!

    expect(queued.payload.segments).toEqual([{ type: "text", text: content }])
    // Derived from the draft id, so even a client that lost its queue row
    // cannot produce a second outbound job for this draft.
    expect(queued.idempotencyKey).toBe(`cdr-approve:${draftId}`)

    await restoreNetwork(page)

    await expect.poll(() => attempts, { timeout: 15_000 }).toBe(2)
    expect(idempotencyKeys[0]).toBe(`cdr-approve:${draftId}`)
    expect(idempotencyKeys[1]).toBe(idempotencyKeys[0])

    const response = await fetch(`${mockV2BaseUrl()}/__control/rpc-calls`)
    expect(response.ok).toBe(true)
    const calls = (await response.json()) as Array<{ command: string; body: unknown }>
    expect(calls).toContainEqual(
      expect.objectContaining({
        command: "connector_approve_draft",
        body: expect.objectContaining({
          draftId,
          segments: [{ type: "text", text: content }],
        }),
      })
    )
  })
})

test.describe("web — inbox without a host", () => {
  test("explains that the Inbox needs a paired host instead of showing an empty list", async ({
    page,
  }) => {
    // No Capacitor, no companion config: a plain browser tab. It can render
    // the Inbox's local mirror but can never write to it, because no adapter
    // runs in a browser. Before ADR-0131 this looked like "you have no
    // conversations" with reply controls that silently did nothing.
    //
    // `bootstrapCogniaMobile(page, "standalone")` only gets us past account
    // creation and the first-run flow — it deliberately does NOT pair, which
    // is exactly the shell under test.
    await page.goto("/onboarding")
    await bootstrapCogniaMobile(page, "standalone", {
      // Dismiss first-run so `/inbox` renders; the gate would otherwise hold
      // every route at the welcome step and we would assert against that.
      onboardingDismissedAt: "2026-08-07T00:00:00.000Z",
    })
    await page.goto("/inbox")

    await expect(page.getByTestId("inbox-requires-host")).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId("state-card-requires-host")).toBeVisible()
    await expect(page.getByTestId("inbox-conversation-list-pane")).toHaveCount(0)
    await expect(page.getByTestId("inbox-detail-pane")).toHaveCount(0)
  })
})
