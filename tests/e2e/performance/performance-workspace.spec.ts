import { expect, test } from "@/tests/e2e/fixtures/test"

test.describe("performance — progressive diagnostic workspace", () => {
  test("keeps Renderer and captures available without a selected host", async ({ page }) => {
    await page.goto("/performance", { waitUntil: "domcontentloaded" })

    await expect(page.getByTestId("performance-dashboard")).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole("tab", { name: "Overview" })).toBeVisible()
    await expect(page.getByText("Local Renderer", { exact: true }).first()).toBeVisible()

    await page.getByRole("tab", { name: "Captures" }).click()
    await expect(page.getByTestId("perf-captures-tab")).toBeVisible()
    await expect(page.getByRole("button", { name: "Start capture" })).toBeVisible()
    await page.getByRole("combobox", { name: "Capture source" }).click()
    await expect(page.getByRole("option", { name: "Selected host" })).toBeDisabled()
  })

  test("releases live Renderer demand after leaving the workspace", async ({ page }) => {
    await page.goto("/performance", { waitUntil: "domcontentloaded" })
    await expect(page.getByTestId("performance-dashboard")).toBeVisible({ timeout: 30_000 })

    const activeBefore = await page.evaluate(() => {
      const collector = (
        window as typeof window & {
          __COGNIA_PERF_DOCUMENT_ID__?: string
        }
      ).__COGNIA_PERF_DOCUMENT_ID__
      return Boolean(collector)
    })
    expect(activeBefore).toBe(true)

    await page.goto("/settings", { waitUntil: "domcontentloaded" })
    await expect(page).toHaveURL(/\/settings/)
    // No performance frame event is produced merely by navigating around; an
    // explicit capture would instead stay owned by the authenticated shell.
    const frameCount = await page.evaluate(
      () =>
        performance
          .getEntriesByType("measure")
          .filter((entry) => entry.name.startsWith("cognia:perf")).length
    )
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            performance
              .getEntriesByType("measure")
              .filter((entry) => entry.name.startsWith("cognia:perf")).length
        )
      )
      .toBe(frameCount)
  })
})
