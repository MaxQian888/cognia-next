/**
 * Mobile E2E: paired plugin toggle lifecycle (ADR-0056).
 *
 * A desktop-authored plugin arrives through the real sync orchestrator. The
 * user's switch updates Dexie, enters the durable outbound queue, and must be
 * dispatched immediately while already online — without manufacturing a
 * network transition to wake the runner.
 */

import { expect, test, type Page } from "@/tests/e2e/fixtures/test"

import {
  bootstrapCogniaMobile,
  readDexieRow,
  setCogniaSettings,
  waitForTestGlobals,
} from "../helpers/db-reset"
import { injectCapacitor } from "../helpers/inject-capacitor"
import { createOwnerPairPayload } from "./companion-fixture"

import { createMockCompanionServer, type MockCompanionServer } from "./mock-v2-server"

// The fixture owns RPC responses; service-worker caching must not intercept them.
test.use({ serviceWorkers: "block" })
let server: MockCompanionServer
test.beforeAll(async () => {
  server = createMockCompanionServer()
  await server.start(0)
})
test.afterAll(async () => {
  await server.stop()
})

const PLUGIN_ID = "plugin-e2e-release-tools"

interface CapturedRpc {
  command: string
  body: Record<string, unknown>
}

interface StoredPluginRow {
  id: string
  enabled: boolean
}

async function installPluginDesktop(page: Page): Promise<{ calls: CapturedRpc[] }> {
  const calls: CapturedRpc[] = []
  const baseUrl = server.baseUrl
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
    if (request.method() !== "POST") {
      await route.continue()
      return
    }
    const command = new URL(request.url()).pathname.split("/").pop() ?? ""
    const body = (request.postDataJSON() ?? {}) as Record<string, unknown>
    calls.push({ command, body })

    if (command === "host_feature_manifest") {
      const response = await route.fetch()
      expect(response.ok()).toBe(true)
      const body = await response.json()
      body.result.transportCapabilities = { eventStreamReady: 1 }
      await route.fulfill({ response, json: body })
      return
    }
    if (command === "sync_pull") {
      await route.fulfill({
        contentType: "application/json",
        headers: { "access-control-allow-origin": request.headers().origin ?? "*" },
        body: JSON.stringify({
          requestId: "e2e-plugin-sync",
          result: {
            rows: body.table === "plugins" && Number(body.since) < plugin.updatedAt ? [plugin] : [],
            deleted_ids: [],
            next_since: body.table === "plugins" ? plugin.updatedAt + 1 : 1,
          },
        }),
      })
      return
    }
    if (command === "plugin_set_enabled") {
      const response = await route.fetch()
      expect(response.ok()).toBe(true)
      expect(body.id).toBe(PLUGIN_ID)
      expect(typeof body.enabled).toBe("boolean")
      plugin.enabled = body.enabled as boolean
      plugin.status = plugin.enabled ? "enabled" : "disabled"
      plugin.updatedAt = Math.max(Date.now(), plugin.updatedAt + 2)
      await route.fulfill({ response, json: { requestId: "e2e-plugin-toggle", result: true } })
      return
    }
    await route.continue()
  })

  await page.routeWebSocket(/\/ws\/events(?:\?|$)/, async (socket) => {
    const ticket = new URL(socket.url()).searchParams.get("ticket")
    const redeemed = await page.request.post(`${baseUrl}/__control/redeem-ticket`, {
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
  return { calls }
}

test.describe("mobile — plugin toggle lifecycle", () => {
  test("@critical syncs and dispatches a plugin toggle through the durable queue", async ({
    page,
  }) => {
    const desktop = await installPluginDesktop(page)
    await injectCapacitor(page, {
      platform: "android",
      persistSecureStorage: true,
      network: { connected: true, connectionType: "wifi" },
    })
    await page.goto("/onboarding")
    await bootstrapCogniaMobile(page, "paired", {
      onboardingProgress: {
        version: 2,
        path: "completed",
        completedAt: "2026-01-01T00:00:00.000Z",
      },
    })

    await waitForTestGlobals(page)
    await expect
      .poll(
        async () => (await page.evaluate(() => window.__cogniaE2ECompanion!.runtime()))?.accountId
      )
      .toBe("acct_e2e_seed_account")
    await page.getByTestId("pair-discover-skip").click()
    await page.getByTestId("pair-payload").fill(createOwnerPairPayload(server.baseUrl))
    await page.getByTestId("pair-submit").click()
    await expect(page.getByTestId("pair-onboarding")).toHaveAttribute("data-step", "paired")
    await setCogniaSettings(page, {
      mobileRuntimeMode: "paired",
      onboardingProgress: {
        version: 2,
        path: "completed",
        completedAt: "2026-01-01T00:00:00.000Z",
      },
    })
    await page.goto("/me/plugins", { waitUntil: "domcontentloaded" })
    await expect(page.getByTestId("mobile-plugins-page")).toBeVisible()
    const pluginRow = page.getByTestId(`plugin-library-row-${PLUGIN_ID}`)
    await expect(pluginRow).toHaveText("Release Tools")
    await pluginRow.click()
    await expect(page.getByTestId("plugin-detail-header")).toContainText("v2.4.0")

    const currentRuntime = await page.evaluate(() => window.__cogniaE2ECompanion!.runtime())
    expect(currentRuntime).toMatchObject({
      accountId: "acct_e2e_seed_account",
      baseUrl: server.baseUrl,
    })
    const readStoredPlugin = () =>
      readDexieRow<StoredPluginRow>(page, {
        db: currentRuntime!.databaseName,
        table: "plugins",
        key: PLUGIN_ID,
      })
    const pluginSwitch = page.getByTestId("plugin-detail-enable-toggle")
    await expect(pluginSwitch).toHaveAttribute("data-state", "checked")
    await pluginSwitch.click()
    await expect(pluginSwitch).toHaveAttribute("data-state", "unchecked")

    await expect.poll(async () => (await readStoredPlugin())?.enabled).toBe(false)

    await expect
      .poll(async () => {
        const rows = await page.evaluate(() => window.__cogniaReadMobileOutbound!())
        return rows.find((row) => row.command === "plugin_set_enabled")
      })
      .toMatchObject({
        command: "plugin_set_enabled",
        payload: { id: PLUGIN_ID, enabled: false },
      })

    await expect
      .poll(
        async () => {
          const rows = await page.evaluate(() => window.__cogniaReadMobileOutbound!())
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
    await pluginRow.click()
    await expect(pluginSwitch).toHaveAttribute("data-state", "unchecked")
  })
})
