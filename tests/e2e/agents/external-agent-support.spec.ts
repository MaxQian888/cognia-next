import { expect, test, type Page } from "@/tests/e2e/fixtures/test"
import { ensureCogniaAccount, setCogniaSettings } from "../helpers/db-reset"

const ADDED_STRUCTURED_PRESETS = [
  "openclaude",
  "crush",
  "continue-dev",
  "rovo-dev",
  "codebuff",
  "auggie",
  "autohand-code",
  "codebuddy",
  "command-code",
  "kilocode",
  "mistral-vibe",
  "mimo-code",
  "oh-my-pi",
  "muse",
  "amp",
  "zcode",
] as const

interface SavedAgent {
  id: string
  name: string
  protocol: string
  transport: string
  stateIsolation: string
  process?: { command: string; args: string[]; cwd?: string }
  network?: { endpoint?: string }
  metadata?: { presetId?: string }
}

async function savedAgents(page: Page): Promise<SavedAgent[]> {
  return page.evaluate(() => {
    const persisted = JSON.parse(localStorage.getItem("cognia-external-agents") ?? "null") as {
      state?: { agents?: Record<string, SavedAgent> }
    } | null
    return Object.values(persisted?.state?.agents ?? {})
  })
}

async function openPicker(page: Page) {
  if (!(await page.getByTestId("add-agent-button").isVisible())) {
    await page.getByRole("button", { name: "Agents", exact: true }).click()
  }
  await page.getByTestId("add-agent-button").click()
  const picker = page.getByRole("dialog", { name: "Add Agent", exact: true })
  await expect(picker.getByRole("searchbox")).toBeVisible()
  return picker
}

test.beforeEach(async ({ page }) => {
  // Each test owns a fresh browser context/database. Seed its registered test
  // account without deleting an open plugin database or requiring plugin boot.
  await page.goto("/onboarding", { waitUntil: "domcontentloaded" })
  await ensureCogniaAccount(page)
  await page.goto("about:blank")
  await page.goto("/onboarding", { waitUntil: "domcontentloaded" })
  await expect(
    page.getByRole("heading", { name: "Your desktop, with an agent in it.", exact: true })
  ).toBeVisible()
  await setCogniaSettings(page, {
    onboardingProgress: { version: 2, path: "completed", completedAt: "2026-10-27T00:00:00.000Z" },
  })
  await page.goto("/settings?section=agents", { waitUntil: "domcontentloaded" })
  await expect(page.getByTestId("add-agent-button")).toBeVisible()
})

