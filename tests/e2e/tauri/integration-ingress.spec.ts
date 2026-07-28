import { expect, test } from "./fixtures"
import { resetCogniaDb } from "../helpers/db-reset"

const ROUTE_ID = "e2e-integration-ingress"

test.describe("tauri: generic Integration ingress IPC", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("registers, resolves, and unregisters a platform-neutral route", async ({ page }) => {
    const registeredUrl = await page.evaluate(async (routeId) => {
      const { invoke } = await import("@tauri-apps/api/core")
      return invoke<string | null>("integration_ingress_register", {
        input: {
          routeId,
          pluginId: "e2e-delivery",
          integrationId: "e2e",
          accountId: "e2e-account",
          subscriptionId: "e2e-subscription",
          path: routeId,
          verification: {
            type: "static-token",
            tokenHeader: "x-e2e-token",
            secretHandle: "e2e-secret-handle",
          },
          deliveryIdHeader: "x-e2e-delivery",
          eventTypeHeader: "x-e2e-event",
          enabled: true,
        },
      })
    }, ROUTE_ID)

    expect(registeredUrl).toMatch(/\/integration\/e2e-integration-ingress$/)

    const resolvedUrl = await page.evaluate(async (routeId) => {
      const { invoke } = await import("@tauri-apps/api/core")
      return invoke<string | null>("integration_ingress_get_url", { routeId })
    }, ROUTE_ID)
    expect(resolvedUrl).toBe(registeredUrl)

    await page.evaluate(async (routeId) => {
      const { invoke } = await import("@tauri-apps/api/core")
      await invoke("integration_ingress_unregister", { routeId })
    }, ROUTE_ID)

    const removedUrl = await page.evaluate(async (routeId) => {
      const { invoke } = await import("@tauri-apps/api/core")
      return invoke<string | null>("integration_ingress_get_url", { routeId })
    }, ROUTE_ID)
    expect(removedUrl).toBeNull()
  })
})
