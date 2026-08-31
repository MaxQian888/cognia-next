import { expect, test } from "@/tests/e2e/fixtures/test"

import { startExternalServiceFixture } from "../fixtures/external-service-site/server"

let origin = ""
let closeFixture: (() => Promise<void>) | undefined

test.beforeAll(async () => {
  const fixture = await startExternalServiceFixture()
  origin = fixture.origin
  closeFixture = fixture.close
})

test.afterAll(async () => {
  await closeFixture?.()
})

test("covers takeover login, forms, dynamic DOM, iframe, upload, download, and drift", async ({
  page,
}) => {
  await page.goto(origin)
  await expect(page.locator("body")).toHaveAttribute("data-readiness", "fixture-v1")
  await expect(page.getByLabel("Password")).toHaveAttribute("autocomplete", "current-password")
  await page.getByLabel("Email").fill("human@example.test")
  await page.getByLabel("Password").fill("human-only")
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page).toHaveURL(`${origin}/dashboard`)

  await page.getByLabel("Title").fill("Reviewed write")
  await page.getByRole("button", { name: "Load dynamic content" }).click()
  await expect(page.getByText("Dynamic content ready")).toBeVisible()

  const frame = page.frameLocator('iframe[title="Embedded editor"]')
  await frame.getByLabel("Frame note").fill("inside iframe")
  await frame.getByRole("button", { name: "Save frame" }).click()

  await page.getByLabel("Attachment").setInputFiles({
    name: "review.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("authorized upload"),
  })
  const downloadPromise = page.waitForEvent("download")
  await page.getByRole("link", { name: "Download fixture" }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe("fixture.txt")

  await page.goto(`${origin}/changed`)
  await expect(page.locator("body")).not.toHaveAttribute("data-readiness", "fixture-v1")
})
