/**
 * Open the signature task in a running E2E build of the product, ready to be
 * played stage by stage (ADR-0092, product footage amendment).
 *
 * Shared by `capture-product.mjs` (stills) and `record-product.mjs` (film), so
 * a screenshot and a film frame are the same seeded session in the same state.
 * The seams it drives — `__cogniaSetSettings`,
 * `__cogniaSeedStagedConversation`, `__cogniaAdvanceStage` — exist only when
 * the product was built with `NEXT_PUBLIC_E2E=1` (`pnpm test:e2e:build`, or
 * `pnpm dev` with the variable set); against any other build this fails with
 * the missing seam named rather than photographing whatever is on screen.
 */

import { buildDemoTranscript } from "./demo-transcript.mjs"

/** The chat surface the camera frames. Present in every chat layout. */
export const CHAT_SURFACE_SELECTOR = '[data-slot="chat-surface-stage"]'

/**
 * Chrome that belongs to the development server, not to the product: the
 * Next.js dev indicator and error overlay, and the render-performance HUD the
 * product mounts under `NODE_ENV=development`. Hidden so a recording taken
 * against `next dev` does not publish a framework badge or a profiler. A
 * static E2E export has neither.
 */
export const DEV_CHROME_CSS =
  'nextjs-portal, [data-testid="perf-hud"] { display: none !important; }'

/** The disposable account a demo session runs under. */
export const DEMO_ACCOUNT_ID = "acct_demo_workspace"
const ACCOUNT_REGISTRY_DB_NAME = "cognia-account-registry"

/**
 * The account name the sidebar footer shows in every frame. It says what the
 * workspace is, in the film's language.
 */
export function demoAccountName(locale) {
  if (locale === "en") return "Demo"
  if (locale === "zh") return "演示"
  throw new Error(`unsupported locale ${locale}`)
}

/** The product's own locale setting for a website locale. */
export function productLocale(locale) {
  if (locale === "en") return "en"
  if (locale === "zh") return "zh-CN"
  throw new Error(`unsupported locale ${locale}`)
}

/**
 * Get a fresh browser profile past the local-account gate.
 *
 * A `next dev` build opens its own development account; a static E2E export
 * stops at "Create local account", and its E2E auto-unlock opens whichever
 * account the registry names. This registers the demo account the same way
 * the E2E suite's `ensureAppMounted` does (`tests/e2e/helpers/db-reset.ts`),
 * re-boots through `about:blank` so the old document's database connections
 * cannot block the new boot's schema upgrade, and waits until the
 * account-owned runtime is ready.
 */
async function ensureDemoAccount(page, url, displayName) {
  const gate = page.getByRole("form", { name: "Create local account", exact: true })
  const deadline = Date.now() + 120_000
  let gated = false
  for (;;) {
    // `__cogniaTestGlobalsReady` is not the signal: the test bridge mounts
    // above the account gate and is ready while the gate still shows. The
    // plugin runtime is owned below the gate, so it proves the account is open.
    if (await page.evaluate(() => window.__cogniaPluginRuntimeReady === true)) break
    if (await gate.isVisible().catch(() => false)) {
      gated = true
      break
    }
    if (Date.now() > deadline) throw new Error("the app neither opened nor showed the account gate")
    await page.waitForTimeout(250)
  }
  if (gated) {
    const seeded = await page.evaluate(
      ({ accountId, databaseName, name }) =>
        new Promise((resolve) => {
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
            const tx = database.transaction(["accounts", "state"], "readwrite")
            tx.objectStore("accounts").put({
              id: accountId,
              displayName: name,
              passwordVerifier: {
                algorithm: "e2e-stub",
                salt: "e2e-salt",
                hash: "e2e-hash",
                params: {},
              },
              createdAt: now,
              updatedAt: now,
            })
            tx.objectStore("state").put({
              id: "singleton",
              activeAccountId: accountId,
              updatedAt: now,
            })
            tx.oncomplete = () => {
              database.close()
              resolve(true)
            }
            tx.onerror = tx.onabort = () => {
              database.close()
              resolve(false)
            }
          }
        }),
      { accountId: DEMO_ACCOUNT_ID, databaseName: ACCOUNT_REGISTRY_DB_NAME, name: displayName }
    )
    if (!seeded) throw new Error("could not register the demo account in the account registry")
    await page.goto("about:blank")
    await page.goto(url, { waitUntil: "domcontentloaded" })
  }
  await page.waitForFunction(
    () => window.__cogniaTestGlobalsReady === true && window.__cogniaPluginRuntimeReady === true,
    null,
    { timeout: 120_000 }
  )
}

