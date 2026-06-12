/**
 * @jest-environment jsdom
 *
 * Web-mode behavior of the workflow Tauri bridge. Without the Tauri globals
 * `isTauri()` is false, so every wrapper degrades gracefully instead of
 * throwing — the orchestrator must run end-to-end in the browser shell.
 */
import {
  respondToWebhook,
  registerTrigger,
  reloadInFlightRuns,
  getWebhookUrl,
} from "./tauri-bridge"

describe("tauri-bridge (web mode, no Tauri globals)", () => {
  it("respondToWebhook resolves to false (no receiver to answer)", async () => {
    await expect(
      respondToWebhook("whr_1", { status: 200, body: "ok", headers: { "x-a": "b" } })
    ).resolves.toBe(false)
  })

  it("respondToWebhook tolerates an omitted headers map", async () => {
    await expect(respondToWebhook("whr_2", { status: 204, body: "" })).resolves.toBe(false)
  })

  it("registerTrigger resolves without throwing", async () => {
    await expect(
      registerTrigger({
        workflowId: "wf",
        triggerId: "trg",
        kind: "trigger.webhook",
        enabled: true,
        webhookPath: "x",
        webhookAwaitResponse: true,
      })
    ).resolves.toBeUndefined()
  })

  it("reloadInFlightRuns returns an empty list in web mode", async () => {
    await expect(reloadInFlightRuns()).resolves.toEqual([])
  })

  it("getWebhookUrl returns null in web mode", async () => {
    await expect(getWebhookUrl("trg")).resolves.toBeNull()
  })
})
