/**
 * E2E: the dock's Plan panel (document-first plan surface).
 *
 * Seeds a real session + AgentPlan rows through the dev bridge, opens the
 * plan panel from the workbench rail, and verifies the shipped contract:
 * markdown body rendered with the step list embedded, inline autosave that
 * persists through `updatePlanDraft`, a history selector that flips terminal
 * plans to read-only with their event trail.
 */

import { expect, test, type Page } from "@/tests/e2e/fixtures/test"
import {
  ensureCogniaAccount,
  readDexieRow,
  setCogniaSettings,
  waitForTestGlobals,
} from "../helpers/db-reset"

const PLAN_TEXT = [
  "# Ship the widget",
  "",
  "## Context",
  "",
  "The widget pipeline is bespoke.",
  "",
  "## Steps",
  "",
  "1. Audit call sites",
  "2. Swap the adapter",
  "",
  "## Risks",
  "",
  "> Migrations can strand drafts.",
].join("\n")

async function prepareSessionWithPlans(page: Page) {
  await page.goto("/")
  await ensureCogniaAccount(page)
  await page.goto("about:blank")
  await page.goto("/", { waitUntil: "domcontentloaded" })
  await waitForTestGlobals(page, 30_000)
  await setCogniaSettings(page, {
    onboardingProgress: { version: 2, path: "completed", completedAt: "2026-09-12T00:00:00.000Z" },
  })
  const seeded = await page.evaluate(async (planText) => {
    const convo = await window.__cogniaSeedConversation!({ turns: 1, title: "Plan spec" })
    const open = await window.__cogniaSeedPlan!({
      sessionId: convo.sessionId,
      title: "Ship the widget",
      status: "awaiting_approval",
      planText,
      stepTitles: ["Audit call sites", "Swap the adapter"],
    })
    const done = await window.__cogniaSeedPlan!({
      sessionId: convo.sessionId,
      title: "Retired plan",
      status: "completed",
      stepTitles: ["Old step"],
    })
    return { sessionId: convo.sessionId, open, done }
  }, PLAN_TEXT)
  await page.goto(`/?session=${seeded.sessionId}`)
  await waitForTestGlobals(page, 30_000)
  return seeded
}

async function openPlanPanel(page: Page) {
  // On web the title-bar layout controls are off by default; the dock opens
  // from the chat header's artifacts affordance. The dev server's Next.js
  // dev-tools portal overlays that header corner and swallows pointer events —
  // it is a dev-only artifact, not app UI, so remove it before clicking.
  await page.locator("nextjs-portal").evaluateAll((nodes) => nodes.forEach((node) => node.remove()))
  await page.getByRole("button", { name: "Show artifacts panel", exact: true }).click()
  await page.getByRole("button", { name: "Open panel", exact: true }).click()
  await page.getByRole("menuitem", { name: "Plan", exact: true }).click()
  await expect(page.getByTestId("plan-panel")).toBeVisible({ timeout: 10_000 })
}

test.describe("web — plan panel", () => {
  // Seeding pays two app boots plus the plugin-runtime settle window.
  test.describe.configure({ timeout: 150_000 })

  test("@smoke renders the plan document, autosaves step edits, and reads history read-only", async ({
    page,
  }) => {
    const seeded = await prepareSessionWithPlans(page)
    await openPlanPanel(page)

    // Scope everything inside the panel: the same document surface also
    // renders in the transcript's approval card for the awaiting_approval
    // plan, so bare testids would resolve twice.
    const panel = page.getByTestId("plan-panel")

    // The document surface: markdown prose + embedded editable step rows,
    // plus the TOC strip for multi-section bodies.
    await expect(panel.getByTestId("plan-doc-toc")).toBeVisible()
    await expect(panel.getByText("The widget pipeline is bespoke.")).toBeVisible()
    const stepInput = panel.getByTestId("plan-doc-step-0")
    await expect(stepInput).toHaveValue("Audit call sites")

    // Inline edit → debounced autosave → persisted through updatePlanDraft.
    // Assert on the durable side (the Dexie row) rather than the transient
    // "Saved" badge, which fades ~1.6s after the write lands.
    await stepInput.fill("Audit every call site")
    await expect
      .poll(
        async () =>
          (
            await readDexieRow<{ steps?: Array<{ title: string }> }>(page, {
              table: "agentPlans",
              key: seeded.open,
            })
          )?.steps?.[0]?.title,
        { timeout: 15_000 }
      )
      .toBe("Audit every call site")

    // History: the selector lists both plans; the terminal one is read-only
    // and shows its event trail.
    const history = panel.getByTestId("plan-panel-history")
    await expect(history.locator("option")).toHaveCount(2)
    await history.selectOption(seeded.done)
    await expect(panel.getByTestId("plan-doc-step-0")).toHaveCount(0)
    await expect(panel.getByText("Old step")).toBeVisible()
    await expect(panel.getByTestId("plan-doc-events")).toContainText(/created/i)

    // Back to the open plan: editing is available again.
    await history.selectOption(seeded.open)
    await expect(panel.getByTestId("plan-doc-step-0")).toHaveValue("Audit every call site")
  })
})
