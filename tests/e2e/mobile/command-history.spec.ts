/**
 * Mobile E2E: paired terminal command-history lifecycle (ADR-0039 phase 2).
 *
 * The desktop boundary supplies history through the real `sync_pull` RPC and
 * accepts a replay through `terminal_exec`. The app's sync handler, Dexie
 * cache, grouping/search UI, confirmation dialog, and offline reload remain
 * real — no product route or store is seeded directly.
 */

import { expect, test, type Page } from "@/tests/e2e/fixtures/test"

import { bootstrapCogniaMobile, readDexieRows } from "../helpers/db-reset"
import { injectCapacitor } from "../helpers/inject-capacitor"

const RELEASE_ROW_ID = "terminal-history-e2e-release"
const TEST_ROW_ID = "terminal-history-e2e-test"
const STATUS_ROW_ID = "terminal-history-e2e-status"
const RELEASE_COMMAND = "pnpm run release:e2e"

interface CapturedRpc {
  command: string
  body: Record<string, unknown>
}

interface TerminalHistoryRow {
  id: string
  command: string
  projectId: string
  shell: string
  cwd: string | null
  exitCode: number | null
  ts: number
  uses: number
  sessionId: string
}

function mockV2BaseUrl(): string {
  const baseUrl = process.env.E2E_V2_BASE_URL
  if (!baseUrl) throw new Error("E2E_V2_BASE_URL is required for Command History E2E")
  return baseUrl
}

async function installTerminalDesktop(page: Page): Promise<{
  calls: CapturedRpc[]
  disconnectHistorySync: () => void
}> {
  const calls: CapturedRpc[] = []
  const baseUrl = mockV2BaseUrl()
  const now = Date.now()
  let historySyncConnected = true

  const historyRows: TerminalHistoryRow[] = [
    {
      id: RELEASE_ROW_ID,
      command: RELEASE_COMMAND,
      projectId: "alpha-release",
      shell: "/bin/zsh",
      cwd: "/workspace/cognia-next",
      exitCode: 0,
      ts: now,
      uses: 3,
      sessionId: "terminal-session-release",
    },
    {
      id: TEST_ROW_ID,
      command: "pnpm test:e2e --filter mobile",
      projectId: "alpha-release",
      shell: "/bin/zsh",
      cwd: "/workspace/cognia-next",
      exitCode: 1,
      ts: now - 1_000,
      uses: 7,
      sessionId: "terminal-session-test",
    },
    {
      id: STATUS_ROW_ID,
      command: "git status --short",
      projectId: "",
      shell: "/bin/zsh",
      cwd: null,
      exitCode: 0,
      ts: now - 2_000,
      uses: 1,
      sessionId: "terminal-session-status",
    },
  ]

  await page.route(`${baseUrl}/api/v1/_rpc/**`, async (route) => {
    const request = route.request()
    const command = new URL(request.url()).pathname.split("/").pop() ?? ""
    const body = (request.postDataJSON() ?? {}) as Record<string, unknown>
    calls.push({ command, body })

    if (command === "sync_pull") {
      if (body.table === "terminalHistory" && !historySyncConnected) {
        await route.fulfill({ status: 503, contentType: "text/plain", body: "desktop offline" })
        return
      }
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          rows: body.table === "terminalHistory" && body.since === 0 ? historyRows : [],
          deleted_ids: [],
          next_since: body.table === "terminalHistory" ? now + 1 : 1,
        }),
      })
      return
    }

    if (command === "terminal_exec") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          stdout: "release-ready\n",
          stderr: "",
          exitCode: 0,
          timedOut: false,
        }),
      })
      return
    }

    await route.fulfill({ status: 404, contentType: "text/plain", body: "unknown command" })
  })

  return {
    calls,
    disconnectHistorySync() {
      historySyncConnected = false
    },
  }
}

