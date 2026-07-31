/**
 * Playwright helper: drop Dexie tables + storage between tests.
 *
 * The implementation relies on the dev-only bridge in
 * `lib/dev/expose-test-globals.tsx`, which hangs `__cogniaResetDb` off
 * `window` when the dev server boots with `NEXT_PUBLIC_E2E=1`. The
 * Playwright config injects that env var automatically; if you run a dev
 * server yourself, export `NEXT_PUBLIC_E2E=1` first.
 *
 * Pattern in a spec:
 *   test.beforeEach(async ({ page }) => {
 *     await page.goto("/")
 *     await resetCogniaDb(page)
 *   })
 *
 * `resetCogniaDb` waits for the bridge to mount before invoking, so callers
 * never race the initializer.
 */

import { expect, type Page } from "@playwright/test"

const E2E_ACCOUNT_ID = "acct_e2e_seed_account"
const ACCOUNT_REGISTRY_DB_NAME = "cognia-account-registry"

declare global {
  interface Window {
    __cogniaResetDb?: () => Promise<void>
    __cogniaTestGlobalsReady?: boolean
    __cogniaPluginRuntimeReady?: boolean
  }
}

export async function waitForTestGlobals(page: Page, timeoutMs = 10_000): Promise<void> {
  for (let recoveryAttempt = 0; recoveryAttempt <= 1; recoveryAttempt += 1) {
    const stateHandle = await page.waitForFunction(
      () => {
        if ((window as { __cogniaTestGlobalsReady?: boolean }).__cogniaTestGlobalsReady) {
          return "ready"
        }
        if (document.querySelector('[data-testid="db-upgrade-blocked-dialog"]')) {
          return "blocked"
        }
        return false
      },
      undefined,
      { timeout: timeoutMs }
    )
    const state = await stateHandle.jsonValue()
    if (state === "ready") return

    if (recoveryAttempt === 1) {
      throw new Error("Database upgrade stayed blocked after the prescribed reload")
    }
    await page.getByTestId("db-upgrade-blocked-reload").click()
    await page.waitForLoadState("domcontentloaded")
  }
}

/**
 * Wait until plugin discovery, core seeding, and any dynamic Dexie schema
 * restoration have settled. Chat E2E must not start a turn while that boot
 * transaction is still closing/reopening the active account database.
 */
export async function waitForPluginRuntimeReady(page: Page, timeoutMs = 30_000): Promise<void> {
  await page.waitForFunction(
    () => Boolean((window as { __cogniaPluginRuntimeReady?: boolean }).__cogniaPluginRuntimeReady),
    undefined,
    { timeout: timeoutMs }
  )

  // A first-ever database boot can finish the requested plugin schema upgrade
  // just after the bounded blocked-connection warning has already opened its
  // recovery dialog. The prescribed Reload is required to clear that modal and
  // reopen every consumer on the now-current schema before a chat turn starts.
  const blockedDialog = page.getByTestId("db-upgrade-blocked-dialog")
  const blocked = await blockedDialog
    // The schema retry loop gives other holders ~15 s to yield. Wait through
    // that complete window so a slow, contended boot cannot surface the modal
    // after this helper has already released a chat test.
    .waitFor({ state: "visible", timeout: 17_000 })
    .then(() => true)
    .catch(() => false)
  if (blocked) {
    await page.getByTestId("db-upgrade-blocked-reload").click()
    await page.waitForLoadState("domcontentloaded")
    await waitForTestGlobals(page, timeoutMs)
    await page.waitForFunction(
      () =>
        Boolean((window as { __cogniaPluginRuntimeReady?: boolean }).__cogniaPluginRuntimeReady),
      undefined,
      { timeout: timeoutMs }
    )
    await expect(blockedDialog).toBeHidden({ timeout: timeoutMs })
  }
}

