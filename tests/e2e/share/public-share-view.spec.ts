/**
 * E2E: public zero-knowledge share viewer (ADR-0037).
 *
 * Contract: an anonymous browser fetches only the opaque envelope by public
 * code, decrypts it with the URL-fragment key, and renders the payload. The
 * key must never appear in the HTTP request. Passphrase and unavailable-link
 * branches are part of the same recipient-facing contract.
 *
 * The first block seeds an account and a same-origin `shareUrl` first, which is
 * the owner's in-app copy of the route. "anonymous visitor" seeds nothing: the
 * link is the first thing the browser ever loads, as on the public deployment
 * (ADR-0037, "The anonymous visitor").
 */

import { expect, test, type Page } from "@/tests/e2e/fixtures/test"
import { encryptSharePayload } from "@/lib/share/crypto"
import { encodeShareKey, generateShareKey } from "@/lib/share/keys"
import type { ShareEnvelopeV1, SharePayload } from "@/lib/share/types"
import { resetCogniaDb, setCogniaSettings } from "../helpers/db-reset"

const SHARE_CODE = "e2e-public-share"
const SHARE_TEXT = "decrypted public share e2e marker"

/**
 * The static export has shipped account semantics (`NODE_ENV=production`): a
 * fresh browser has no account at all. The dev server instead provisions a
 * disposable one in every fresh profile (`lib/accounts/dev-auto-unlock.ts`), so
 * there the "visitor" is the owner and the guest-only assertions do not apply.
 * CI runs the suite against the export.
 */
const SHIPPED_ACCOUNT_SEMANTICS = process.env.PLAYWRIGHT_STATIC === "1"

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

/**
 * Answer the envelope read wherever it is sent. The seeded viewer reads its
 * own origin; a visitor with no settings reads the build-time endpoint, which
 * is another origin, so the reply carries the same `*` CORS header the real
 * Worker does.
 */
async function serveEnvelopeReads(page: Page, envelope: ShareEnvelopeV1): Promise<string[]> {
  const requestedUrls: string[] = []
  await page.route(`**/v1/share/${SHARE_CODE}`, async (route) => {
    requestedUrls.push(route.request().url())
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({ envelope }),
    })
  })
  return requestedUrls
}

async function serveEnvelope(page: Page, envelope: ShareEnvelopeV1): Promise<() => string | null> {
  const requestedUrls = await serveEnvelopeReads(page, envelope)
  return () => requestedUrls.at(-1) ?? null
}

/** IndexedDB databases that exist in this browser profile. */
async function databaseNames(page: Page): Promise<string[]> {
  return page.evaluate(async () =>
    (await indexedDB.databases()).map((db) => db.name ?? "").filter(Boolean)
  )
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

test.describe("anonymous visitor (no local account)", () => {
  // No `prepareViewer`: nothing is seeded, and the link is this browser's
  // first navigation. The regression this guards is the first-run form (and,
  // after it, the onboarding redirect that dropped `?c=…#k=…`) standing in
  // front of the share on the public deployment.

  test("@smoke @critical reads the link in a fresh browser without creating an account", async ({
    page,
  }) => {
    const { envelope, encodedKey } = await encryptedFixture()
    const requestedUrls = await serveEnvelopeReads(page, envelope)

    await page.goto(`/share/view?c=${SHARE_CODE}#k=${encodedKey}`, {
      waitUntil: "domcontentloaded",
    })

    await expect(page.getByText(SHARE_TEXT)).toBeVisible({ timeout: 30_000 })
    await expect(page).toHaveTitle("E2E Public Share · cognia")
    await expect(page.getByRole("heading", { name: "Create local account" })).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Create account" })).toHaveCount(0)

    // Still on the link, key and all: no hand-off to onboarding.
    const location = new URL(page.url())
    expect(location.pathname).toMatch(/^\/share\/view(?:\/|\.html)?$/)
    expect(location.searchParams.get("c")).toBe(SHARE_CODE)
    expect(location.hash).toBe(`#k=${encodedKey}`)

    expect(requestedUrls.length).toBeGreaterThan(0)
    for (const url of requestedUrls) {
      expect(new URL(url).hash).toBe("")
      expect(url).not.toContain(encodedKey)
    }
  })

  test("@critical renders as a guest: no account, no app database, one read", async ({ page }) => {
    test.skip(
      !SHIPPED_ACCOUNT_SEMANTICS,
      "the dev server provisions a disposable account in every fresh browser"
    )
    const { envelope, encodedKey } = await encryptedFixture()
    const requestedUrls = await serveEnvelopeReads(page, envelope)

    await page.goto(`/share/view?c=${SHARE_CODE}#k=${encodedKey}`, {
      waitUntil: "domcontentloaded",
    })

    await expect(page.getByTestId("share-guest-shell")).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText(SHARE_TEXT)).toBeVisible()

    // Each read counts a view, so a gate that switched shells after the first
    // fetch would spend a burn-after-read link on a re-render.
    expect(requestedUrls).toHaveLength(1)

    // The guest reads from the build-time endpoint, never the settings row: no
    // account database was opened, and neither was the legacy one `getDb()`
    // falls back to when no account is selected.
    const databases = await databaseNames(page)
    expect(databases).not.toContain("cognia-claude")
    expect(
      databases.filter(
        (name) => name.startsWith("cognia-account-") && name !== "cognia-account-registry"
      )
    ).toEqual([])
  })

  test("offers a guest no library to import into", async ({ page }) => {
    test.skip(
      !SHIPPED_ACCOUNT_SEMANTICS,
      "the dev server provisions a disposable account in every fresh browser"
    )
    const key = generateShareKey()
    const template: SharePayload = {
      kind: "chat-template",
      mime: "application/json",
      encoding: "utf8",
      title: "E2E Shared Template",
      data: JSON.stringify({
        kind: "chat-template",
        name: "E2E shared template",
        body: "Summarise {{topic}} in three bullets.",
        params: [{ id: "topic", label: "Topic", required: true, kind: "string" }],
      }),
    }
    await serveEnvelopeReads(page, await encryptSharePayload(template, key))

    await page.goto(`/share/view?c=${SHARE_CODE}#k=${encodeShareKey(key)}`, {
      waitUntil: "domcontentloaded",
    })

    await expect(page.getByTestId("share-chat-template")).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId("share-guest-shell")).toBeVisible()
    await expect(page.getByTestId("share-add-to-library")).toHaveCount(0)
  })
})
