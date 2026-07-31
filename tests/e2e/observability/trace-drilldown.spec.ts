/**
 * Browser E2E: persisted Agent Trace observability contract.
 *
 * Finished spans are seeded at the real IndexedDB boundary because model/tool
 * execution is owned by separate E2E contracts. The dashboard then has to
 * discover those durable rows, derive rollups, persist a URL-backed filter,
 * and load the selected trace again for its waterfall drill-down.
 */

import { expect, test, type Page } from "@/tests/e2e/fixtures/test"

import { readDexieRows, resetCogniaDb } from "../helpers/db-reset"

const PRIMARY_TRACE_ID = "11111111111111111111111111111111"
const SECONDARY_TRACE_ID = "22222222222222222222222222222222"
const ROOT_SPAN_ID = "1111111111111111"
const TOOL_SPAN_ID = "1111111111111112"
const PRIMARY_MODEL = "claude-e2e-observability"
const SECONDARY_MODEL = "gpt-e2e-observability"

interface PersistedSpan {
  id: string
  traceId: string
  spanId: string
}

async function seedPersistedSpans(page: Page): Promise<void> {
  const now = Date.now()
  const spans = [
    {
      id: ROOT_SPAN_ID,
      traceId: PRIMARY_TRACE_ID,
      spanId: ROOT_SPAN_ID,
      startTime: now - 12_000,
      endTime: now - 10_800,
      durationMs: 1_200,
      operationName: "invoke_agent",
      providerName: "anthropic",
      requestModel: PRIMARY_MODEL,
      responseModel: PRIMARY_MODEL,
      agentId: "release-auditor",
      agentName: "Release Auditor",
      usage: {
        inputTokens: 1_200,
        outputTokens: 300,
        cacheCreationTokens: 0,
        cacheReadTokens: 200,
      },
      costUsdEstimate: 0.0123,
      finishReasons: ["tool_use"],
      sessionId: "session-observability-primary",
      surface: "chat",
      events: [
        {
          name: "agent.started",
          at: now - 11_950,
          attributes: { source: "e2e" },
        },
      ],
    },
    {
      id: TOOL_SPAN_ID,
      traceId: PRIMARY_TRACE_ID,
      spanId: TOOL_SPAN_ID,
      parentSpanId: ROOT_SPAN_ID,
      startTime: now - 11_700,
      endTime: now - 11_300,
      durationMs: 400,
      operationName: "execute_tool",
      providerName: "cognia.plugin",
      toolName: "release_evidence_lookup",
      errorType: "ToolExecutionError",
      errorMessage: "Evidence index unavailable",
      sessionId: "session-observability-primary",
      surface: "chat",
      events: [{ name: "tool.failed", at: now - 11_320 }],
    },
    {
      id: "2222222222222222",
      traceId: SECONDARY_TRACE_ID,
      spanId: "2222222222222222",
      startTime: now - 7_000,
      endTime: now - 6_700,
      durationMs: 300,
      operationName: "chat",
      providerName: "openai",
      requestModel: SECONDARY_MODEL,
      responseModel: SECONDARY_MODEL,
      usage: {
        inputTokens: 80,
        outputTokens: 20,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
      costUsdEstimate: 0.001,
      sessionId: "session-observability-secondary",
      surface: "connector",
    },
  ]

  const seeded = await page.evaluate(async (rows) => {
    const databaseNames = (await indexedDB.databases())
      .map((info) => info.name)
      .filter((name): name is string => Boolean(name))
      .sort(
        (a, b) => Number(b.startsWith("cognia-account-")) - Number(a.startsWith("cognia-account-"))
      )

    for (const databaseName of databaseNames) {
      const inserted = await new Promise<boolean>((resolve, reject) => {
        const request = indexedDB.open(databaseName)
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const connection = request.result
          connection.onversionchange = () => connection.close()
          if (!connection.objectStoreNames.contains("agentTraces")) {
            connection.close()
            resolve(false)
            return
          }

          const transaction = connection.transaction("agentTraces", "readwrite")
          const store = transaction.objectStore("agentTraces")
          for (const row of rows) store.put(row)
          transaction.oncomplete = () => {
            connection.close()
            resolve(true)
          }
          transaction.onerror = () => {
            connection.close()
            reject(transaction.error)
          }
        }
      })
      if (inserted) return true
    }
    return false
  }, spans)

  expect(seeded, "an active Cognia database should own agentTraces").toBe(true)
}

test.describe("observability — durable trace drill-down", () => {
  test("filters persisted spans and drills into the selected waterfall", async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
    await seedPersistedSpans(page)

    const persisted = await readDexieRows<PersistedSpan>(page, { table: "agentTraces" })
    expect(persisted).toHaveLength(3)
    expect(persisted.map((span) => span.traceId)).toEqual(
      expect.arrayContaining([PRIMARY_TRACE_ID, SECONDARY_TRACE_ID])
    )

    await page.goto("/observability", { waitUntil: "domcontentloaded" })
    await expect(page.getByTestId("observability-dashboard")).toBeVisible()
    await expect(page.getByTestId("stat-value-kpi-spans")).toHaveText("3")

    const primaryTrace = page.getByTestId(`trace-row-${PRIMARY_TRACE_ID}`)
    const secondaryTrace = page.getByTestId(`trace-row-${SECONDARY_TRACE_ID}`)
    await expect(primaryTrace).toContainText("invoke_agent · Release Auditor")
    await expect(primaryTrace).toContainText("2")
    await expect(secondaryTrace).toBeVisible()

    await page.getByTestId(`donut-legend-bd-model-${PRIMARY_MODEL}`).click()
    await expect(page).toHaveURL(/f=/)
    await expect(primaryTrace).toBeVisible()
    await expect(secondaryTrace).toHaveCount(0)

    await page.reload({ waitUntil: "domcontentloaded" })
    const modelFilter = page.getByTestId("filter-model")
    await expect(modelFilter).toContainText("1")
    await modelFilter.click()
    await expect(page.getByTestId(`filter-model-option-${PRIMARY_MODEL}`)).toHaveAttribute(
      "aria-pressed",
      "true"
    )
    await page.keyboard.press("Escape")
    await expect(page.getByTestId(`trace-row-${SECONDARY_TRACE_ID}`)).toHaveCount(0)

    await page.getByTestId(`trace-row-${PRIMARY_TRACE_ID}`).click()
    const drawer = page.getByRole("dialog")
    await expect(drawer).toContainText(PRIMARY_TRACE_ID)
    await expect(drawer.getByTestId(`waterfall-row-${ROOT_SPAN_ID}`)).toContainText(
      "invoke_agent · Release Auditor"
    )
    await expect(drawer.getByTestId(`waterfall-row-${TOOL_SPAN_ID}`)).toContainText(
      "release_evidence_lookup"
    )

    await drawer.getByTestId(`waterfall-toggle-${ROOT_SPAN_ID}`).click()
    await expect(drawer.getByTestId(`waterfall-meta-${ROOT_SPAN_ID}`)).toContainText(
      "agent.started"
    )
    await drawer.getByTestId(`waterfall-toggle-${TOOL_SPAN_ID}`).click()
    const toolMetadata = drawer.getByTestId(`waterfall-meta-${TOOL_SPAN_ID}`)
    await expect(toolMetadata).toContainText("Evidence index unavailable")
    await expect(toolMetadata).toContainText("tool.failed")
  })
})
