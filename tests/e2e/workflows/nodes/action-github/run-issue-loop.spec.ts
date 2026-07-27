/**
 * E2E: action.github.runIssueLoop — runs the AI loop against a single issue.
 */

import { expect, test } from "@playwright/test"
import { resetCogniaDb } from "../../../helpers/db-reset"
import { configureMockBaseUrls, seedAndOpenWorkflow } from "../../../helpers/seed-workflow"
import {
  assertNodeOnCanvas,
  openNodeInspector,
  reopenAndAssertNode,
  saveWorkflow,
} from "../../../helpers/workflow-spec-helpers"

test.describe("workflow node — action.github.runIssueLoop", () => {
  // 3x budget: each test re-boots the full app AND waits out the
  // github-delivery plugin's dynamic Dexie table registration, which
  // under parallel-worker contention has been measured north of 45s
  // (solo: ~5s). See the e2e-suite-revival plan §7 for the underlying
  // schema-upgrade race.
  test.slow()
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
    await configureMockBaseUrls(page, {
      github: process.env.E2E_GITHUB_BASE_URL!,
      anthropic: process.env.E2E_ANTHROPIC_BASE_URL!,
    })
    await page.evaluate(() => {
      localStorage.setItem(
        "cognia-external-agents",
        JSON.stringify({
          state: {
            agents: {
              "codex-ui-agent": {
                id: "codex-ui-agent",
                name: "Codex UI Agent",
                protocol: "acp",
                transport: "websocket",
                network: { endpoint: "ws://127.0.0.1:65535" },
                enabled: true,
                createdAt: "2026-07-26T00:00:00.000Z",
                updatedAt: "2026-07-26T00:00:00.000Z",
              },
            },
            enabled: true,
            activeAgentId: null,
            delegationRules: [],
            agentValidity: {},
            benchmarkCapabilityMap: {},
            lastRunSnapshots: {},
            defaultPermissionMode: "default",
            autoConnectOnStartup: false,
            showConnectionNotifications: false,
            chatFailurePolicy: "strict",
          },
          version: 5,
        })
      )
    })
    await page.reload({ waitUntil: "domcontentloaded" })
  })

  test("runtime selection persists through save and workflow reload", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "action-github-run-issue-loop")
    await assertNodeOnCanvas(page, { kind: "action.github.runIssueLoop", label: "Issue Loop" })
    await openNodeInspector(page, "action.github.runIssueLoop")
    await expect(page.locator("#ins-repoFullName, [data-field=repoFullName]").first()).toBeVisible()
    await expect(page.locator("#ins-issueNumber, [data-field=issueNumber]").first()).toBeVisible()
    await expect(page.locator("#ins-worktreeMode, [data-field=worktreeMode]").first()).toBeVisible()
    const runtimeField = page.locator("[data-field=externalAgentId]")
    await expect(runtimeField).toBeVisible()
    await runtimeField.getByRole("button").click()
    await page.getByRole("menuitem").filter({ hasText: "Codex UI Agent" }).click()
    await expect(runtimeField).toContainText("Codex UI Agent")
    await saveWorkflow(page)
    await reopenAndAssertNode(page, wfId, { kind: "action.github.runIssueLoop" })
    await openNodeInspector(page, "action.github.runIssueLoop")
    await expect(page.locator("[data-field=externalAgentId]")).toContainText("Codex UI Agent")
  })
})
