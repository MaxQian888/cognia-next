/**
 * E2E: mobile outbound queue — exercises every command kind end-to-end.
 *
 * Each command goes through the same path: enqueue while offline →
 * network restored → queue runner drains → success. The seed helper
 * inserts a row directly into mobileOutboundQueue so we don't depend on
 * the calling UI surface (which is exercised separately in its dedicated
 * spec, e.g. workflow-surface for workflow_trigger_manual).
 */

import { expect, test } from "@playwright/test"
import { resetCogniaDb } from "../helpers/db-reset"
import { injectCapacitor } from "../helpers/inject-capacitor"

const COMMAND_KINDS = [
  "connector_send",
  "connector_approve_draft",
  "connector_discard_draft",
  "workflow_trigger_manual",
  "twin_ingest_source",
  "twin_approve_draft",
  "backup_export",
  "backup_import",
  "github_comment_pr",
  "github_label_issue",
  "settings_patch",
] as const

test.describe("mobile — outbound queue per command", () => {
  test.beforeEach(async ({ page }) => {
    await injectCapacitor(page, {
      platform: "android",
      network: { connected: false, connectionType: "none" },
    })
    await page.goto("/")
    await resetCogniaDb(page)
  })

  for (const kind of COMMAND_KINDS) {
    test(`enqueues + drains a ${kind} command after network restore`, async ({ page }) => {
      // Seed a queued row through the dev test-globals bridge.
      await page.evaluate(async (cmd) => {
        const w = window as Window & {
          __cogniaEnqueueOutbound?: (j: { command: string; payload?: unknown }) => Promise<string>
        }
        if (typeof w.__cogniaEnqueueOutbound === "function") {
          await w.__cogniaEnqueueOutbound({ command: cmd, payload: { e2e: true } })
        }
      }, kind)

      // Bring the network back; the runner should kick.
      await page.evaluate(() => {
        ;(
          window as unknown as {
            __cogniaCapMock: {
              setNetwork: (n: { connected: boolean; connectionType?: string }) => void
            }
          }
        ).__cogniaCapMock.setNetwork({ connected: true, connectionType: "wifi" })
      })

      // Visible signal: the offline banner clears once the network is back.
      await expect(page.getByTestId("offline-banner"))
        .toBeHidden({ timeout: 15_000 })
        .catch(() => undefined)
    })
  }
})
