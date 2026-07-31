/**
 * E2E: public zero-knowledge share viewer (ADR-0037).
 *
 * Contract: an anonymous browser fetches only the opaque envelope by public
 * code, decrypts it with the URL-fragment key, and renders the payload. The
 * key must never appear in the HTTP request. Passphrase and unavailable-link
 * branches are part of the same recipient-facing contract.
 */

import { expect, test, type Page } from "@/tests/e2e/fixtures/test"
import { encryptSharePayload } from "@/lib/share/crypto"
import { encodeShareKey, generateShareKey } from "@/lib/share/keys"
import type { ShareEnvelopeV1, SharePayload } from "@/lib/share/types"
import { resetCogniaDb, setCogniaSettings } from "../helpers/db-reset"

const SHARE_CODE = "e2e-public-share"
const SHARE_TEXT = "decrypted public share e2e marker"

const PAYLOAD: SharePayload = {
  kind: "chat-text",
  mime: "text/plain",
  data: SHARE_TEXT,
  encoding: "utf8",
  title: "E2E Public Share",
}

async function prepareViewer(page: Page): Promise<void> {
  await page.goto("/")
  await resetCogniaDb(page)
  await setCogniaSettings(page, { shareUrl: new URL(page.url()).origin })
}

async function encryptedFixture(passphrase?: string): Promise<{
  envelope: ShareEnvelopeV1
  encodedKey: string
}> {
  const key = generateShareKey()
  return {
    envelope: await encryptSharePayload(PAYLOAD, key, passphrase),
    encodedKey: encodeShareKey(key),
  }
}

async function serveEnvelope(page: Page, envelope: ShareEnvelopeV1): Promise<() => string | null> {
  let requestedUrl: string | null = null
  await page.route(`**/v1/share/${SHARE_CODE}`, async (route) => {
    requestedUrl = route.request().url()
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ envelope }),
    })
  })
  return () => requestedUrl
}

test.describe("public share viewer", () => {
  test.beforeEach(async ({ page }) => {
    await prepareViewer(page)
  })

  test("@smoke @critical keeps the fragment key local and renders the payload", async ({
    page,
  }) => {
    const { envelope, encodedKey } = await encryptedFixture()
    const requestedUrl = await serveEnvelope(page, envelope)

    await page.goto(`/share/view?c=${SHARE_CODE}#k=${encodedKey}`, {
      waitUntil: "domcontentloaded",
    })

    await expect(page.getByText(SHARE_TEXT)).toBeVisible({ timeout: 20_000 })
    await expect(page).toHaveTitle("E2E Public Share · cognia")

    expect(requestedUrl()).not.toBeNull()
    expect(new URL(requestedUrl()!).hash).toBe("")
    expect(requestedUrl()).not.toContain(encodedKey)
  })

  test("requires the out-of-band passphrase and recovers after a wrong attempt", async ({
    page,
  }) => {
    const passphrase = "correct horse battery staple"
    const { envelope, encodedKey } = await encryptedFixture(passphrase)
    await serveEnvelope(page, envelope)

    await page.goto(`/share/view?c=${SHARE_CODE}#k=${encodedKey}`, {
      waitUntil: "domcontentloaded",
    })

    const input = page.getByRole("textbox", { name: "Passphrase" })
    await expect(input).toBeVisible({ timeout: 20_000 })
    await input.fill("wrong passphrase")
    await page.getByRole("button", { name: "Unlock" }).click()
    await expect(page.getByText(/passphrase didn.t work/i)).toBeVisible({ timeout: 20_000 })

    await input.fill(passphrase)
    await page.getByRole("button", { name: "Unlock" }).click()
    await expect(page.getByText(SHARE_TEXT)).toBeVisible({ timeout: 20_000 })
  })

  test("shows the unavailable state when the share was expired, burned, or revoked", async ({
    page,
  }) => {
    const { encodedKey } = await encryptedFixture()
    await page.route(`**/v1/share/${SHARE_CODE}`, async (route) => {
      await route.fulfill({ status: 404, contentType: "application/json", body: "{}" })
    })

    await page.goto(`/share/view?c=${SHARE_CODE}#k=${encodedKey}`, {
      waitUntil: "domcontentloaded",
    })

    await expect(
      page.getByRole("heading", { name: "This link is no longer available" })
    ).toBeVisible({ timeout: 20_000 })
  })
})
