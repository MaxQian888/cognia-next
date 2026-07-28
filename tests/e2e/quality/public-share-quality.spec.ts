import { expect, test, type Page } from "@/tests/e2e/fixtures/test"
import { encodeShareKey, generateShareKey } from "@/lib/share/keys"

const SHARE_CODE = "e2e-public-share-quality"

async function openUnavailableShare(page: Page): Promise<void> {
  await page.route(`**/v1/share/${SHARE_CODE}`, async (route) => {
    await route.fulfill({ status: 404, contentType: "application/json", body: "{}" })
  })

  const encodedKey = encodeShareKey(generateShareKey())
  await page.goto(`/share/view?c=${SHARE_CODE}#k=${encodedKey}`, {
    waitUntil: "domcontentloaded",
  })
  await expect(page.getByRole("heading", { name: "This link is no longer available" })).toBeVisible(
    { timeout: 20_000 }
  )
}

test.describe("public share quality gates", () => {
  test("@a11y unavailable share has named controls, landmarks, and keyboard navigation", async ({
    page,
  }) => {
    await openUnavailableShare(page)

    await expect(page.getByRole("main")).toBeVisible()
    await expect(page.getByRole("banner")).toBeVisible()
    await expect(
      page.getByRole("contentinfo").filter({ hasText: "Shared via cognia" })
    ).toBeVisible()
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1)

    const unnamedInteractiveElements = await page
      .locator("a[href], button, input, select, textarea")
      .evaluateAll((elements) =>
        elements.flatMap((element, index) => {
          const control = element as HTMLElement
          if (control.hidden || control.getAttribute("aria-hidden") === "true") return []

          const ariaLabel = control.getAttribute("aria-label")?.trim()
          const labelledBy = control.getAttribute("aria-labelledby")
          const labelledText = labelledBy
            ?.split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
            .join(" ")
            .trim()
          const nativeLabels =
            control instanceof HTMLInputElement ||
            control instanceof HTMLSelectElement ||
            control instanceof HTMLTextAreaElement
              ? [...(control.labels ?? [])]
                  .map((label) => label.textContent?.trim() ?? "")
                  .join(" ")
                  .trim()
              : ""
          const visibleText = control.textContent?.trim()
          const title = control.getAttribute("title")?.trim()

          return ariaLabel || labelledText || nativeLabels || visibleText || title
            ? []
            : [`${control.tagName.toLowerCase()}[${index}]`]
        })
      )

    expect(unnamedInteractiveElements).toEqual([])

    const brandLink = page.getByRole("banner").getByRole("link")
    for (let step = 0; step < 50; step += 1) {
      await page.keyboard.press("Tab")
      if (await brandLink.evaluate((element) => element === document.activeElement)) break
    }
    await expect(brandLink).toBeFocused()
  })

  test("@visual unavailable share keeps the anonymous viewer layout stable", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await openUnavailableShare(page)

    await expect(page.getByRole("main")).toHaveScreenshot("public-share-unavailable.png", {
      animations: "disabled",
      caret: "hide",
      maxDiffPixelRatio: 0.02,
    })
  })
})
