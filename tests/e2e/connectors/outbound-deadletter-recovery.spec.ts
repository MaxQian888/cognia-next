/**
 * Browser E2E: operator-visible connector dead-letter recovery.
 *
 * Platform delivery remains owned by the native Tauri connector suites. This
 * spec pairs a browser to an authenticated mock Host and owns the recovery contract: inspect persisted failure context,
 * explicitly confirm a bulk replay, and observe both queue + audit durability.
 */

import { expect, test, type Page } from "@/tests/e2e/fixtures/test"
import { resetCogniaDb, setCogniaSettings, ensureAppMounted } from "../helpers/db-reset"

import type { OutboundJobRow } from "@/lib/db/connector-types"
import { createMockCompanionServer, type MockCompanionServer } from "../mobile/mock-v2-server"
import { createOwnerPairPayload } from "../mobile/companion-fixture"

// The test owns the mocked event stream; Serwist must not intercept its RPC route.
test.use({ serviceWorkers: "block" })

let server: MockCompanionServer

test.beforeAll(async () => {
  server = createMockCompanionServer()
  await server.start(0)
})

test.afterAll(async () => {
  await server.stop()
})

const DEADLETTER_JOBS = [
  { id: "oqj_e2e_dead_1", errorCode: "platform_5xx", error: "upstream unavailable" },
  { id: "oqj_e2e_dead_2", errorCode: "network", error: "connection reset" },
] as const

async function seedDeadletteredJobs(page: Page): Promise<void> {
  const now = Date.now()
  const rows: OutboundJobRow[] = DEADLETTER_JOBS.map((job, index) => ({
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

  await page.evaluate(async (seedRows) => {
    if (!window.__cogniaE2EOutbound) throw new Error("Outbound fixture bridge unavailable")
    await window.__cogniaE2EOutbound.seed(seedRows)
  }, rows)
}

test.describe("connectors — outbound dead-letter recovery", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
    server.reset()
    await page.route(`${server.baseUrl}/api/_rpc/host_feature_manifest`, async (route) => {
      const response = await route.fetch()
      expect(response.ok()).toBe(true)
      const body = await response.json()
      body.result.transportCapabilities = { eventStreamReady: 1 }
      await route.fulfill({ response, json: body })
    })
    await page.routeWebSocket(/\/ws\/events(?:\?|$)/, async (socket) => {
      const ticket = new URL(socket.url()).searchParams.get("ticket")
      const redeemed = await page.request.post(`${server.baseUrl}/__control/redeem-ticket`, {
        data: { ticket, path: "/ws/events", audience: "events" },
      })
      expect(redeemed.ok()).toBe(true)
      socket.onMessage((raw) => {
        const frame = JSON.parse(String(raw)) as { type?: string; channels?: string[] }
        if (frame.type === "subscribe") {
          socket.send(JSON.stringify({ type: "subscribed", channels: frame.channels ?? [] }))
          socket.send(JSON.stringify({ type: "stream_ready", cursor: 0 }))
        }
      })
    })
    await page.evaluate(async (invitation) => {
      if (!window.__cogniaE2ECompanion) throw new Error("Companion fixture bridge unavailable")
      await window.__cogniaE2ECompanion.pair(invitation)
    }, createOwnerPairPayload(server.baseUrl))
    await setCogniaSettings(page, {
      onboardingProgress: {
        version: 2,
        path: "completed",
        completedAt: "2026-01-01T00:00:00.000Z",
      },
    })
    await page.goto("about:blank")
    await page.goto("/settings?section=connections&connectionsTab=outbound", {
      waitUntil: "domcontentloaded",
    })
    await ensureAppMounted(page)
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
        const { jobs: rows } = await page.evaluate(() => window.__cogniaE2EOutbound!.read())
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
        const { audit: rows } = await page.evaluate(() => window.__cogniaE2EOutbound!.read())
        return rows
          .filter((row) => row.kind === "outbound.replayed")
          .map((row) => `${row.fields?.jobId}:${row.fields?.lastErrorCode}`)
          .sort()
      })
      .toEqual(DEADLETTER_JOBS.map((job) => `${job.id}:${job.errorCode}`).sort())
  })
})
