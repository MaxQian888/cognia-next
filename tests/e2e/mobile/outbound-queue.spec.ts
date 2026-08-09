/**
 * E2E: mobile outbound queue — exercises every command kind end-to-end.
 *
 * Each command goes through the real path: enqueue while offline → network
 * restored → queue runner drains → `CompanionTransport.call()` POSTs
 * `/api/_rpc/<command>` against the canonical Companion mock → row flips to
 * "sent". The seed helper inserts a row directly into mobileOutboundQueue so
 * we don't depend on the calling UI surface (which is exercised separately
 * in its dedicated spec, e.g. workflow-surface for workflow_trigger_manual).
 *
 * Two hard assertions per kind:
 *   1. Dexie truth — the enqueued row reaches status "sent" (the only state
 *      `markSent` writes, and it only runs after the RPC 2xx'd; a 404/5xx
 *      lands the row in failed/deadlettered and the poll goes red).
 *   2. Wire truth — the mock's capture log contains this command at the
 *      `_rpc` endpoint (read over HTTP via /__control/rpc-calls because the
 *      shared instance lives in the globalSetup process).
 *
 * The command list MUST stay in lockstep with
 * `lib/db/mobile-outbound-types.ts:MOBILE_OUTBOUND_COMMANDS` — drift here
 * silently passes the spec while production commands rot. The
 * `outbound-queue-spec-parity` unit test pins both sides, and the mock 404s
 * commands outside that list (mirroring the Rust dispatcher), so a rotten
 * kind fails assertion 1.
 */

import { expect, test } from "@/tests/e2e/fixtures/test"
import { readDexieRow, resetCogniaDb, setCogniaSettings } from "../helpers/db-reset"
import { injectCapacitor } from "../helpers/inject-capacitor"
import { provisionMockCompanionConfig } from "./companion-fixture"

interface QueueRowView {
  status: string
  lastError?: string
}

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
  // Long-term memory
  "memory_update",
  "memory_forget",
  // External agents (ADR-0056, Wave 4)
  "external_agent_update",
] as const

function mockV2BaseUrl(): string {
  const baseUrl = process.env.E2E_V2_BASE_URL
  if (!baseUrl) {
    throw new Error("E2E_V2_BASE_URL not published — global-setup didn't boot the mock V2 server")
  }
  return baseUrl
}

test.describe("mobile — outbound queue per command", () => {
  test.beforeEach(async ({ page }) => {
    await injectCapacitor(page, {
      platform: "android",
      network: { connected: false, connectionType: "none" },
    })
    await page.goto("/")
    await resetCogniaDb(page)
    // Re-seed the runtime mode the reset just wiped, or the next boot bounces
    // to the /welcome onboarding chooser.
    await setCogniaSettings(page, { mobileRuntimeMode: "paired" })
    // Pair the companion transport with the mock server AFTER the reset
    // (resetCogniaDb wipes storage). Without a companion config the runner's
    // transport.call rejects with not_paired and every row deadletters.
    const companionConfig = await provisionMockCompanionConfig(
      mockV2BaseUrl(),
      `e2e-outbound-queue-${crypto.randomUUID()}`
    )
    await page.evaluate(
      async (cfg) => {
        const w = window as Window & {
          __cogniaSaveCompanionConfig?: (c: unknown) => Promise<void>
        }
        if (typeof w.__cogniaSaveCompanionConfig !== "function") {
          throw new Error("__cogniaSaveCompanionConfig bridge missing — is NEXT_PUBLIC_E2E=1 set?")
        }
        await w.__cogniaSaveCompanionConfig(cfg)
      },
      companionConfig
    )
  })

  for (const kind of COMMAND_KINDS) {
    test(`enqueues + drains a ${kind} command after network restore`, async ({ page }) => {
      // Seed a queued row through the dev test-globals bridge. A missing
      // bridge is a FAILURE (the app didn't mount its E2E surface), not a
      // silent no-op.
      const jobId = await page.evaluate(async (cmd) => {
        const w = window as Window & {
          __cogniaEnqueueOutbound?: (j: { command: string; payload?: unknown }) => Promise<string>
        }
        if (typeof w.__cogniaEnqueueOutbound !== "function") {
          throw new Error("__cogniaEnqueueOutbound bridge missing — cannot seed the queue")
        }
        return await w.__cogniaEnqueueOutbound({ command: cmd, payload: { e2e: true } })
      }, kind)
      expect(jobId).toBeTruthy()

      // Offline: the row must sit pending (the runner only drains on
      // network-restore / kick).
      const before = await readDexieRow<QueueRowView>(page, {
        table: "mobileOutboundQueue",
        key: jobId,
      })
      expect(before?.status).toBe("pending")

      // Bring the network back; the runner's network subscription kicks the drain.
      await page.evaluate(() => {
        ;(
          window as unknown as {
            __cogniaCapMock: {
              setNetwork: (n: { connected: boolean; connectionType?: string }) => void
            }
          }
        ).__cogniaCapMock.setNetwork({ connected: true, connectionType: "wifi" })
      })

      // 1. Dexie truth: the row reaches "sent".
      await expect
        .poll(
          async () => {
            const row = await readDexieRow<QueueRowView>(page, {
              table: "mobileOutboundQueue",
              key: jobId,
            })
            return row ? `${row.status}${row.lastError ? `:${row.lastError}` : ""}` : "missing"
          },
          { timeout: 20_000 }
        )
        .toBe("sent")

      // 2. Wire truth: the mock received THIS command on the _rpc endpoint.
      // No per-test reset (shared instance, fullyParallel workers) — each
      // kind appears in exactly one test, so filtering by command is unique.
      const res = await fetch(`${mockV2BaseUrl()}/__control/rpc-calls`)
      expect(res.ok).toBe(true)
      const calls = (await res.json()) as Array<{ command: string; body: unknown }>
      const mine = calls.filter((c) => c.command === kind)
      expect(mine.length).toBeGreaterThan(0)
      expect(mine[0]!.body).toMatchObject({ e2e: true })
    })
  }
})
