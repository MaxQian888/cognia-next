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

declare global {
  interface Window {
    __cogniaResetDb?: () => Promise<void>
    __cogniaTestGlobalsReady?: boolean
  }
}

export async function waitForTestGlobals(page: Page, timeoutMs = 10_000): Promise<void> {
  await page.waitForFunction(
    () => Boolean((window as { __cogniaTestGlobalsReady?: boolean }).__cogniaTestGlobalsReady),
    undefined,
    { timeout: timeoutMs }
  )
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
 * input and never touches Tauri) with a stub verifier, then marking it
 * dev-unlocked (sessionStorage) so `AccountGate` treats it as unlocked on the
 * next load. Test-infra only — no product code changes, and `isTauri()` is left
 * false so the app stays in web/mobile mode.
 */
export async function ensureCogniaAccount(page: Page): Promise<void> {
  // Seed straight into the account-registry IndexedDB (`cognia-account-registry`,
  // created by Dexie at app boot — it exists even with zero accounts because the
  // store writes a `state` singleton). We open it raw (no version → current) and
  // `put` an account + active pointer, then mark it dev-unlocked. This avoids
  // both Tauri (`createPasswordVerifier`) AND `@/`-aliased imports, which don't
  // resolve in raw `page.evaluate` (only in-bundle bridge fns can import them).
  await page.evaluate(async () => {
    const ACCOUNT_ID = "acct_e2e_seed_account"
    const STATE_ID = "singleton"
    const now = Date.now()
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open("cognia-account-registry")
      req.onerror = () => reject(req.error)
      req.onsuccess = () => {
        const db = req.result
        if (!db.objectStoreNames.contains("accounts") || !db.objectStoreNames.contains("state")) {
          db.close()
          reject(new Error("account-registry stores missing — app not booted yet"))
          return
        }
        const tx = db.transaction(["accounts", "state"], "readwrite")
        tx.objectStore("accounts").put({
          id: ACCOUNT_ID,
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
        tx.objectStore("state").put({ id: STATE_ID, activeAccountId: ACCOUNT_ID, updatedAt: now })
        tx.oncomplete = () => {
          db.close()
          resolve()
        }
        tx.onerror = () => reject(tx.error)
      }
    })
    // Dev-unlock marker (sessionStorage) so AccountGate treats it as unlocked.
    window.sessionStorage.setItem("cognia-dev-unlocked-account", ACCOUNT_ID)
  })
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
  return (await page.evaluate(async ({ db = "cognia-claude", table, key }) => {
    return await new Promise((resolve, reject) => {
      const req = indexedDB.open(db)
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
  }, opts)) as T | undefined
}
