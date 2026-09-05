/**
 * Browser E2E: the unified Squad execution chain (ADR-0169).
 *
 * Seeds a Squad and a durable run through the dev bridge, then proves from the
 * UI that:
 *   - a Squad with readiness blockers is visible, editable and NOT startable,
 *     and the card names each blocker with the action that clears it.
 *   - the `/squads` Runs tab is the canonical cockpit: the same row opens the
 *     same detail pane, and `?run=` deep-links share the `/agent-runs` id space.
 *   - a live run offers Pause and Stop (no Abort), Pause flips to Resume, and
 *     the state survives a reload because it is read from the run record.
 *   - a pending Squad review renders its typed decision form instead of the
 *     bare Approve / Deny verbs, and the form is still there after a reload
 *     because the interrupt is a durable row.
 *   - Stop is terminal: the row settles as Cancelled and no verb remains.
 *
 * Every assertion reads what a user sees. Nothing reaches into a store.
 */

import { expect, test, type Page } from "@/tests/e2e/fixtures/test"

import { ensureCogniaAccount, waitForTestGlobals } from "../helpers/db-reset"

declare global {
  interface Window {
    __cogniaSeedSquad?: (draft: { name: string; task: string }) => Promise<string>
    __cogniaSetSettings?: (patch: Record<string, unknown>) => Promise<void>
    __cogniaSeedSquadRun?: (draft: {
      teamId: string
      objective: string
      status?: "running" | "paused" | "needs_input"
      review?: "budget_extension" | "team_recovery"
    }) => Promise<{ runId: string; executionRunId: string }>
  }
}

const SQUAD_NAME = "Release evidence squad"
const OBJECTIVE = "Audit the release evidence with the whole squad"

/**
 * Boot into the gated app the way the goal-control spec does: seed the account
 * registry, hop through about:blank so the shell re-reads it, then land on a
 * real route where the dev bridge is mounted. A fresh profile has no sessions,
 * which the onboarding gate reads as a first run, so the legacy dismissal
 * stamp is written first: this spec is about Squads, not onboarding.
 */
async function bootInto(page: Page, route: string): Promise<void> {
  await page.goto("/")
  await ensureCogniaAccount(page)
  await page.goto("about:blank")
  await page.goto(route, { waitUntil: "domcontentloaded" })
  await waitForTestGlobals(page)
  await page.evaluate(() => window.__cogniaSetSettings!({ onboardingDismissedAt: Date.now() }))
}

async function seedSquad(page: Page): Promise<string> {
  await waitForTestGlobals(page)
  return page.evaluate(({ name, task }) => window.__cogniaSeedSquad!({ name, task }), {
    name: SQUAD_NAME,
    task: OBJECTIVE,
  })
}

async function seedRun(
  page: Page,
  teamId: string,
  extra: { status?: "running" | "paused" | "needs_input"; review?: "budget_extension" } = {}
) {
  return page.evaluate(
    ({ teamId, objective, extra }) => window.__cogniaSeedSquadRun!({ teamId, objective, ...extra }),
    { teamId, objective: OBJECTIVE, extra }
  )
}

