/**
 * Browser E2E: operator-visible connector dead-letter recovery.
 *
 * Platform delivery remains owned by the native Tauri connector suites. This
 * spec owns the portable recovery contract: inspect persisted failure context,
 * explicitly confirm a bulk replay, and observe both queue + audit durability.
 */

import { expect, test, type Page } from "@/tests/e2e/fixtures/test"
import { ensureCogniaAccount, readDexieRows, waitForTestGlobals } from "../helpers/db-reset"

interface OutboundJobView {
  id: string
  status: string
  attempts: number
  lastError?: string
  lastErrorCode?: string
}

interface ConnectorAuditView {
  kind: string
  fields?: { jobId?: string; lastErrorCode?: string }
}

const DEADLETTER_JOBS = [
  { id: "oqj_e2e_dead_1", errorCode: "platform_5xx", error: "upstream unavailable" },
  { id: "oqj_e2e_dead_2", errorCode: "network", error: "connection reset" },
] as const

async function seedDeadletteredJobs(page: Page): Promise<void> {
  const now = Date.now()
  const rows = DEADLETTER_JOBS.map((job, index) => ({
    id: job.id,
    adapterId: "e2e-telegram",
    conversationKey: `telegram:e2e-telegram:chat-${index + 1}`,
    request: {
      conversationRef: {
        platform: "telegram",
        adapterId: "e2e-telegram",
        chatId: `chat-${index + 1}`,
      },
      segments: [{ type: "text", text: `recover message ${index + 1}` }],
      metadata: { idempotencyKey: `idem-${job.id}` },
    },
    status: "deadlettered",
    attempts: 5,
    lastError: job.error,
    lastErrorCode: job.errorCode,
    createdAt: now - (index + 1) * 60_000,
    nextAttemptAt: now - 1_000,
    idempotencyKey: `idem-${job.id}`,
    source: "manual",
  }))

  const writes = await page.evaluate(async (seedRows) => {
    let count = 0
    for (const info of await indexedDB.databases()) {
      if (!info.name?.startsWith("cognia-")) continue
      count += await new Promise<number>((resolve, reject) => {
        const request = indexedDB.open(info.name!)
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const db = request.result
          if (!db.objectStoreNames.contains("outboundQueue")) {
            db.close()
            resolve(0)
            return
          }
          const tx = db.transaction("outboundQueue", "readwrite")
          const store = tx.objectStore("outboundQueue")
          for (const row of seedRows) store.put(row)
          tx.oncomplete = () => {
            db.close()
            resolve(seedRows.length)
          }
          tx.onerror = () => {
            db.close()
            reject(tx.error)
          }
          tx.onabort = () => {
            db.close()
            reject(tx.error)
          }
        }
      })
    }
    return count
  }, rows)

  expect(
    writes,
    "dead-letter jobs should be seeded into an active Cognia database"
  ).toBeGreaterThan(0)
}

test.describe("connectors — outbound dead-letter recovery", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await ensureCogniaAccount(page)
    await page.goto("about:blank")
    await page.goto("/settings?section=connections&connectionsTab=outbound", {
      waitUntil: "domcontentloaded",
    })
    await waitForTestGlobals(page, 30_000)
  })

  test("@critical Retry all re-arms dead letters and records replay audits", async ({ page }) => {
    await seedDeadletteredJobs(page)

    await expect(page.getByRole("tab", { name: "Outbound" })).toHaveAttribute(
      "aria-selected",
      "true"
    )
    await page.getByRole("button", { name: "Filter Dead-lettered" }).click()

    const firstRow = page.getByTestId(`outbound-row-${DEADLETTER_JOBS[0].id}`)
    const secondRow = page.getByTestId(`outbound-row-${DEADLETTER_JOBS[1].id}`)
    await expect(firstRow).toBeVisible()
    await expect(secondRow).toBeVisible()

    await firstRow
      .getByRole("button", { name: `Expand details for job ${DEADLETTER_JOBS[0].id}` })
      .click()
    await expect(firstRow).toContainText("[platform_5xx] upstream unavailable")
    await expect(firstRow).toContainText(`idem-${DEADLETTER_JOBS[0].id}`)

    await page.getByRole("button", { name: "Retry all (2)" }).click()
    const dialog = page.getByRole("alertdialog", {
      name: "Re-enqueue all dead-lettered jobs?",
    })
    await expect(dialog).toBeVisible()
    await dialog.getByRole("button", { name: "Retry all", exact: true }).click()

    await expect(firstRow).toBeHidden()
    await expect(secondRow).toBeHidden()
    await expect(page.getByText("No outbound jobs in flight.")).toBeVisible()

    await expect
      .poll(async () => {
        const rows = await readDexieRows<OutboundJobView>(page, { table: "outboundQueue" })
        return rows
          .filter((row) => DEADLETTER_JOBS.some((job) => job.id === row.id))
          .map((row) => ({
            id: row.id,
            status: row.status,
            attempts: row.attempts,
            hasError: row.lastError !== undefined || row.lastErrorCode !== undefined,
          }))
          .sort((a, b) => a.id.localeCompare(b.id))
      })
      .toEqual(
        DEADLETTER_JOBS.map((job) => ({
          id: job.id,
          status: "pending",
          attempts: 0,
          hasError: false,
        }))
      )

    await expect
      .poll(async () => {
        const rows = await readDexieRows<ConnectorAuditView>(page, { table: "connectorAudit" })
        return rows
          .filter((row) => row.kind === "outbound.replayed")
          .map((row) => `${row.fields?.jobId}:${row.fields?.lastErrorCode}`)
          .sort()
      })
      .toEqual(DEADLETTER_JOBS.map((job) => `${job.id}:${job.errorCode}`).sort())
  })
})
