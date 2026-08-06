/**
 * Browser E2E: durable AgentTeam operator control.
 *
 * The browser cannot start writable durable children (that contract belongs to
 * Tauri), but it must observe and remotely control local durable records. This
 * spec seeds the public local persistence boundary, reloads through the real
 * account-scoped store, and exercises queued steering, takeover evidence, and
 * retrospective rejection through the product UI.
 */

import { expect, test, type Page } from "@/tests/e2e/fixtures/test"
import {
  ensureCogniaAccount,
  readDexieRows,
  waitForPluginRuntimeReady,
  waitForTestGlobals,
} from "../helpers/db-reset"

const TEAM_NAME = "E2E Durable Operators"
const RUN_ID = "e2e-durable-run"
const CHILD_ID = "e2e-durable-child"
const RETROSPECTIVE_ID = "e2e-durable-retrospective"

async function seedDurableRows(page: Page, teamId: string): Promise<void> {
  await page.evaluate(
    async ({ childId, retrospectiveId, runId, selectedTeamId }) => {
      for (const key of Object.keys(localStorage)) {
        if (!key.startsWith("cognia-agent-teams:")) continue
        const persisted = JSON.parse(localStorage.getItem(key) ?? "{}") as {
          state?: { teams?: Record<string, { config?: Record<string, unknown> }> }
        }
        const team = persisted.state?.teams?.[selectedTeamId]
        if (!team) continue
        team.config = {
          ...(team.config ?? {}),
          runtimeVersion: "durable-v2",
          writeMode: "single-writer",
          repositories: [{ id: "primary", role: "primary", path: "/repo", writable: true }],
          environmentRef: { environmentId: "e2e-environment", versionId: "e2e-environment:v1" },
        }
        localStorage.setItem(key, JSON.stringify(persisted))
      }

      const candidates = (await indexedDB.databases())
        .map((info) => info.name)
        .filter((name): name is string => Boolean(name?.startsWith("cognia-")))
        .sort(
          (a, b) =>
            Number(b.startsWith("cognia-account-")) - Number(a.startsWith("cognia-account-"))
        )
      let seeded = false
      for (const name of candidates) {
        const wroteRows = await new Promise<boolean>((resolve) => {
          const timeout = window.setTimeout(() => resolve(false), 3_000)
          const finish = (value: boolean) => {
            window.clearTimeout(timeout)
            resolve(value)
          }
          const request = indexedDB.open(name)
          request.onerror = () => finish(false)
          request.onblocked = () => finish(false)
          request.onsuccess = () => {
            const database = request.result
            database.onversionchange = () => database.close()
            const stores = [
              "agentTeamRuns",
              "agentTeamChildRuns",
              "agentTeamRetrospectives",
              "projectEnvironmentVersions",
            ]
            if (!stores.every((store) => database.objectStoreNames.contains(store))) {
              database.close()
              finish(false)
              return
            }
            const now = Date.now()
            const transaction = database.transaction(stores, "readwrite")
            transaction.oncomplete = () => {
              database.close()
              finish(true)
            }
            transaction.onerror = () => {
              database.close()
              finish(false)
            }
            transaction.onabort = () => {
              database.close()
              finish(false)
            }
            transaction.objectStore("projectEnvironmentVersions").put({
              id: "e2e-environment:v1",
              environmentId: "e2e-environment",
              projectId: "e2e-project",
              version: 1,
              name: "E2E local environment",
              setupScript: { default: "" },
              actions: [],
              variables: {},
              keyringReferences: [],
              policy: { requiredRuntimeCapabilities: ["filesystem"] },
              createdAt: now,
            })
            transaction.objectStore("agentTeamRuns").put({
              id: runId,
              teamId: selectedTeamId,
              objective: "Operate a durable local run",
              status: "running",
              priority: 5,
              decisionVersion: 0,
              resourceUsage: {
                promptTokens: 12,
                completionTokens: 8,
                totalTokens: 20,
                wallTimeMs: 1_000,
                toolTimeMs: 200,
                attempts: 1,
                failures: 0,
              },
              createdAt: now,
              startedAt: now,
              updatedAt: now,
            })
            transaction.objectStore("agentTeamChildRuns").put({
              id: childId,
              runId,
              teamId: selectedTeamId,
              teammateId: "lead",
              taskId: "e2e-task",
              repositoryId: "primary",
              status: "running",
              attempt: 1,
              workspacePath: "/repo/.worktrees/e2e-child",
              resourceUsage: {
                promptTokens: 12,
                completionTokens: 8,
                totalTokens: 20,
                wallTimeMs: 1_000,
                toolTimeMs: 200,
                attempts: 1,
                failures: 0,
              },
              createdAt: now,
              startedAt: now,
              updatedAt: now,
            })
            transaction.objectStore("agentTeamRetrospectives").put({
              id: retrospectiveId,
              runId,
              status: "pending_approval",
              issueTimeline: [],
              proposals: [
                {
                  id: "e2e-learning-proposal",
                  kind: "decomposition",
                  title: "Split verification from delivery",
                  after: "Create an explicit verification task.",
                  status: "pending",
                },
              ],
              createdAt: now,
              updatedAt: now,
            })
          }
        })
        if (wroteRows) {
          seeded = true
          break
        }
      }
      if (!seeded) throw new Error("No Cognia database exposed durable AgentTeam stores")
    },
    { childId: CHILD_ID, retrospectiveId: RETROSPECTIVE_ID, runId: RUN_ID, selectedTeamId: teamId }
  )
}

