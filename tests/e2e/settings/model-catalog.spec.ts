/**
 * Contract:
 * legacy provider deep link → settings redirect → AI Connections remains
 * reachable; Model Catalog deep link → search canonical/upstream id → visible
 * offering exposes the exact routed id.
 */

import { expect, test } from "@/tests/e2e/fixtures/test"
import { ensureCogniaAccount, waitForTestGlobals } from "../helpers/db-reset"

test.describe("settings — AI Connections and Model Catalog", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await ensureCogniaAccount(page)
    await page.goto("about:blank")
    await page.goto("/", { waitUntil: "domcontentloaded" })
    await waitForTestGlobals(page, 30_000)
  })

  test("@smoke keeps the legacy providers deep link compatible", async ({ page }) => {
    await page.evaluate(() => {
      window.location.href = "/settings?section=providers"
    })

    await expect.poll(() => new URL(page.url()).searchParams.get("section")).toBe("ai-connections")
    await expect(page.getByText("AI Connections", { exact: true }).first()).toBeVisible()
  })

  test("searches the active catalog and exposes the routed upstream id", async ({ page }) => {
    await page.goto("/settings?section=model-catalog", {
      waitUntil: "domcontentloaded",
    })

    await expect(page.getByRole("heading", { name: "Model Catalog" })).toBeVisible({
      timeout: 30_000,
    })
    const search = page.getByPlaceholder(
      "Search name, canonical ID, upstream ID, alias, or provider…"
    )
    await search.fill("gpt-5.6-sol")

    const model = page
      .getByRole("button")
      .filter({ has: page.getByText("openai:gpt-5.6-sol", { exact: true }) })
    await expect(model).toBeVisible()
    await model.click()
    await expect(page.getByText("Routed ID: gpt-5.6-sol")).toBeVisible()
  })
})
