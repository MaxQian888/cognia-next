/**
 * Browser E2E: Agent Teams product workspace lifecycle.
 *
 * The workflow-node specs own action.team-* wrappers. This spec owns the
 * browser product contract: create a team through the management UI, build its
 * roster and task list, then prove the account-scoped Zustand state survives a
 * full document reload and remains reachable from the team hub.
 *
 * Team execution is intentionally outside this browser contract. A real run
 * requires a configured model/runtime and is covered by native/runtime suites;
 * this spec must not turn a swallowed runtime failure into pseudo coverage.
 */

import { expect, test } from "@/tests/e2e/fixtures/test"
import { ensureCogniaAccount, waitForTestGlobals } from "../helpers/db-reset"

const TEAM_NAME = "E2E Release Readiness"
const TEAM_OBJECTIVE = "Prepare a deterministic release-readiness report"
const TEAMMATE_NAME = "Quality Reviewer"
const TEAMMATE_DESCRIPTION = "Reviews evidence and release risks"
const TASK_TITLE = "Verify release evidence"
const TASK_DESCRIPTION = "Check the release checklist and record any gaps"

test.describe("agent teams — product workspace lifecycle", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await ensureCogniaAccount(page)
    await page.goto("about:blank")
    await page.goto("/agent-teams", { waitUntil: "domcontentloaded" })
    await waitForTestGlobals(page, 30_000)
    await expect(page.getByTestId("agent-teams-list-page")).toBeVisible()
  })

  test("creates a team, member, and task and restores them after reload", async ({ page }) => {
    const teamsPage = page.getByTestId("agent-teams-list-page")
    await teamsPage.getByRole("button", { name: "Create team", exact: true }).first().click()

    const createDialog = page.getByRole("dialog", { name: "Create new team" })
    await createDialog.getByRole("button", { name: "From scratch" }).click()
    await createDialog.getByPlaceholder("e.g., Security Audit Team").fill(TEAM_NAME)
    await createDialog.getByPlaceholder("What should this team accomplish?").fill(TEAM_OBJECTIVE)
    await createDialog.getByRole("button", { name: "Create team", exact: true }).click()

    await expect(page).toHaveURL(/\/agent-teams\/workspace\?teamId=[^&]+$/)
    await expect(page.getByTestId("agent-team-workspace")).toBeVisible()
    await expect(page.getByTestId("workspace-header").getByRole("heading")).toHaveText(TEAM_NAME)
    await expect(page.getByTestId("tab-members-count")).toHaveText("1")

    await page.getByTestId("tab-members").click()
    const members = page.getByTestId("workspace-members")
    await expect(members).toContainText("Team Lead")
    await members.getByRole("button", { name: "Add teammate" }).click()

    const memberDialog = page.getByRole("dialog", { name: "Add new teammate" })
    await memberDialog.getByPlaceholder("e.g., Security Reviewer").fill(TEAMMATE_NAME)
    await memberDialog.getByPlaceholder("What does this teammate do?").fill(TEAMMATE_DESCRIPTION)
    await memberDialog.getByRole("button", { name: "Add", exact: true }).click()

    await expect(members).toContainText(TEAMMATE_NAME)
    await expect(members).toContainText(TEAMMATE_DESCRIPTION)
    await expect(page.getByTestId("tab-members-count")).toHaveText("2")

    await page.getByTestId("tab-tasks").click()
    await page.getByRole("button", { name: "Create task", exact: true }).click()
    const taskForm = page.getByTestId("task-create-form")
    await taskForm.getByPlaceholder("Task title").fill(TASK_TITLE)
    await taskForm.getByPlaceholder("What needs to be done?").fill(TASK_DESCRIPTION)
    await taskForm.getByRole("button", { name: "Save", exact: true }).click()

    const tasks = page.getByTestId("workspace-tasks")
    await expect(tasks).toContainText(TASK_TITLE)
    await expect(tasks).toContainText(TASK_DESCRIPTION)
    const taskCards = tasks.locator('[data-testid^="task-"]').filter({
      has: page.locator('[data-testid$="-status"]'),
    })
    await expect(taskCards).toHaveCount(1)

    const workspaceUrl = page.url()
    await page.reload({ waitUntil: "domcontentloaded" })

    await expect(page).toHaveURL(workspaceUrl)
    await expect(page.getByTestId("agent-team-workspace")).toBeVisible()
    await expect(page.getByTestId("workspace-header").getByRole("heading")).toHaveText(TEAM_NAME)
    await expect(page.getByTestId("tab-tasks")).toHaveAttribute("data-active", "true")
    await expect(page.getByTestId("workspace-tasks")).toContainText(TASK_TITLE)

    await page.getByTestId("tab-members").click()
    await expect(page.getByTestId("workspace-members")).toContainText(TEAMMATE_NAME)
    await expect(page.getByTestId("tab-members-count")).toHaveText("2")

    await page.getByTestId("workspace-back").click()
    await expect(page).toHaveURL(/\/agent-teams$/)
    const persistedTeam = page.locator('[data-testid^="team-card-"]').filter({ hasText: TEAM_NAME })
    await expect(persistedTeam).toHaveCount(1)
    await expect(persistedTeam).toContainText("2 members")
  })
})
