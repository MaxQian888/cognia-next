/**
 * Browser E2E: durable structured-log investigation contract.
 *
 * The entries are inserted at the production IndexedDB transport boundary;
 * the owning /logs route must fetch them through useLogStream, filter them,
 * restore the shareable query after reload, and correlate related entries in
 * the real detail panel.
 */

import { expect, test, type Page } from "@/tests/e2e/fixtures/test"

import { resetCogniaDb } from "../helpers/db-reset"

const SEARCH_TERM = "E2E_RELEASE_TRACE"
const TRACE_ID = "trace-e2e-release-investigation"
const ERROR_LOG_ID = "log-e2e-release-error"
const ERROR_MESSAGE = `${SEARCH_TERM} deployment verification failed`
const RECOVERY_MESSAGE = `${SEARCH_TERM} rollback completed`

interface PersistedLog {
  id: string
  timestamp: string
  level: "info" | "warn" | "error"
  message: string
  module: string
  traceId?: string
  sessionId?: string
  runtime?: "browser"
  origin?: "frontend"
  data?: Record<string, unknown>
  stack?: string
  tags?: string[]
}

async function seedPersistedLogs(page: Page): Promise<void> {
  await page.waitForFunction(async () => {
    const databases = await indexedDB.databases()
    return databases.some((database) => database.name === "cognia-logs")
  })

  const now = Date.now()
  const logs: PersistedLog[] = [
    {
      id: ERROR_LOG_ID,
      timestamp: new Date(now - 3_000).toISOString(),
      level: "error",
      message: ERROR_MESSAGE,
      module: "release.verifier",
      traceId: TRACE_ID,
      sessionId: "session-e2e-release",
      runtime: "browser",
      origin: "frontend",
      data: {
        deployId: "deploy-e2e-42",
        releaseStage: "verification",
        retryable: true,
      },
      stack:
        "Error: deployment verification failed\n    at verifyRelease (/app/release/verifier.ts:42:7)",
      tags: ["release", "e2e"],
    },
    {
      id: "log-e2e-release-recovery",
      timestamp: new Date(now - 2_000).toISOString(),
      level: "warn",
      message: RECOVERY_MESSAGE,
      module: "release.rollback",
      traceId: TRACE_ID,
      sessionId: "session-e2e-release",
      runtime: "browser",
      origin: "frontend",
      data: { deployId: "deploy-e2e-42", restored: true },
      tags: ["release", "recovery"],
    },
    {
      id: "log-e2e-unrelated",
      timestamp: new Date(now - 1_000).toISOString(),
      level: "info",
      message: "Background cache refresh completed",
      module: "cache.refresh",
      runtime: "browser",
      origin: "frontend",
    },
  ]

  const storedIds = await page.evaluate(async (rows) => {
    return new Promise<string[]>((resolve, reject) => {
      const request = indexedDB.open("cognia-logs")
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const connection = request.result
        connection.onversionchange = () => connection.close()
        if (!connection.objectStoreNames.contains("logs")) {
          connection.close()
          reject(new Error("cognia-logs is missing its logs store"))
          return
        }

        const transaction = connection.transaction("logs", "readwrite")
        const store = transaction.objectStore("logs")
        for (const row of rows) store.put(row)
        transaction.oncomplete = () => {
          const verifyTransaction = connection.transaction("logs", "readonly")
          const verifyStore = verifyTransaction.objectStore("logs")
          const ids: string[] = []
          for (const row of rows) {
            const get = verifyStore.get(row.id)
            get.onsuccess = () => {
              if (get.result) ids.push(row.id)
            }
          }
          verifyTransaction.oncomplete = () => {
            connection.close()
            resolve(ids)
          }
          verifyTransaction.onerror = () => {
            connection.close()
            reject(verifyTransaction.error)
          }
        }
        transaction.onerror = () => {
          connection.close()
          reject(transaction.error)
        }
      }
    })
  }, logs)

  expect(storedIds).toEqual(expect.arrayContaining(logs.map((log) => log.id)))
}

test.describe("logs — durable investigation", () => {
  test("restores a search and correlates related entries in the detail panel", async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
    await seedPersistedLogs(page)

    await page.goto("/logs", { waitUntil: "domcontentloaded" })
    await expect(page.getByTestId("logs-page-header")).toBeVisible()
    await expect(page.getByTestId("logs-page-header")).toHaveAttribute("data-variant", "management")

    const search = page.getByRole("combobox", { name: "Search logs..." })
    await search.fill(SEARCH_TERM)
    await expect(page).toHaveURL(new RegExp(`q=${SEARCH_TERM}`))

    const matchingRows = page.getByTestId("log-entry-row")
    await expect(matchingRows).toHaveCount(2)
    await expect(page.getByTestId("logs-page-header-live-pill")).toContainText("2 /")
    await expect(matchingRows.filter({ hasText: "Background cache refresh" })).toHaveCount(0)

    await page.reload({ waitUntil: "domcontentloaded" })
    await expect(search).toHaveValue(SEARCH_TERM)
    await expect(page.getByTestId("log-entry-row")).toHaveCount(2)

    const errorRow = page.getByTestId("log-entry-row").filter({ hasText: ERROR_MESSAGE })
    await expect(errorRow).toHaveAttribute("data-level", "error")
    await errorRow.getByRole("button", { name: "View Details" }).click()

    await expect(page).toHaveURL(/detail=1/)
    await expect(page).toHaveURL(new RegExp(`sel=${ERROR_LOG_ID}`))
    const detail = page.getByRole("heading", { name: "Log Detail" }).locator("xpath=../../..")
    await expect(detail).toContainText(ERROR_MESSAGE)
    await expect(detail).toContainText("release.verifier")
    await expect(detail).toContainText(TRACE_ID)
    await expect(detail).toContainText("deploy-e2e-42")
    await expect(detail).toContainText("verifyRelease")

    const related = page.getByTestId("related-log-log-e2e-release-recovery")
    await expect(related).toContainText(RECOVERY_MESSAGE)
    await related.click()
    await expect(detail).toContainText(RECOVERY_MESSAGE)
    await expect(detail).toContainText("release.rollback")
  })
})
