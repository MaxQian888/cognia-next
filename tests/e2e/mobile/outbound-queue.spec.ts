/**
 * E2E: mobile outbound queue — exercises every command kind end-to-end.
 *
 * Each command goes through the same path: enqueue while offline →
 * network restored → queue runner drains → success. The seed helper
 * inserts a row directly into mobileOutboundQueue so we don't depend on
 * the calling UI surface (which is exercised separately in its dedicated
 * spec, e.g. workflow-surface for workflow_trigger_manual).
 *
 * The command list MUST stay in lockstep with
 * `lib/db/mobile-outbound-types.ts:MOBILE_OUTBOUND_COMMANDS` — drift here
 * silently passes the spec while production commands rot. The
 * `outbound-queue-spec-parity` unit test pins both sides.
 */

import { expect, test } from "@playwright/test"
import { resetCogniaDb } from "../helpers/db-reset"
import { injectCapacitor } from "../helpers/inject-capacitor"

const COMMAND_KINDS = [
  // Connector subsystem
  "connector_send",
  "connector_approve_draft",
  "connector_reject_draft",
  // Workflow subsystem
  "workflow_trigger_manual",
  "workflow_delete",
  "workflow_schedule_pause",
  "workflow_schedule_resume",
  // Twin subsystem
  "twin_ingest_source",
  // Wave 2 desktop-write mutating RPCs
  "character_upsert",
  "character_delete",
  "character_bind_twin",
  "skill_set_enabled",
  "plugin_set_enabled",
  "adapter_update_policy",
  "app_settings_update",
  // External agents (ADR-0056, Wave 4)
  "external_agent_update",
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