/**
 * Seed an unlocked local account so `AccountGate` renders the app (and thus the
 * `window.__cognia*` test bridge) in a plain browser.
 *
 * Why this is needed: the app is gated behind `<AccountGate>`, which renders a
 * first-run "create account" form until an account exists and is unlocked.
 * Normal account creation calls `createPasswordVerifier` → Tauri
 * `invoke("account_password_create_verifier")`, which does NOT exist in a
 * browser (chromium / mobile Playwright projects), so the gate can never be
 * satisfied through the UI and the whole app — including `ExposeTestGlobals` —
 * never mounts.
 *
 * We sidestep Tauri entirely by writing an account straight through
 * `LocalAccountRegistry.createAccount` (which takes the password verifier as
 * input and never touches Tauri) with a stub verifier and pointing the registry
 * at it. Dev builds then auto-unlock that active account on the next load (see
 * `lib/accounts/dev-auto-unlock.ts`), so `AccountGate` never prompts.
 * Test-infra only — no product code changes, and `isTauri()` is left false so
 * the app stays in web/mobile mode.
 */
export async function ensureCogniaAccount(page: Page): Promise<string> {
  // React can paint the onboarding route before AccountStoreInitializer's
  // effect finishes the Dexie v1 upgrade. Opening the registry in that window
  // creates/observes an empty database. Poll the schema and perform the seed
  // through the SAME connection so there is no check-then-open race.
  await page.waitForFunction(
    async ({ accountId, databaseName }) => {
      const exists = (await indexedDB.databases()).some((info) => info.name === databaseName)
      if (!exists) return false

      const seeded = await new Promise<boolean>((resolve) => {
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
            displayName: "E2E",
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
      return seeded
    },
    { accountId: E2E_ACCOUNT_ID, databaseName: ACCOUNT_REGISTRY_DB_NAME },
    { timeout: 15_000 }
  )

  return E2E_ACCOUNT_ID
}

/**
 * Bootstrap mobile past the runtime-mode chooser before the in-app bridge is
 * available. AccountGate mounts first, while `ExposeTestGlobals` lives inside
 * the gated app; after seeding an account, a mobile reload can therefore stop
 * at `/welcome` before tests get a chance to call `setCogniaSettings`.
 *
 * Write the smallest valid settings singleton directly into whichever Cognia
 * app DB is active. The exported bootstrap below deliberately does not wait
 * for the heavier dev bridge, so queue/boot specs can stay independent from
 * dynamic plugin-table upgrades.
 */
async function installMobileBootstrapMode(
  page: Page,
  mode: "standalone" | "paired",
  settingsPatch: Record<string, unknown> = {}
): Promise<void> {
  await page.addInitScript(
    (bootstrapSettings) => {
      const bootstrapKey = "cognia-e2e-mobile-bootstrap-mode"
      const bootstrapSignature = JSON.stringify(bootstrapSettings)
      try {
        if (window.sessionStorage.getItem(bootstrapKey) === bootstrapSignature) {
          ;(
            window as unknown as { __cogniaMobileBootstrapReady?: boolean }
          ).__cogniaMobileBootstrapReady = true
          return
        }
      } catch {
        // about:blank has an opaque origin; continue on the next app document.
      }
      void (async () => {
        for (let attempt = 0; attempt < 200; attempt += 1) {
          try {
            const databases = await indexedDB.databases()
            const candidateNames = databases
              .map((info) => info.name)
              .filter((name): name is string => Boolean(name?.startsWith("cognia-")))
            for (const candidateName of candidateNames) {
              const seeded = await new Promise<boolean>((resolve) => {
                const req = indexedDB.open(candidateName)
                req.onerror = () => resolve(false)
                req.onsuccess = () => {
                  const db = req.result
                  if (!db.objectStoreNames.contains("settings")) {
                    db.close()
                    resolve(false)
                    return
                  }
                  const tx = db.transaction("settings", "readwrite")
                  const store = tx.objectStore("settings")
                  const get = store.get("singleton")
                  get.onerror = () => {
                    db.close()
                    resolve(false)
                  }
                  get.onsuccess = () => {
                    store.put({
                      ...(get.result ?? {}),
                      id: "singleton",
                      ...bootstrapSettings,
                    })
                  }
                  tx.oncomplete = () => {
                    db.close()
                    resolve(true)
                  }
                  tx.onerror = () => {
                    db.close()
                    resolve(false)
                  }
                }
              })
              if (seeded) {
                window.sessionStorage.setItem(bootstrapKey, bootstrapSignature)
                ;(
                  window as unknown as { __cogniaMobileBootstrapReady?: boolean }
                ).__cogniaMobileBootstrapReady = true
                return
              }
            }
          } catch {
            // about:blank has an opaque origin; the script runs again on the
            // next real app document where IndexedDB is available.
          }
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
      })()
    },
    { ...settingsPatch, mobileRuntimeMode: mode }
  )
}

/**
 * Mobile-only bootstrap that does not depend on `ExposeTestGlobals`.
 * Useful for specs whose subject is the mobile boot/queue path itself: it
 * seeds the account + runtime mode before the gated bridge can mount, then
 * returns on the real app route. Each Playwright test gets a fresh context,
 * so callers can use this instead of deleting an already-open Dexie database.
 */
export async function bootstrapCogniaMobile(
  page: Page,
  mode: "standalone" | "paired",
  settingsPatch: Record<string, unknown> = {}
): Promise<void> {
  await ensureCogniaAccount(page)
  await installMobileBootstrapMode(page, mode, settingsPatch)
  const appUrl = new URL("/", page.url()).toString()
  const welcomeUrl = new URL("/welcome", page.url()).toString()
  await page.goto("about:blank")
  await page.goto(welcomeUrl, { waitUntil: "domcontentloaded" })
  await page.waitForFunction(
    () =>
      Boolean(
        (window as unknown as { __cogniaMobileBootstrapReady?: boolean })
          .__cogniaMobileBootstrapReady
      ),
    undefined,
    { timeout: 15_000 }
  )
  await page.goto("about:blank")
  await page.goto(appUrl, { waitUntil: "domcontentloaded" })
}

/**
 * Ensure the gated app has mounted its test-globals bridge. If it hasn't (the
 * AccountGate is blocking in a browser), seed an unlocked account and reload so
 * the gate passes. Idempotent — a no-op once the bridge is present.
 */
async function ensureAppMounted(page: Page): Promise<void> {
  const present = await page.evaluate(
    () => typeof (window as { __cogniaResetDb?: unknown }).__cogniaResetDb === "function"
  )
  if (present) return
  await ensureCogniaAccount(page)
  // Re-boot through about:blank instead of page.reload(): a reload can leave
  // the OLD document (and its IndexedDB connections) alive long enough to
  // block the new boot's dynamic plugin-table schema bump — the console shows
  // "Upgrade 'cognia-claude' blocked by other connection holding version N"
  // and the test-globals bridge, whose wiring awaits that open, either takes
  // 10s+ or never signals ready. Navigating to about:blank tears the old
  // document down first; measured boot-to-ready drops to ~2s and stops
  // flaking. (The underlying looseness — a schema upgrade that anything
  // holding a connection can veto — is recorded as a product-side fix
  // candidate in docs/plans/2026-07-16-e2e-suite-revival.md §7.)
  const url = page.url()
  await page.goto("about:blank")
  await page.goto(url, { waitUntil: "domcontentloaded" })
  await waitForTestGlobals(page, 30_000)
}

export async function resetCogniaDb(page: Page): Promise<void> {
  await ensureAppMounted(page)
  await waitForTestGlobals(page)
  const ok = await page.evaluate(async () => {
    const w = window as Window & {
      __cogniaResetDb?: () => Promise<void>
    }
    if (typeof w.__cogniaResetDb !== "function") return false
    await w.__cogniaResetDb()
    return true
  })
  expect(ok, "window.__cogniaResetDb should be callable").toBe(true)
}

/**
 * Patch the AppSettings singleton through the in-bundle settings store.
 *
 * Mobile specs MUST call this with `{ mobileRuntimeMode: "standalone" }` (or
 * `"paired"`) after `resetCogniaDb`: the reset wipes the settings row, and on
 * the Capacitor shell an unset runtime mode makes CompanionBootProvider bounce
 * the next navigation to the /welcome onboarding chooser — historically the
 * reason several mobile specs silently skipped (their target route never
 * rendered). Also the seam for policy toggles like `biometricRequiredFor`.
 */
export async function setCogniaSettings(page: Page, patch: Record<string, unknown>): Promise<void> {
  await waitForTestGlobals(page)
  const ok = await page.evaluate(async (p) => {
    const w = window as Window & {
      __cogniaSetSettings?: (patch: Record<string, unknown>) => Promise<void>
    }
    if (typeof w.__cogniaSetSettings !== "function") return false
    await w.__cogniaSetSettings(p)
    return true
  }, patch)
  expect(ok, "window.__cogniaSetSettings should be callable").toBe(true)
}

/**
 * Read one row from a Dexie table via raw IndexedDB.
 *
 * Raw because `import("@/lib/db/schema")` inside `page.evaluate` can never
 * resolve — the `@/` specifier only exists at bundle time, so evaluate-side
 * dynamic imports of app modules throw in the browser. (Several older specs
 * did exactly that and never actually executed their assertion path.) The
 * connection closes immediately and yields on `versionchange` so it can't
 * wedge the app's own plugin-table schema upgrades.
 */
export async function readDexieRow<T>(
  page: Page,
  opts: { db?: string; table: string; key: string }
): Promise<T | undefined> {
  return (await page.evaluate(async ({ db, table, key }) => {
    const names = db
      ? [db]
      : (await indexedDB.databases())
          .map((info) => info.name)
          .filter((name): name is string => Boolean(name))
          .sort(
            (a, b) =>
              Number(b.startsWith("cognia-account-")) - Number(a.startsWith("cognia-account-"))
          )

    for (const name of names) {
      const row = await new Promise<unknown>((resolve, reject) => {
        const req = indexedDB.open(name)
        req.onerror = () => reject(req.error)
        req.onsuccess = () => {
          const conn = req.result
          conn.onversionchange = () => conn.close()
          if (!conn.objectStoreNames.contains(table)) {
            conn.close()
            resolve(undefined)
            return
          }
          const tx = conn.transaction(table, "readonly")
          const get = tx.objectStore(table).get(key)
          get.onsuccess = () => {
            conn.close()
            resolve(get.result)
          }
          get.onerror = () => {
            conn.close()
            reject(get.error)
          }
        }
      })
      if (row !== undefined) return row
    }
    return undefined
  }, opts)) as T | undefined
}

/** Read every row from the first active Dexie database that owns `table`. */
export async function readDexieRows<T>(
  page: Page,
  opts: { db?: string; table: string }
): Promise<T[]> {
  return (await page.evaluate(async ({ db, table }) => {
    const names = db
      ? [db]
      : (await indexedDB.databases())
          .map((info) => info.name)
          .filter((name): name is string => Boolean(name))
          .sort(
            (a, b) =>
              Number(b.startsWith("cognia-account-")) - Number(a.startsWith("cognia-account-"))
          )

    for (const name of names) {
      const rows = await new Promise<unknown[] | undefined>((resolve, reject) => {
        const req = indexedDB.open(name)
        req.onerror = () => reject(req.error)
        req.onsuccess = () => {
          const conn = req.result
          conn.onversionchange = () => conn.close()
          if (!conn.objectStoreNames.contains(table)) {
            conn.close()
            resolve(undefined)
            return
          }
          const tx = conn.transaction(table, "readonly")
          const get = tx.objectStore(table).getAll()
          get.onsuccess = () => {
            conn.close()
            resolve(get.result)
          }
          get.onerror = () => {
            conn.close()
            reject(get.error)
          }
        }
      })
      if (rows !== undefined) return rows
    }
    return []
  }, opts)) as T[]
}
