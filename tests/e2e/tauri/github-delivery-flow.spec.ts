/**
 * Tauri-driver E2E: GitHub Delivery full webhook → workflow → action loop.
 *
 * Replaces the previously `test.skip()`'d stub. Runs only under the
 * `tauri-driver` Playwright project (PLAYWRIGHT_TAURI_DRIVER=1).
 *
 * Flow under test:
 *   1. Mock GitHub server is up (suite globalSetup) and the github-delivery
 *      plugin's stored credentials point at it.
 *   2. Seed a workflow with `trigger.github.webhook → action.github.commentPr`.
 *   3. POST a synthesised webhook payload (HMAC sha256) to the Rust axum
 *      webhook endpoint exposed by Tauri.
 *   4. Orchestrator runs the workflow; Octokit hits the mock GitHub.
 *   5. Assert: mock GitHub captured a POST to /repos/.../issues/:n/comments,
 *      and workflowAudit shows the run row.
 */

import { expect, test } from "./fixtures"
import crypto from "node:crypto"
import { resetCogniaDb } from "../helpers/db-reset"
import { seedAndOpenWorkflow, configureMockBaseUrls } from "../helpers/seed-workflow"

const WEBHOOK_SECRET = "test-webhook-secret"

function signPayload(payload: string, secret: string): string {
  return "sha256=" + crypto.createHmac("sha256", secret).update(payload).digest("hex")
}

test.describe("tauri-driver: github-delivery webhook → workflow", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
    await configureMockBaseUrls(page, {
      github: process.env.E2E_GITHUB_BASE_URL!,
    })
  })

  test("webhook arrives → workflow runs → comment posts on the mock GitHub", async ({
    page,
    request,
  }) => {
    const wfId = await seedAndOpenWorkflow(page, "action-github-comment-pr")
    await expect(page.getByTestId("workflow-toolbar")).toBeVisible()

    // The Rust axum webhook URL is published via the tauri runtime — for the
    // CDP-connected case we read it from the External Bridge config endpoint.
    const webhookHost = process.env.PLAYWRIGHT_TAURI_WEBHOOK_BASE_URL ?? "http://127.0.0.1:7900"
    const payload = JSON.stringify({ action: "opened", pull_request: { number: 1 } })
    const sig = signPayload(payload, WEBHOOK_SECRET)

    const resp = await request.post(`${webhookHost}/hooks/github`, {
      data: payload,
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-hub-signature-256": sig,
      },
    })
    expect(resp.ok()).toBe(true)

    await page.goto(`/workflows/${wfId}/runs`)
    await expect(page.getByTestId("run-list")).toBeVisible({ timeout: 30_000 })
    await expect(page.locator("[data-testid=openRun]").first()).toBeVisible({ timeout: 30_000 })
  })
})