test("new structured presets keep native launch fields and persist configured agents @critical", async ({
  page,
}, testInfo) => {
  const picker = await openPicker(page)
  for (const id of ADDED_STRUCTURED_PRESETS) {
    const row = picker.getByTestId(`preset-pick-${id}`)
    await expect(row).toBeVisible()
    await expect(row).toBeEnabled()
  }
  await page.screenshot({
    path: testInfo.outputPath("structured-preset-picker.png"),
    animations: "disabled",
  })

  const cases = [
    {
      id: "oh-my-pi",
      protocol: "ACP (Agent Client Protocol)",
      command: "omp",
      args: "acp",
      fixed: false,
      save: true,
      isolated: false,
    },
    {
      id: "crush",
      protocol: "Crush (private HTTP + SSE)",
      command: "crush",
      args: "",
      fixed: true,
      save: false,
      isolated: false,
    },
    {
      id: "rovo-dev",
      protocol: "Rovo Dev (HTTP + SSE)",
      command: "acli",
      args: "rovodev serve",
      fixed: true,
      save: false,
      isolated: false,
    },
    {
      id: "codebuff",
      protocol: "Codebuff SDK",
      command: "node",
      args: "",
      fixed: true,
      save: true,
      isolated: false,
    },
  ] as const
  for (const [index, preset] of cases.entries()) {
    const currentPicker = index === 0 ? picker : await openPicker(page)
    await currentPicker.getByTestId(`preset-pick-${preset.id}`).click()
    const editor = page.getByTestId(/^agent-editor-(dialog|drawer)$/)
    await expect(editor.getByLabel("Protocol", { exact: true })).toHaveText(preset.protocol)
    await expect(editor.getByLabel("Command", { exact: true })).toHaveValue(preset.command)
    await expect(editor.getByLabel("Arguments", { exact: true })).toHaveValue(preset.args)
    if (preset.fixed) await expect(editor.getByLabel("Arguments", { exact: true })).toBeDisabled()
    else await expect(editor.getByLabel("Arguments", { exact: true })).toBeEnabled()
    await expect(editor.getByLabel("Endpoint", { exact: true })).toHaveCount(0)
    await editor
      .getByLabel("Working Directory", { exact: true })
      .fill("/tmp/cognia-agent-support-e2e")
    const ownState = editor.getByTestId("state-isolation-isolated")
    if (preset.isolated) {
      await expect(ownState).toBeEnabled()
      await ownState.check()
      await expect(ownState).toBeChecked()
    } else {
      await expect(ownState).toBeDisabled()
      await expect(editor.getByTestId("state-isolation-shared")).toBeChecked()
      await expect(editor.getByTestId("state-isolation-unsupported")).toContainText(preset.command)
      if (preset.id === "codebuff")
        await expect(editor.getByLabel("Command", { exact: true })).toBeDisabled()
    }
    await page.screenshot({
      path: testInfo.outputPath(`${preset.id}-configuration.png`),
      animations: "disabled",
    })
    if (!preset.save) {
      await editor.getByRole("button", { name: "Cancel", exact: true }).click()
      await expect(editor).toBeHidden()
      continue
    }
    const name = `E2E ${preset.id}`
    await editor.getByLabel("Agent Name", { exact: true }).fill(name)
    await editor
      .getByTestId("agent-editor-footer")
      .getByRole("button", { name: "Add", exact: true })
      .click()
    await expect(editor).toBeHidden()
    await expect
      .poll(async () => (await savedAgents(page)).find((agent) => agent.name === name))
      .toMatchObject({
        name,
        protocol: preset.id === "oh-my-pi" ? "acp" : "codebuff-sdk",
        stateIsolation: preset.isolated ? "isolated" : "shared",
        process: {
          command: preset.command,
          args: preset.id === "oh-my-pi" ? ["acp"] : [],
          cwd: "/tmp/cognia-agent-support-e2e",
        },
      })
  }

  await page.reload({ waitUntil: "domcontentloaded" })
  for (const name of ["E2E oh-my-pi", "E2E codebuff"]) {
    const stored = (await savedAgents(page)).find((agent) => agent.name === name)
    expect(stored).toBeDefined()
    expect(stored?.network?.endpoint).toBeUndefined()
    await expect(page.getByTestId(`agent-row-${stored!.id}`)).toContainText(name)
  }
  await page.screenshot({
    path: testInfo.outputPath("saved-agent-list.png"),
    animations: "disabled",
  })
})

test("terminal agents disclose native permissions and cannot launch without a terminal host @critical", async ({
  page,
}, testInfo) => {
  await page.getByRole("button", { name: "Terminal agents Native terminal", exact: true }).click()
  const terminal = page.getByRole("region", { name: "Terminal agents", exact: true })
  await expect(terminal).toContainText(
    "Cognia chat approvals, prompt filtering, structured events and chat resume/fork do not apply"
  )
  await expect(terminal.getByRole("status")).toHaveText(
    "A desktop or paired terminal host is required to launch an agent."
  )
  await terminal
    .getByLabel("Working directory on the terminal host", { exact: true })
    .fill("/tmp/cognia-agent-support-e2e")
  for (const agent of ["Freebuff", "ZCode"]) {
    const row = terminal.getByRole("listitem", { name: agent, exact: true })
    await expect(row).toContainText("Not running")
    await expect(row.getByRole("button", { name: `Set up ${agent}`, exact: true })).toBeEnabled()
    await expect(row.getByRole("button", { name: `Launch ${agent}`, exact: true })).toBeDisabled()
  }
  await page.screenshot({
    path: testInfo.outputPath("terminal-agent-limitations.png"),
    animations: "disabled",
  })
})
