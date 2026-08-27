/**
 * Playwright fixtures for the Cognia Browser Companion.
 *
 * Built on the shared E2E fixture rather than on `@playwright/test` directly.
 * That is a governance rule (`check-e2e-governance.mjs`'s
 * `direct-playwright-import`, which is non-exemptible) and it earns its keep
 * here: an extension failure is usually a console error or a refused request
 * inside a page nobody is watching, and the shared fixture attaches exactly
 * those to the test report. This module is not a `.spec.ts`, so it is the one
 * place in the lane allowed to reach for `chromium` itself.
 *
 * The built-in `context` is **overridden** rather than supplemented, because
 * an extension only loads into a persistent context. Overriding it also keeps
 * the built-in `page` — and therefore the shared diagnostics — pointed at the
 * right browser instead of at a second, unused one.
 */
import { chromium, type Page, type Worker } from "@playwright/test"

import { test as base } from "../fixtures/test"
import { extensionDirFor, unpackedExtensionId, type ExtensionProfile } from "./extension-profile"
import { startMockHost, type MockHost } from "./mock-host"

export { expect } from "../fixtures/test"
export type { Page } from "../fixtures/test"

export interface ExtensionFixtures {
  /**
   * Which build to load. `shipped` is the artifact users install; `granted`
   * carries the one documented deviation (see `extension-profile.ts`).
   * Declared per file with `test.use({ extensionProfile: "granted" })`.
   */
  extensionProfile: ExtensionProfile
  /**
   * What `browser_companion_capability` claims to speak. The panel gates on it,
   * so a spec that wants the incompatible screen raises it.
   */
  hostSchemaVersion: number
  /** `chrome-extension://<id>`, as the Host stores and replays it. */
  extensionOrigin: string
  extensionId: string
  /** The MV3 service worker, for driving `chrome.*` outside a page. */
  serviceWorker: Worker
  /** A faithful stand-in for the Host's plaintext browser plane. */
  mockHost: MockHost
  /** The side panel, opened as a tab. */
  panel: Page
}

/**
 * The fixture callback is named `provide`, not `use`, throughout — the repo's
 * convention (see `tests/e2e/tauri/fixtures.ts`). `use` is a React hook name,
 * so `react-hooks/rules-of-hooks` fires on every fixture spelled that way.
 */
export const test = base.extend<ExtensionFixtures>({
  extensionProfile: ["shipped", { option: true }],
  hostSchemaVersion: [1, { option: true }],

  extensionId: async ({ extensionProfile }, provide) => {
    await provide(await unpackedExtensionId(await extensionDirFor(extensionProfile)))
  },

  extensionOrigin: async ({ extensionId }, provide) => {
    await provide(`chrome-extension://${extensionId}`)
  },

  context: async ({ extensionProfile }, provide) => {
    const dir = await extensionDirFor(extensionProfile)
    // `channel: "chromium"` is required, not cosmetic: Playwright's default
    // headless build is `headless_shell`, which has no extension support at
    // all, and the failure is a context that simply never reports a service
    // worker.
    const context = await chromium.launchPersistentContext("", {
      channel: "chromium",
      args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`],
    })
    try {
      await provide(context)
    } finally {
      await context.close()
    }
  },

  serviceWorker: async ({ context }, provide) => {
    // MV3 workers are reclaimed and respawned, so the one present at launch is
    // not guaranteed to be there — wait for it rather than indexing into a
    // list that may still be empty.
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"))
    await provide(worker)
  },

  mockHost: async ({ extensionOrigin, hostSchemaVersion }, provide) => {
    const host = await startMockHost({ extensionOrigin, schemaVersion: hostSchemaVersion })
    try {
      await provide(host)
    } finally {
      await host.close()
    }
  },

  panel: async ({ page, extensionId }, provide) => {
    // The built-in `page`, so the shared fixture's console/network diagnostics
    // follow the panel — the surface where a failure actually shows up.
    await page.goto(`chrome-extension://${extensionId}/sidepanel.html`)
    await provide(page)
  },
})

/**
 * Redeem a pairing code through the panel's own UI.
 *
 * Deliberately drives the form rather than writing a pairing record into
 * storage: what is under test includes key generation, the SPKI export, the
 * registration proof and the storage write, and seeding the result would skip
 * all four.
 *
 * Only safe on the `granted` profile. On the shipped build the submit handler
 * reaches `chrome.permissions.request()`, which never settles under
 * automation, and the test would hang until its timeout.
 */
export async function pairThroughPanel(panel: Page, code: string): Promise<void> {
  await panel.getByLabel("Paste the pairing code").fill(code)
  await panel.getByRole("button", { name: "Connect", exact: true }).click()
}

/**
 * Ask the background worker to capture a tab, exactly as a context-menu click
 * does.
 *
 * The real gesture paths — the toolbar button, the keyboard command and the
 * context menu — are all browser chrome and cannot be driven. What they have
 * in common is the record they leave, so a spec writes that record and the
 * panel's production handoff does the rest.
 */
export async function requestCapture(
  worker: Worker,
  tabId: number,
  mode: "auto" | "selection" | "page"
): Promise<void> {
  await worker.evaluate(
    async ([key, request]) => {
      await chrome.storage.local.set({ [key as string]: request })
    },
    ["cognia.captureRequest.v1", { tabId, mode, requestedAt: Date.now() }] as const
  )
}

/** The browser's own id for a Playwright page, needed to name a capture target. */
export async function tabIdOf(worker: Worker, url: string): Promise<number> {
  return worker.evaluate(async (target) => {
    const tabs = await chrome.tabs.query({})
    const tab = tabs.find((candidate) => candidate.url === target)
    if (!tab?.id) throw new Error(`no tab at ${target}`)
    return tab.id
  }, url)
}