test.describe("squads — one runtime, one cockpit, one review contract", () => {
  test("a blocked Squad is visible and editable but cannot start", async ({ page }) => {
    await bootInto(page, "/squads")
    const teamId = await seedSquad(page)
    await page.goto(`/squads?id=${teamId}`, { waitUntil: "domcontentloaded" })

    const inspector = page.getByTestId("squad-fleet-inspector")
    await expect(inspector).toBeVisible()
    await expect(inspector).toContainText(SQUAD_NAME)

    // The readiness card names the blockers and offers the fix for each.
    const readiness = page.getByTestId("squad-readiness")
    await expect(readiness).toBeVisible()
    await expect(page.getByTestId("squad-readiness-blocked")).toBeVisible()
    const blockers = page.getByTestId("squad-readiness-blockers")
    await expect(blockers).toContainText(/repository/i)
    await expect(blockers).toContainText(/environment/i)

    // Start is disabled, with the first blocker as its reason. Configure stays open.
    await expect(page.getByTestId("start-team")).toBeDisabled()
    await expect(page.getByTestId("squad-fleet-configure")).toBeVisible()
    // Abort is gone from the vocabulary.
    await expect(page.getByRole("button", { name: /abort/i })).toHaveCount(0)
  })

  test("the Runs tab is the cockpit, and a resume on a blocked Squad parks the run", async ({
    page,
  }) => {
    await bootInto(page, "/squads")
    const teamId = await seedSquad(page)
    const { executionRunId } = await seedRun(page, teamId, { status: "paused" })

    await page.goto(`/squads?id=${teamId}&tab=runs`, { waitUntil: "domcontentloaded" })
    const panel = page.getByTestId("agent-runs-panel")
    await expect(panel).toBeVisible()
    // Embedded: the host page owns the header, the panel keeps the filters.
    await expect(page.getByTestId("agent-runs-embedded-controls")).toBeVisible()

    const row = panel.getByRole("list", { name: "Agent Runs" }).getByRole("button", {
      name: new RegExp(OBJECTIVE),
    })
    await expect(row).toBeVisible()
    await row.click()

    // Same id space as /agent-runs?run=.
    await expect(page).toHaveURL(new RegExp(`run=${encodeURIComponent(executionRunId)}`))
    await expect(page.getByRole("heading", { name: OBJECTIVE, level: 2 })).toBeVisible()

    // A paused run offers Resume and Stop. Abort is gone from the vocabulary.
    const resume = page.getByRole("button", { name: "Resume", exact: true })
    await expect(resume).toBeVisible()
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible()
    await expect(page.getByRole("button", { name: "Pause", exact: true })).toHaveCount(0)
    await expect(page.getByRole("button", { name: /abort/i })).toHaveCount(0)

    // The Squad has readiness blockers, so the resume does not re-enter: the
    // run is parked and the recovery review asks how to proceed.
    await resume.click()
    const form = page.getByTestId("squad-review-form")
    await expect(form).toBeVisible()
    await expect(form).toHaveAttribute("data-review-kind", "team_recovery")
    await expect(form).toContainText(/missing a binding/i)
    // Nothing to re-queue on a Squad that never dispatched: restart or stop.
    await expect(page.getByLabel("Restart as a new run")).toBeVisible()
    await expect(page.getByLabel("Retry where it ran")).toHaveCount(0)

    // Reload: the parked state and its review come back from the records.
    await page.reload({ waitUntil: "domcontentloaded" })
    await expect(page.getByTestId("squad-review-form")).toBeVisible()

    // The same run, opened from the canonical route, is the same pane.
    await page.goto(`/agent-runs?kind=team&run=${encodeURIComponent(executionRunId)}`, {
      waitUntil: "domcontentloaded",
    })
    await expect(page.getByRole("heading", { name: OBJECTIVE, level: 2 })).toBeVisible()
    await expect(page.getByTestId("squad-review-form")).toBeVisible()

    // Stop is terminal. No verb remains.
    await page.getByRole("button", { name: "Stop", exact: true }).click()
    await expect(page.getByText("Status").locator("..")).toContainText("Cancelled")
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0)
    await expect(page.getByTestId("squad-review-form")).toHaveCount(0)
  })

  test("a pending Squad review renders its typed form, and the form survives a reload", async ({
    page,
  }) => {
    await bootInto(page, "/squads")
    const teamId = await seedSquad(page)
    const { executionRunId } = await seedRun(page, teamId, {
      status: "running",
      review: "budget_extension",
    })

    await page.goto(`/agent-runs?kind=team&run=${encodeURIComponent(executionRunId)}`, {
      waitUntil: "domcontentloaded",
    })
    await expect(page.getByRole("heading", { name: OBJECTIVE, level: 2 })).toBeVisible()

    const form = page.getByTestId("squad-review-form")
    await expect(form).toBeVisible()
    await expect(form).toHaveAttribute("data-review-kind", "budget_extension")
    // The bare verbs yield to the typed form.
    await expect(page.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Deny", exact: true })).toHaveCount(0)

    await page.reload({ waitUntil: "domcontentloaded" })
    await expect(page.getByTestId("squad-review-form")).toBeVisible()

    // A non-positive amount cannot be approved. A real one can.
    const amount = page.getByLabel("Extra tokens")
    await amount.fill("0")
    await expect(page.getByRole("button", { name: "Grant extension" })).toBeDisabled()
    await amount.fill("25000")
    await page.getByRole("button", { name: "Grant extension" }).click()

    // The interrupt settles: the form is gone and the Approvals tab shows it approved.
    await expect(page.getByTestId("squad-review-form")).toHaveCount(0)
    await page.getByRole("tab", { name: /Approvals/ }).click()
    await expect(page.getByText("Approved", { exact: true }).first()).toBeVisible()
  })
})
