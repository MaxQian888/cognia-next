/**
 * Run the real workflow executor through native automation admission. The
 * existing browser canonical-node spec owns editor persistence; this spec
 * needs Tauri IPC, permission admission and the persisted orchestrator outcome.
 * Querying a deliberately nonexistent revision cannot generate OS input.
 */
import type { Page } from "@playwright/test"
import { test as automationTest, expect } from "./fixtures"
import { readRuns } from "../../helpers/workflow-spec-helpers"

const test = automationTest.extend<{ desktopWorkflow: string }>({
  desktopWorkflow: async ({ page, automationSettings }, provide) => {
    await page.goto("/workflows")
    await expect(page.getByRole("heading", { name: /^(Workflows|工作流)$/ })).toBeVisible()
    await page.evaluate(async (settings) => {
      const api = window.__cogniaE2EAutomation!
      await api.setEnabled(true)
      await api.settingsSet({
        ...settings,
        enabled: false,
        consentTimeoutMs: 30_000,
        perSurface: {
          ...settings.perSurface,
          workflow: { ...settings.perSurface.workflow, tier: "perCall" },
        },
      })
    }, automationSettings)
    const id = await page.evaluate(async () => {
      if (!window.__cogniaSeedRawWorkflow) throw new Error("Workflow seed bridge unavailable")
      return window.__cogniaSeedRawWorkflow({
        name: `E2E desktop admission ${crypto.randomUUID()}`,
        nodes: [
          {
            id: "n_trigger",
            type: "trigger.manual",
            typeVersion: 1,
            position: { x: 60, y: 80 },
            data: { label: "Manual", params: {} },
          },
          {
            id: "n_query",
            type: "action.desktop.queryElements",
            typeVersion: 1,
            position: { x: 320, y: 80 },
            data: {
              label: "Query missing revision",
              params: {
                sessionId: `e2e-missing-${crypto.randomUUID()}`,
                lineageId: "e2e-missing-lineage",
                revision: 1,
                locator: { controlType: "AXButton" },
              },
            },
          },
        ],
        edges: [{ id: "e1", source: "n_trigger", target: "n_query" }],
      })
    })
    try {
      await page.getByTestId(`workflow-open-${id}`).click()
      await page.waitForURL(new RegExp(`/workflows/editor\\?id=${id}$`))
      await expect(page.getByTestId("workflow-canvas")).toBeVisible()
      await provide(id)
    } finally {
      // Delete only this fixture's workflow; never reset the shared native DB.
      await page.evaluate((workflowId) => window.__cogniaDeleteWorkflow!(workflowId), id)
      expect(await readRuns(page, id)).toEqual([])
    }
  },
})

const overlay = (page: Page) =>
  page.getByRole("dialog", { name: /automation consent|自动化操作确认/i })

async function expectFailure(page: Page, workflowId: string, error: RegExp): Promise<void> {
  await expect
    .poll(async () => (await readRuns(page, workflowId)).map((r) => r.status))
    .toEqual(["failed"])
  const [run] = await readRuns(page, workflowId)
  expect(JSON.stringify(run.error)).toMatch(error)
  expect(
    run.events.some((event) => event.stepId === "n_query" && event.type === "step_failed")
  ).toBe(true)
  expect(
    run.events.filter((event) => event.stepId === "n_query" && event.type === "step_started")
  ).toHaveLength(1)
  expect(run.events.some((event) => event.type === "step_retrying")).toBe(false)
  expect(
    await page.evaluate(async () => (await window.__cogniaE2EAutomation!.consentPending()).length)
  ).toBe(0)
}

test("@critical disabled automation fails the actual workflow without a consent prompt", async ({
  page,
  desktopWorkflow,
}) => {
  await page.getByTestId("workflow-run").click()
  await expectFailure(page, desktopWorkflow, /automation engine disabled/i)
  await expect(overlay(page)).toBeHidden()
})

test("@critical inherited off policy fails even when automation is enabled", async ({
  page,
  desktopWorkflow,
}) => {
  await page.evaluate(async () => {
    const api = window.__cogniaE2EAutomation!
    await api.setEnabled(true)
    const settings = await api.settingsGet()
    await api.settingsSet({
      ...settings,
      // Surface off inherits defaultTier; both must be off to deny.
      defaultTier: "off",
      perSurface: {
        ...settings.perSurface,
        workflow: { ...settings.perSurface.workflow, tier: "off" },
      },
    })
  })
  await page.getByTestId("workflow-run").click()
  await expectFailure(page, desktopWorkflow, /surface Workflow disabled/)
  await expect(overlay(page)).toBeHidden()
})

test("@critical a missing revision fails once without replaying the native query", async ({
  page,
  desktopWorkflow,
}) => {
  await page.evaluate(() => window.__cogniaE2EAutomation!.setEnabled(true))
  await page.getByTestId("workflow-run").click()
  await expectFailure(page, desktopWorkflow, /stale[_ ]?element/i)
  await expect(overlay(page)).toBeHidden()
})