test.describe("mobile — terminal command history", () => {
  test("syncs, searches, replays, and restores history while the desktop is offline", async ({
    page,
  }) => {
    const desktop = await installTerminalDesktop(page)
    const companionConfig = {
      baseUrl: mockV2BaseUrl(),
      deviceJwt: "e2e-command-history-jwt",
      deviceId: "device-e2e-command-history",
      serverVersion: "1.0.0",
    }
    await injectCapacitor(page, {
      platform: "android",
      network: { connected: true, connectionType: "wifi" },
      secureStorage: {
        "cognia.companion.config.v1": JSON.stringify(companionConfig),
      },
    })
    await page.goto("/welcome")
    await bootstrapCogniaMobile(page, "paired")

    await page.goto("/me/command-history", { waitUntil: "domcontentloaded" })
    await expect(page.getByTestId("mobile-command-history-page")).toBeVisible()
    await expect(page.getByTestId(`command-history-row-${RELEASE_ROW_ID}`)).toBeVisible()
    await expect(page.getByTestId(`command-history-row-${TEST_ROW_ID}`)).toBeVisible()
    await expect(page.getByTestId(`command-history-row-${STATUS_ROW_ID}`)).toBeVisible()

    await expect
      .poll(() =>
        desktop.calls.find(
          (call) =>
            call.command === "sync_pull" &&
            call.body.table === "terminalHistory" &&
            call.body.since === 0
        )
      )
      .toMatchObject({ command: "sync_pull", body: { table: "terminalHistory", since: 0 } })

    const groupIds = await page
      .locator('[data-testid^="command-history-group-"]')
      .evaluateAll((groups) => groups.map((group) => group.getAttribute("data-testid")))
    expect(groupIds).toEqual([
      "command-history-group-alpha-release",
      "command-history-group-none",
    ])

    const persistedRows = await readDexieRows<TerminalHistoryRow>(page, {
      table: "terminalHistory",
    })
    expect(persistedRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: RELEASE_ROW_ID,
          command: RELEASE_COMMAND,
          projectId: "alpha-release",
          uses: 3,
        }),
        expect.objectContaining({ id: TEST_ROW_ID, uses: 7 }),
        expect.objectContaining({ id: STATUS_ROW_ID, projectId: "" }),
      ])
    )

    const search = page.getByTestId("command-history-search")
    await search.fill("release:e2e")
    await expect(page.getByTestId(`command-history-row-${RELEASE_ROW_ID}`)).toBeVisible()
    await expect(page.getByTestId(`command-history-row-${TEST_ROW_ID}`)).toHaveCount(0)
    await search.fill("does-not-exist")
    await expect(page.getByTestId("command-history-no-results")).toBeVisible()
    await search.fill("")

    await page.getByTestId(`command-history-run-${RELEASE_ROW_ID}`).click()
    await expect(page.getByTestId("command-history-run-dialog")).toContainText(RELEASE_COMMAND)
    await page.getByTestId("command-history-run-confirm").click()
    await expect(page.getByTestId("command-history-run-result")).toContainText("release-ready")
    await expect
      .poll(() =>
        desktop.calls.find(
          (call) => call.command === "terminal_exec" && call.body.command === RELEASE_COMMAND
        )
      )
      .toMatchObject({
        command: "terminal_exec",
        body: { command: RELEASE_COMMAND, shell: true, timeoutMs: 60_000 },
      })
    await page.getByTestId("command-history-run-close").click()

    const pullsBeforeOfflineReload = desktop.calls.filter(
      (call) => call.command === "sync_pull" && call.body.table === "terminalHistory"
    ).length
    desktop.disconnectHistorySync()
    await page.reload({ waitUntil: "domcontentloaded" })

    await expect(page.getByTestId(`command-history-row-${RELEASE_ROW_ID}`)).toBeVisible()
    await expect(page.getByTestId(`command-history-row-${STATUS_ROW_ID}`)).toBeVisible()
    await expect
      .poll(
        () =>
          desktop.calls.filter(
            (call) => call.command === "sync_pull" && call.body.table === "terminalHistory"
          ).length
      )
      .toBeGreaterThan(pullsBeforeOfflineReload)
  })
})
