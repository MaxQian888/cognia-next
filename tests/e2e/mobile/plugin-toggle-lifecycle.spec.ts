/**
 * Mobile E2E: paired plugin toggle lifecycle (ADR-0056).
 *
 * A desktop-authored plugin arrives through the real sync orchestrator. The
 * user's switch updates Dexie, enters the durable outbound queue, and must be
 * dispatched immediately while already online — without manufacturing a
 * network transition to wake the runner.
 */

import { expect, test, type Page } from "@/tests/e2e/fixtures/test"

import { bootstrapCogniaMobile, readDexieRow, readDexieRows } from "../helpers/db-reset"
import { injectCapacitor } from "../helpers/inject-capacitor"
import {
  companionConfigSecureStorage,
  provisionMockCompanionConfig,
} from "./companion-fixture"

const PLUGIN_ID = "plugin-e2e-release-tools"

interface CapturedRpc {
  command: string
  body: Record<string, unknown>
}

interface PluginRow {
  id: string
  name: string
  enabled: boolean
  updatedAt: number
}

interface QueueRow {
  id: string
  command: string
  payload: Record<string, unknown>
  status: string
  lastError?: string
}

function mockV2BaseUrl(): string {
  const baseUrl = process.env.E2E_V2_BASE_URL
  if (!baseUrl) throw new Error("E2E_V2_BASE_URL is required for Plugin Toggle E2E")
  return baseUrl
}

async function installPluginDesktop(page: Page): Promise<{ calls: CapturedRpc[] }> {
  const calls: CapturedRpc[] = []
  const baseUrl = mockV2BaseUrl()
  const now = Date.now()
  const plugin = {
    id: PLUGIN_ID,
    name: "Release Tools",
    version: "2.4.0",
    status: "enabled",
    source: "marketplace",
    type: "frontend",
    enabled: true,
    capabilities: ["workflow:node"],
    path: "/plugins/release-tools",
    manifest: { id: PLUGIN_ID, name: "Release Tools", version: "2.4.0" },
    createdAt: now - 1_000,
    updatedAt: now,
  }

  await page.route(`${baseUrl}/api/_rpc/**`, async (route) => {
    const request = route.request()
    const command = new URL(request.url()).pathname.split("/").pop() ?? ""
    const body = (request.postDataJSON() ?? {}) as Record<string, unknown>
    calls.push({ command, body })

    if (command === "sync_pull") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          rows: body.table === "plugins" && body.since === 0 ? [plugin] : [],
          deleted_ids: [],
          next_since: body.table === "plugins" ? now + 1 : 1,
        }),
      })
      return
    }
    if (command === "plugin_set_enabled") {
      await route.fulfill({ contentType: "application/json", body: "true" })
      return
    }
    await route.fulfill({ status: 404, contentType: "text/plain", body: "unknown command" })
  })

  return { calls }
}

test.describe("mobile — plugin toggle lifecycle", () => {
  test("@critical syncs and dispatches a plugin toggle through the durable queue", async ({
    page,
  }) => {
    const desktop = await installPluginDesktop(page)
    const companionConfig = await provisionMockCompanionConfig(
      mockV2BaseUrl(),
      "device-e2e-plugin-toggle"
    )
    await injectCapacitor(page, {
      platform: "android",
      network: { connected: true, connectionType: "wifi" },
      secureStorage: companionConfigSecureStorage(companionConfig),
    })
    await page.goto("/onboarding")
    await bootstrapCogniaMobile(page, "paired")

    await page.goto("/me/plugins", { waitUntil: "domcontentloaded" })
    await expect(page.getByTestId("mobile-plugins-page")).toBeVisible()
    await expect(page.getByTestId(`plugin-row-${PLUGIN_ID}`)).toContainText("Release Tools")
    await expect(page.getByTestId(`plugin-row-${PLUGIN_ID}`)).toContainText("v2.4.0")

    const pluginSwitch = page.getByTestId(`plugin-switch-${PLUGIN_ID}`)
    await expect(pluginSwitch).toHaveAttribute("data-state", "checked")
    await pluginSwitch.click()
    await expect(pluginSwitch).toHaveAttribute("data-state", "unchecked")

    await expect
      .poll(async () => (await readDexieRow<PluginRow>(page, { table: "plugins", key: PLUGIN_ID }))?.enabled)
      .toBe(false)

    await expect
      .poll(async () => {
        const rows = await readDexieRows<QueueRow>(page, { table: "mobileOutboundQueue" })
        return rows.find((row) => row.command === "plugin_set_enabled")
      })
      .toMatchObject({
        command: "plugin_set_enabled",
        payload: { id: PLUGIN_ID, enabled: false },
      })

    await expect
      .poll(
        async () => {
          const rows = await readDexieRows<QueueRow>(page, { table: "mobileOutboundQueue" })
          const row = rows.find((candidate) => candidate.command === "plugin_set_enabled")
          return row ? `${row.status}${row.lastError ? `:${row.lastError}` : ""}` : "missing"
        },
        { timeout: 10_000 }
      )
      .toBe("sent")
    await expect
      .poll(() =>
        desktop.calls.find(
          (call) => call.command === "plugin_set_enabled" && call.body.id === PLUGIN_ID
        )
      )
      .toMatchObject({
        command: "plugin_set_enabled",
        body: { id: PLUGIN_ID, enabled: false },
      })

    await page.reload({ waitUntil: "domcontentloaded" })
    await expect(page.getByTestId(`plugin-switch-${PLUGIN_ID}`)).toHaveAttribute(
      "data-state",
      "unchecked"
    )
  })
})
