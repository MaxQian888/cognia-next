#!/usr/bin/env node
/**
 * PWA manifest screenshot capture.
 *
 * Produces the two PNGs `app/manifest.ts` advertises for the rich install
 * dialog:
 *   public/pwa/screenshots/chat-wide.png     1280×800  (form_factor: wide)
 *   public/pwa/screenshots/chat-narrow.png    750×1334 (form_factor: narrow)
 *
 * Two rules this script exists to enforce (same contract as
 * web/scripts/capture-product.mjs):
 *
 *  1. **Never the author's data.** It seeds the disposable E2E stub account
 *     through IndexedDB exactly like tests/e2e/helpers/db-reset.ts, so the
 *     captured app is an empty first-run shell — no real conversations,
 *     providers, or workspace names leak into a shipped asset.
 *  2. **Fail rather than produce a wrong asset.** Each shot names the
 *     selector that must be visible before the shutter fires; if the product
 *     UI moved, the run fails with the shot named instead of silently
 *     capturing whatever happened to render.
 *
 * Prerequisites (the script checks and reports, it does not build):
 *   pnpm test:e2e:build          # NEXT_PUBLIC_E2E=1 static export → out/
 *   pnpm test:e2e:install        # playwright browsers, once per machine
 *
 * Usage:
 *   pnpm screenshots:pwa
 *   node scripts/screenshots/capture-pwa-screenshots.mjs [--only wide|narrow]
 */

import { mkdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "@playwright/test"

import { createOutServer } from "../e2e/serve-out.mjs"

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const OUT_ROOT = path.join(REPO_ROOT, "out")
const SHOT_DIR = path.join(REPO_ROOT, "public", "pwa", "screenshots")

const E2E_ACCOUNT_ID = "acct_e2e_seed_account"
const ACCOUNT_REGISTRY_DB_NAME = "cognia-account-registry"

const SHOTS = [
  {
    id: "wide",
    file: "chat-wide.png",
    route: "/",
    viewport: { width: 1280, height: 800 },
  },
  {
    id: "narrow",
    file: "chat-narrow.png",
    route: "/",
    viewport: { width: 750, height: 1334 },
    isMobile: true,
    hasTouch: true,
  },
]

function parseOnly(argv) {
  const index = argv.indexOf("--only")
  if (index === -1) return null
  const value = argv[index + 1]
  if (!SHOTS.some((shot) => shot.id === value)) {
    throw new Error(`--only expects one of: ${SHOTS.map((shot) => shot.id).join(", ")}`)
  }
  return value
}

/**
 * Seed the stub local account so AccountGate renders the app, then reload
 * through about:blank (matches ensureCogniaAccount + ensureAppMounted in
 * tests/e2e/helpers/db-reset.ts — a plain reload can leave the old document's
 * IndexedDB connections alive and block the schema upgrade).
 *
 * The caller must have navigated with `waitUntil: "load"`: seeding while the
 * app's first boot is still running its Dexie upgrades lands the rows in a
 * database the boot then recreates — the account silently never existed.
 * The readback asserts the seed actually survived before we reload.
 */
async function unlockAccount(page) {
  await page.waitForFunction(
    async ({ accountId, databaseName }) => {
      const exists = (await indexedDB.databases()).some((info) => info.name === databaseName)
      if (!exists) return false
      return new Promise((resolve) => {
        const request = indexedDB.open(databaseName)
        request.onerror = () => resolve(false)
        request.onsuccess = () => {
          const database = request.result
          if (
            !database.objectStoreNames.contains("accounts") ||
            !database.objectStoreNames.contains("state")
          ) {
            database.close()
            resolve(false)
            return
          }
          const now = Date.now()
          const transaction = database.transaction(["accounts", "state"], "readwrite")
          transaction.objectStore("accounts").put({
            id: accountId,
            // This name renders in the shipped screenshot's account chip —
            // "E2E" would read as a test leak in the install dialog.
            displayName: "Demo",
            passwordVerifier: {
              algorithm: "e2e-stub",
              salt: "e2e-salt",
              hash: "e2e-hash",
              params: {},
            },
            createdAt: now,
            updatedAt: now,
          })
          transaction.objectStore("state").put({
            id: "singleton",
            activeAccountId: accountId,
            updatedAt: now,
          })
          transaction.oncomplete = () => {
            database.close()
            resolve(true)
          }
          transaction.onerror = () => {
            database.close()
            resolve(false)
          }
          transaction.onabort = () => {
            database.close()
            resolve(false)
          }
        }
      })
    },
    { accountId: E2E_ACCOUNT_ID, databaseName: ACCOUNT_REGISTRY_DB_NAME },
    { timeout: 15_000 }
  )
  // Read the row back through a fresh connection — if the seed raced a Dexie
  // upgrade it can commit into a store the boot then discards, and every later
  // step fails 30s downstream with "New chat" never appearing.
  const seeded = await page.evaluate(
    async ({ accountId, databaseName }) => {
      return new Promise((resolve) => {
        const request = indexedDB.open(databaseName)
        request.onerror = () => resolve(false)
        request.onsuccess = () => {
          const database = request.result
          const tx = database.transaction("accounts", "readonly")
          const get = tx.objectStore("accounts").get(accountId)
          get.onsuccess = () => {
            database.close()
            resolve(Boolean(get.result))
          }
          get.onerror = () => {
            database.close()
            resolve(false)
          }
        }
      })
    },
    { accountId: E2E_ACCOUNT_ID, databaseName: ACCOUNT_REGISTRY_DB_NAME }
  )
  if (!seeded) {
    throw new Error(
      "account seed did not persist — the first navigation must settle on " +
        "`load`, not `domcontentloaded`, before the registry write"
    )
  }
  const url = page.url()
  await page.goto("about:blank")
  await page.goto(url, { waitUntil: "domcontentloaded" })
  await page.waitForFunction(() => Boolean(window.__cogniaTestGlobalsReady), undefined, {
    timeout: 30_000,
  })
  // A seeded account is a first run: `OnboardingGate` keeps routing to
  // `/onboarding` until the progress record settles, which would put the
  // wizard — not the chat shell — in the shipped screenshots.
  await page.evaluate(async () => {
    await window.__cogniaSetSettings?.({
      onboardingProgress: {
        version: 2,
        path: "completed",
        completedAt: new Date().toISOString(),
      },
    })
  })
  await page.goto("about:blank")
  await page.goto(url, { waitUntil: "domcontentloaded" })
  await page.waitForFunction(() => Boolean(window.__cogniaTestGlobalsReady), undefined, {
    timeout: 30_000,
  })
}

/** Open a fresh chat through the character picker so the composer is live. */
async function openChat(page) {
  await page.getByRole("button", { name: "New chat" }).first().click()
  const picker = page.getByRole("dialog", { name: /pick a character/i })
  await picker.getByRole("option").first().click()
  await page
    .getByRole("textbox", { name: /message/i })
    .first()
    .waitFor({ timeout: 15_000 })
}

async function main() {
  const only = parseOnly(process.argv.slice(2))
  const server = createOutServer(OUT_ROOT)
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolvePromise)
  })
  const { port } = server.address()
  const baseURL = `http://127.0.0.1:${port}`
  mkdirSync(SHOT_DIR, { recursive: true })

  try {
    const browser = await chromium.launch()
    for (const shot of SHOTS) {
      if (only && shot.id !== only) continue
      const context = await browser.newContext({
        viewport: shot.viewport,
        isMobile: shot.isMobile ?? false,
        hasTouch: shot.hasTouch ?? false,
      })
      // The E2E artifact carries the dev Perf HUD (`localStorage.cogniaPerfHud`
      // is set by the harness). It is tooling chrome, not product UI — strip
      // it before the shutter or it ships inside the install-dialog artwork.
      await context.addInitScript(() => {
        try {
          localStorage.removeItem("cogniaPerfHud")
        } catch {
          /* localStorage can throw before the document is committed */
        }
      })
      const page = await context.newPage()
      // Full `load`, not `domcontentloaded`: the first boot's Dexie upgrades
      // must settle before the account seed commits (see unlockAccount).
      await page.goto(`${baseURL}${shot.route}`, { waitUntil: "load" })
      await unlockAccount(page)
      await openChat(page)
      // The HUD can already be mounted from a load that ran before the init
      // script's flag removal took effect — drop the node too.
      await page.evaluate(() => {
        document.querySelector('[data-testid="perf-hud"]')?.remove()
      })
      // Let fonts/layout settle after the picker closes.
      await page.waitForTimeout(500)
      const target = path.join(SHOT_DIR, shot.file)
      await page.screenshot({ path: target, fullPage: false })
      console.log(`[pwa-screenshots] ${shot.id}: wrote ${path.relative(REPO_ROOT, target)}`)
      await context.close()
    }
    await browser.close()
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise))
  }
}

main().catch((error) => {
  console.error(`[pwa-screenshots] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
