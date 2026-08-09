/**
 * Mobile E2E: MCP settings parity (ADR-0056).
 *
 * Paired mode mirrors desktop-authored servers through the real Companion sync
 * orchestrator and renders a read-only list. Standalone mode must keep this
 * agent-class surface gated because its in-webview runtime has no MCP backend.
 */

import { expect, test, type Page } from "@/tests/e2e/fixtures/test"

import { bootstrapCogniaMobile, readDexieRows } from "../helpers/db-reset"
import { injectCapacitor } from "../helpers/inject-capacitor"
import {
  companionConfigSecureStorage,
  provisionMockCompanionConfig,
} from "./companion-fixture"

const CONTEXT_SERVER_ID = "mcp-e2e-context"
const FILESYSTEM_SERVER_ID = "mcp-e2e-filesystem"

interface CapturedRpc {
  command: string
  body: Record<string, unknown>
}

interface McpServerRow {
  id: string
  name: string
  transport: "stdio" | "sse" | "http"
  config: Record<string, unknown>
  enabled: boolean
  appsEnabled: Record<string, boolean>
  createdAt: number
  updatedAt: number
}

function mockV2BaseUrl(): string {
  const baseUrl = process.env.E2E_V2_BASE_URL
  if (!baseUrl) throw new Error("E2E_V2_BASE_URL is required for MCP Servers E2E")
  return baseUrl
}

async function installMcpDesktop(page: Page): Promise<{
  calls: CapturedRpc[]
  disconnectMcpSync: () => void
}> {
  const calls: CapturedRpc[] = []
  const baseUrl = mockV2BaseUrl()
  const now = Date.now()
  let mcpSyncConnected = true
  const serverRows: McpServerRow[] = [
    {
      id: FILESYSTEM_SERVER_ID,
      name: "Filesystem",
      transport: "stdio",
      config: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"] },
      enabled: true,
      appsEnabled: {},
      createdAt: now - 2_000,
      updatedAt: now - 1_000,
    },
    {
      id: CONTEXT_SERVER_ID,
      name: "Context API",
      transport: "http",
      config: { url: "https://mcp.example.test/rpc" },
      enabled: false,
      appsEnabled: {},
      createdAt: now - 4_000,
      updatedAt: now,
    },
  ]

  await page.route(`${baseUrl}/api/_rpc/**`, async (route) => {
    const request = route.request()
    const command = new URL(request.url()).pathname.split("/").pop() ?? ""
    const body = (request.postDataJSON() ?? {}) as Record<string, unknown>
    calls.push({ command, body })

    if (command !== "sync_pull") {
      await route.fulfill({ status: 404, contentType: "text/plain", body: "unknown command" })
      return
    }
    if (body.table === "mcpServers" && !mcpSyncConnected) {
      await route.fulfill({ status: 503, contentType: "text/plain", body: "desktop offline" })
      return
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        rows: body.table === "mcpServers" && body.since === 0 ? serverRows : [],
        deleted_ids: [],
        next_since: body.table === "mcpServers" ? now + 1 : 1,
      }),
    })
  })

  return {
    calls,
    disconnectMcpSync() {
      mcpSyncConnected = false
    },
  }
}

test.describe("mobile — MCP server settings", () => {
  test("mirrors a read-only server list and restores it while the desktop is offline", async ({
    page,
  }) => {
    const desktop = await installMcpDesktop(page)
    const companionConfig = await provisionMockCompanionConfig(
      mockV2BaseUrl(),
      "device-e2e-mcp"
    )
    await injectCapacitor(page, {
      platform: "android",
      network: { connected: true, connectionType: "wifi" },
      secureStorage: companionConfigSecureStorage(companionConfig),
    })
    await page.goto("/welcome")
    await bootstrapCogniaMobile(page, "paired")

    await page.goto("/me/mcp", { waitUntil: "domcontentloaded" })
    await expect(page.getByTestId("mobile-mcp-page")).toBeVisible()
    await expect(page.getByTestId(`mcp-row-${CONTEXT_SERVER_ID}`)).toContainText("Context API")
    await expect(page.getByTestId(`mcp-row-${FILESYSTEM_SERVER_ID}`)).toContainText("Filesystem")
    await expect(page.getByTestId(`mcp-state-${CONTEXT_SERVER_ID}`)).toContainText(/off/i)
    await expect(page.getByTestId(`mcp-state-${FILESYSTEM_SERVER_ID}`)).toContainText(/on/i)
    await expect(page.getByTestId(`mcp-row-${CONTEXT_SERVER_ID}`)).toContainText(
      /authenticate on desktop/i
    )
    await expect(page.getByTestId("mcp-manage-note")).toBeVisible()

    await expect
      .poll(() =>
        desktop.calls.find(
          (call) =>
            call.command === "sync_pull" &&
            call.body.table === "mcpServers" &&
            call.body.since === 0
        )
      )
      .toMatchObject({ command: "sync_pull", body: { table: "mcpServers", since: 0 } })

    const renderedIds = await page
      .locator('[data-testid^="mcp-row-"]')
      .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-testid")))
    expect(renderedIds).toEqual([
      `mcp-row-${CONTEXT_SERVER_ID}`,
      `mcp-row-${FILESYSTEM_SERVER_ID}`,
    ])

    const persistedRows = await readDexieRows<McpServerRow>(page, { table: "mcpServers" })
    expect(persistedRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: CONTEXT_SERVER_ID,
          transport: "http",
          enabled: false,
          config: { url: "https://mcp.example.test/rpc" },
        }),
        expect.objectContaining({
          id: FILESYSTEM_SERVER_ID,
          transport: "stdio",
          enabled: true,
        }),
      ])
    )

    const pullsBeforeOfflineReload = desktop.calls.filter(
      (call) => call.command === "sync_pull" && call.body.table === "mcpServers"
    ).length
    desktop.disconnectMcpSync()
    await page.reload({ waitUntil: "domcontentloaded" })

    await expect(page.getByTestId(`mcp-row-${CONTEXT_SERVER_ID}`)).toBeVisible()
    await expect(page.getByTestId(`mcp-row-${FILESYSTEM_SERVER_ID}`)).toBeVisible()
    await expect
      .poll(
        () =>
          desktop.calls.filter(
            (call) => call.command === "sync_pull" && call.body.table === "mcpServers"
          ).length
      )
      .toBeGreaterThan(pullsBeforeOfflineReload)
  })

  test("keeps MCP settings gated when the mobile runtime is standalone", async ({ page }) => {
    await injectCapacitor(page, { platform: "android" })
    await page.goto("/welcome")
    await bootstrapCogniaMobile(page, "standalone")

    await page.goto("/me/mcp", { waitUntil: "domcontentloaded" })
    await expect(page.getByTestId("mobile-mcp-page")).toBeVisible()
    await expect(page.getByTestId("paired-only-placeholder")).toBeVisible()
    await expect(page.getByTestId("me-section-mcp")).toHaveCount(0)
    await expect(page.getByTestId("mcp-manage-note")).toHaveCount(0)
  })
})