/**
 * The settings a demo session runs under: the language and theme being filmed,
 * and first-run onboarding marked finished — the state of anyone past their
 * first launch, and the one the E2E suite's `resetCogniaDb` establishes.
 * Every other preference stays at the product's default, so the film shows
 * what a set-up install shows. (Tool cards open because each call arrives
 * running and then settles, as in a live turn — not because a display
 * preference was changed for the camera.)
 */
export function demoSettings(locale, theme) {
  return {
    language: productLocale(locale),
    theme,
    onboardingProgress: { version: 2, path: "completed", completedAt: ONBOARDED_AT },
  }
}

/** Fixed, so two recordings of the same cell do not differ by a timestamp. */
const ONBOARDED_AT = "2026-09-01T00:00:00.000Z"

/**
 * Load the app, apply locale and theme, seed the staged task and route to its
 * session. Returns the transcript (for holds and beats) and an `advance()`
 * that plays the next stage.
 *
 * @param {import("playwright").Page} page
 * @param {{ baseUrl: string, locale: "en" | "zh", theme: "light" | "dark" }} options
 */
export async function openDemoSession(page, { baseUrl, locale, theme }) {
  const transcript = buildDemoTranscript(locale)

  await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" })
  await ensureDemoAccount(page, `${baseUrl}/`, demoAccountName(locale))
  const missing = await page.evaluate(() =>
    ["__cogniaSetSettings", "__cogniaSeedStagedConversation", "__cogniaAdvanceStage"].filter(
      (name) => typeof (/** @type {any} */ (window)[name]) !== "function"
    )
  )
  if (missing.length > 0) {
    throw new Error(
      `the product build does not expose ${missing.join(", ")}. Build it with ` +
        "NEXT_PUBLIC_E2E=1 (`pnpm test:e2e:build`) from a checkout that includes " +
        "lib/dev/demo-stage-seed.ts."
    )
  }

  await page.evaluate(
    async (patch) => {
      await /** @type {any} */ (window).__cogniaSetSettings(patch)
    },
    demoSettings(locale, theme)
  )
  await page.addStyleTag({ content: DEV_CHROME_CSS })

  const sessionId = await page.evaluate(async (script) => {
    const w = /** @type {any} */ (window)
    const { sessionId } = await w.__cogniaSeedStagedConversation(script)
    // A client-side route change, not a reload: the staged conversation lives
    // in this page's memory, and a reload would drop it.
    w.next.router.push(`/?session=${encodeURIComponent(sessionId)}`)
    return sessionId
  }, transcript.script)

  // An empty session shows the welcome composer; the chat surface mounts
  // once the first stage has written a message, which the caller waits for
  // through `advance()`.
  await page.waitForURL((url) => url.searchParams.get("session") === sessionId, {
    timeout: 30_000,
  })

  let played = 0
  return {
    sessionId,
    transcript,
    /**
     * Play the next stage to completion. After the first one it also waits for
     * the chat surface, so a caller never films the welcome screen by mistake.
     */
    async advance() {
      const result = await page.evaluate(
        (id) => /** @type {any} */ (window).__cogniaAdvanceStage(id),
        sessionId
      )
      played += 1
      if (played === 1) {
        await page
          .locator(CHAT_SURFACE_SELECTOR)
          .first()
          .waitFor({ state: "visible", timeout: 30_000 })
      }
      return result
    },
  }
}