test.describe("agent teams — durable operations", () => {
  // This journey intentionally boots the account-scoped app twice: once to
  // create the team and once after seeding durable Dexie records. Each boot
  // initializes the plugin fleet, so the repository-wide 60s single-boot
  // budget is insufficient even though every wait is tied to visible state.
  test.describe.configure({ timeout: 120_000 })

  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await ensureCogniaAccount(page)
    await page.goto("about:blank")
    await page.goto("/agent-teams", { waitUntil: "domcontentloaded" })
    await waitForTestGlobals(page, 30_000)
    await waitForPluginRuntimeReady(page, 30_000)
    await expect(page.getByTestId("agent-teams-list-page")).toBeVisible()
  })

  test("@critical queues steering, checkpoints takeover evidence, and rejects learning", async ({
    page,
  }) => {
    await page
      .getByTestId("agent-teams-list-page")
      .getByRole("button", { name: "Create team", exact: true })
      .first()
      .click()
    const dialog = page.getByRole("dialog", { name: "Create new team" })
    await dialog.getByRole("button", { name: "From scratch" }).click()
    await dialog.getByPlaceholder("e.g., Security Audit Team").fill(TEAM_NAME)
    await dialog.getByPlaceholder("What should this team accomplish?").fill("Operate durable work")
    await Promise.all([
      page.waitForURL(/\/agent-teams\/workspace\?teamId=[^&]+$/),
      dialog.getByRole("button", { name: "Create team", exact: true }).click(),
    ])
    await expect(page.getByTestId("agent-team-workspace")).toBeVisible()

    const workspaceUrl = new URL(page.url())
    const teamId = workspaceUrl.searchParams.get("teamId")
    expect(teamId).toBeTruthy()
    await seedDurableRows(page, teamId!)
    await page.goto("/agent-teams", { waitUntil: "domcontentloaded" })
    await expect(page.getByTestId("agent-teams-list-page")).toBeVisible()
    await page.getByRole("tab", { name: "Command center" }).click()
    const commandCenter = page.getByTestId("agent-team-command-center")
    await expect(commandCenter.getByText("Operate a durable local run")).toBeVisible()
    await commandCenter.getByRole("checkbox", { name: `Select run ${RUN_ID}` }).click()
    await commandCenter.getByRole("button", { name: "Pause" }).click()
    await expect
      .poll(async () => {
        const runs = await readDexieRows<{ id: string; status: string }>(page, {
          table: "agentTeamRuns",
        })
        return runs.find((run) => run.id === RUN_ID)?.status
      })
      .toBe("paused")

    await page.goto(workspaceUrl.toString(), { waitUntil: "domcontentloaded" })
    await expect(page.getByTestId("agent-team-workspace")).toBeVisible()
    await page.getByTestId("tab-operations").click()

    await expect(page.getByTestId("durable-operations")).toBeVisible()
    await expect(page.getByText(RUN_ID)).toBeVisible()
    const steeringInput = page.getByPlaceholder("Steer this child at the next safe boundary")
    const sendSteering = page.getByRole("button", { name: "Send steering" })
    await steeringInput.fill("Inspect tests")
    await expect(steeringInput).toHaveValue("Inspect tests")
    await expect(sendSteering).toBeEnabled()
    await sendSteering.click()
    await expect
      .poll(async () => {
        const receipts = await readDexieRows<{ status: string; message: string }>(page, {
          table: "agentTeamSteeringReceipts",
        })
        return receipts.find((receipt) => receipt.message === "Inspect tests")?.status
      })
      .toBe("queued")

    await page.getByRole("button", { name: "Begin takeover" }).click()
    await page.getByPlaceholder("Manual commands, one per line").fill("pnpm typecheck")
    await page.getByPlaceholder("Manual diff or edit summary").fill("Updated runtime policy")
    await page.getByRole("button", { name: "Checkpoint and resume" }).click()
    await expect
      .poll(async () => {
        const evidence = await readDexieRows<{ kind: string }>(page, {
          table: "agentTeamEvidence",
        })
        return [...new Set(evidence.map((item) => item.kind))].sort()
      })
      .toEqual(["command", "diff"])

    await page.getByRole("button", { name: "Reject", exact: true }).click()
    await expect
      .poll(async () => {
        const rows = await readDexieRows<{ id: string; status: string }>(page, {
          table: "agentTeamRetrospectives",
        })
        return rows.find((row) => row.id === RETROSPECTIVE_ID)?.status
      })
      .toBe("rejected")
  })
})
