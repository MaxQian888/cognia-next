/**
 * E2E: connector draft approval — prove UI intent reaches the paired desktop
 * command boundary, including transport retry, instead of only disappearing
 * from the local list.
 */

import { expect, test, type Page } from "@/tests/e2e/fixtures/test"
import { bootstrapCogniaMobile, readDexieRow, readDexieRows } from "../helpers/db-reset"
import { injectCapacitor } from "../helpers/inject-capacitor"

interface DraftRowView {
  status: string
}

interface QueueRowView {
  command: string
  payload: { draftId?: string }
  status: string
  attempts: number
  lastError?: string
}

function mockV2BaseUrl(): string {
  const baseUrl = process.env.E2E_V2_BASE_URL
  if (!baseUrl) {
    throw new Error("E2E_V2_BASE_URL not published — global-setup didn't boot the mock V2 server")
  }
  return baseUrl
}

async function seedConnectorDraft(
  page: Page,
  draft: { adapterId: string; conversationKey: string; content: string }
): Promise<string> {
  const id = `cdr_e2e_${crypto.randomUUID()}`
  const [platform, , chatId] = draft.conversationKey.split(":")
  const row = {
    id,
    conversationKey: draft.conversationKey,
    sessionId: "sess_e2e",
    segments: [{ type: "text", text: draft.content }],
    status: "pending",
    createdAt: Date.now(),
    outboundPreview: {
      conversationRef: { platform, adapterId: draft.adapterId, chatId },
      segments: [{ type: "text", text: draft.content }],
      metadata: { idempotencyKey: `idem_${id}` },
    },
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
  expect(writes, "connector draft should be seeded into an active Cognia database").toBeGreaterThan(
    0
  )
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
      (
        window as unknown as {
          __cogniaCapMock: { getNetworkListenerCount: () => number }
        }
      ).__cogniaCapMock.getNetworkListenerCount() > 0
  )
}

async function openDraftsWithoutReload(page: Page): Promise<void> {
  await page.getByTestId("mobile-inbox-trigger").click()
  await expect(page.getByTestId("mobile-inbox-body")).toBeVisible()
  await page.getByTestId("mobile-inbox-tab-drafts").click()
  await expect(page.getByTestId("draft-approval-panel")).toBeVisible()
}

test.describe("mobile — connector draft approval", () => {
  test.beforeEach(async ({ page }) => {
    const companionConfig = {
      baseUrl: mockV2BaseUrl(),
      deviceJwt: "e2e-device-jwt",
      deviceId: "e2e-draft-approval-device",
      serverVersion: "1.0.0",
    }
    await injectCapacitor(page, {
      platform: "android",
      network: { connected: false, connectionType: "none" },
      secureStorage: {
        "cognia.companion.config.v1": JSON.stringify(companionConfig),
      },
    })
    await page.goto("/welcome")
    await bootstrapCogniaMobile(page, "paired")
    await expect(page.getByTestId("mobile-inbox-trigger")).toBeVisible({ timeout: 15_000 })
  })

  test("approve retries a transient RPC failure and reaches the desktop boundary", async ({
    page,
  }) => {
    const draftId = await seedConnectorDraft(page, {
      adapterId: "adapter-e2e",
      conversationKey: "lark:adapter-e2e:chat-approve",
      content: "Pending reply",
    })

    const rpcUrl = `${mockV2BaseUrl()}/api/v1/_rpc/connector_approve_draft`
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

    await openDraftsWithoutReload(page)
    await expect(page.getByText("Pending reply")).toBeVisible({ timeout: 15_000 })
    await waitForOutboundRunner(page)
    await page.getByTestId(`draft-approve-${draftId}`).click()
    await expect(page.getByText("Pending reply")).toBeHidden()

    await expect
      .poll(async () => {
        const row = await readDexieRow<DraftRowView>(page, {
          table: "connectorDrafts",
          key: draftId,
        })
        return row?.status
      })
      .toBe("approved")

    await restoreNetwork(page)

    await expect.poll(() => attempts, { timeout: 15_000 }).toBe(2)
    expect(idempotencyKeys[0]).toBeTruthy()
    expect(idempotencyKeys[1]).toBe(idempotencyKeys[0])

    await expect
      .poll(async () => {
        const rows = await readDexieRows<QueueRowView>(page, { table: "mobileOutboundQueue" })
        const row = rows.find(
          (candidate) =>
            candidate.command === "connector_approve_draft" &&
            candidate.payload.draftId === draftId
        )
        return row ? `${row.status}:${row.attempts}:${row.lastError ?? ""}` : "missing"
      })
      .toBe("sent:0:")

    const response = await fetch(`${mockV2BaseUrl()}/__control/rpc-calls`)
    expect(response.ok).toBe(true)
    const calls = (await response.json()) as Array<{ command: string; body: unknown }>
    expect(calls).toContainEqual(
      expect.objectContaining({
        command: "connector_approve_draft",
        body: { draftId },
      })
    )
  })

  test("reject persists locally and sends the matching desktop command", async ({ page }) => {
    const draftId = await seedConnectorDraft(page, {
      adapterId: "adapter-e2e",
      conversationKey: "lark:adapter-e2e:chat-reject",
      content: "Discard this reply",
    })

    await openDraftsWithoutReload(page)
    await expect(page.getByText("Discard this reply")).toBeVisible({ timeout: 15_000 })
    await waitForOutboundRunner(page)
    await page.getByTestId(`draft-reject-${draftId}`).click()
    await expect(page.getByText("Discard this reply")).toBeHidden()

    await restoreNetwork(page)

    await expect
      .poll(async () => {
        const rows = await readDexieRows<QueueRowView>(page, { table: "mobileOutboundQueue" })
        return rows.find(
          (candidate) =>
            candidate.command === "connector_reject_draft" && candidate.payload.draftId === draftId
        )?.status
      })
      .toBe("sent")

    const draft = await readDexieRow<DraftRowView>(page, {
      table: "connectorDrafts",
      key: draftId,
    })
    expect(draft?.status).toBe("rejected")

    const response = await fetch(`${mockV2BaseUrl()}/__control/rpc-calls`)
    expect(response.ok).toBe(true)
    const calls = (await response.json()) as Array<{ command: string; body: unknown }>
    expect(calls).toContainEqual(
      expect.objectContaining({
        command: "connector_reject_draft",
        body: { draftId },
      })
    )
  })
})
