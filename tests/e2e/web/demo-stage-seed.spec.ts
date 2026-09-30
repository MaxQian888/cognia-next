/**
 * E2E: the staged-conversation seam (`lib/dev/demo-stage-seed.ts`).
 *
 * The website's product films and screenshots are recorded by playing a
 * scripted conversation into the real renderers, one stage at a time
 * (`web/scripts/record-product.mjs`). This spec is the seam's contract with the
 * running app: every stage kind lands on the surface the recorder frames —
 * the message, a failing and a passing terminal run, the plan card, the edit
 * card, the awaiting-approval plan dock, the artifact dock and the permission
 * dialog — and the conversation is in Dexie afterwards, not only on screen.
 *
 * The staged conversation's controller lives in page memory, so after seeding
 * the spec moves to the session with a client-side route change, exactly as
 * the recorder does; a reload would drop it.
 */

import { expect, test, type Page } from "@/tests/e2e/fixtures/test"
import { resetCogniaDb, setCogniaSettings, waitForTestGlobals } from "../helpers/db-reset"

const USER = "demo-user"
const ASSISTANT = "demo-assistant"

const running = (type: string, toolCallId: string, input: Record<string, unknown>) => ({
  type,
  toolCallId,
  state: "input-available",
  input,
})

// Narration between tool calls keeps each one its own card: consecutive tool
// parts collapse into one activity row.
const SCRIPT = {
  title: "Staged seam spec",
  stages: [
    {
      kind: "append",
      message: {
        id: USER,
        role: "user",
        parts: [{ type: "text", text: "Fix the failing check, then draft the notes." }],
      },
    },
    { kind: "append", message: { id: ASSISTANT, role: "assistant", parts: [] } },
    {
      kind: "stream",
      messageId: ASSISTANT,
      text: "Reproducing the failure first.",
      chunkSize: 8,
      intervalMs: 5,
    },
    {
      kind: "addPart",
      messageId: ASSISTANT,
      part: running("tool-Bash", "spec-run-failing", { command: "pnpm test --filter widget" }),
    },
    {
      kind: "patchPart",
      messageId: ASSISTANT,
      toolCallId: "spec-run-failing",
      patch: { state: "output-error", errorText: "Tests  1 failed | 2 passed (3)" },
    },
    {
      kind: "stream",
      messageId: ASSISTANT,
      text: " Here is the plan.",
      chunkSize: 8,
      intervalMs: 5,
    },
    {
      kind: "addPart",
      messageId: ASSISTANT,
      part: running("tool-ExitPlanMode", "spec-plan", {
        plan: "1. Round per currency\n2. Re-run the check",
      }),
    },
    {
      kind: "patchPart",
      messageId: ASSISTANT,
      toolCallId: "spec-plan",
      patch: { state: "output-available", output: "approved" },
    },
    {
      kind: "stream",
      messageId: ASSISTANT,
      text: " Applying the fix.",
      chunkSize: 8,
      intervalMs: 5,
    },
    {
      kind: "addPart",
      messageId: ASSISTANT,
      part: running("tool-Edit", "spec-edit", {
        file_path: "src/widget/total.ts",
        old_string: "return Math.round(total)",
        new_string: "return roundToMinorUnits(total, currency)",
      }),
    },
    {
      kind: "patchPart",
      messageId: ASSISTANT,
      toolCallId: "spec-edit",
      patch: { state: "output-available", output: "Updated src/widget/total.ts" },
    },
    { kind: "stream", messageId: ASSISTANT, text: " Checking again.", chunkSize: 8, intervalMs: 5 },
    {
      kind: "addPart",
      messageId: ASSISTANT,
      part: running("tool-Bash", "spec-run-passing", { command: "pnpm test --filter widget" }),
    },
    {
      kind: "patchPart",
      messageId: ASSISTANT,
      toolCallId: "spec-run-passing",
      patch: { state: "output-available", output: "Tests  3 passed (3)" },
    },
    {
      kind: "plan",
      title: "Ship the widget fix",
      planText: "# Ship the widget fix\n\n1. Push the branch\n2. Open the release",
      stepTitles: ["Push the branch", "Open the release"],
    },
    {
      kind: "artifact",
      messageId: ASSISTANT,
      title: "release-notes.md",
      content: "# Widget 1.2.0\n\n## Fixed\n\n- Totals round per currency.",
      artifactType: "document",
    },
    {
      kind: "approval",
      toolCallId: "spec-push",
      toolName: "Bash",
      input: { command: "git push origin release/1.2.0" },
      title: "Push release/1.2.0 to origin",
      description: "The branch leaves this machine.",
    },
  ],
}

async function openStagedSession(page: Page): Promise<{ sessionId: string; stageCount: number }> {
  await page.goto("/")
  await resetCogniaDb(page)
  await page.goto("about:blank")
  await page.goto("/", { waitUntil: "domcontentloaded" })
  await waitForTestGlobals(page, 30_000)
  await setCogniaSettings(page, {
    onboardingProgress: { version: 2, path: "completed", completedAt: "2026-09-30T00:00:00.000Z" },
  })
  const seeded = await page.evaluate(
    (script) => window.__cogniaSeedStagedConversation!(script as never),
    SCRIPT
  )
  // Client-side: the controller that advances the stages is in page memory.
  await page.evaluate((sessionId) => {
    const router = (window as unknown as { next?: { router?: { push: (href: string) => void } } })
      .next?.router
    if (!router) throw new Error("window.next.router is not available")
    router.push(`/?session=${sessionId}`)
  }, seeded.sessionId)
  await expect(page.locator('[data-slot="chat-surface-stage"]')).toBeVisible({ timeout: 20_000 })
  return seeded
}

async function advance(page: Page, sessionId: string) {
  return page.evaluate((id) => window.__cogniaAdvanceStage!(id), sessionId)
}

async function advanceTo(page: Page, sessionId: string, index: number) {
  for (;;) {
    const step = await advance(page, sessionId)
    if (step.index >= index || step.done) return step
  }
}

test.describe("web — staged conversation seam", () => {
  // Seeding pays two app boots plus the plugin-runtime settle window.
  test.setTimeout(120_000)

  test("every stage kind lands on the surface the recorder frames", async ({ page }) => {
    const { sessionId, stageCount } = await openStagedSession(page)
    expect(stageCount).toBe(SCRIPT.stages.length)

    // Stage indices are zero-based; `advanceTo` returns once that stage has played.
    await advanceTo(page, sessionId, 0)
    await expect(page.getByTestId("message-shell").first()).toContainText(
      "Fix the failing check, then draft the notes."
    )

    await advanceTo(page, sessionId, 4)
    const failing = page.getByTestId("terminal-tool-part").last()
    await expect(failing).toBeVisible()
    await expect(failing).toContainText("1 failed")

    await advanceTo(page, sessionId, 7)
    await expect(page.getByTestId("mcp-plan-card").last()).toBeVisible()

    await advanceTo(page, sessionId, 10)
    const edit = page.getByTestId("mcp-edit-card").last()
    await expect(edit).toBeVisible()
    await expect(edit).toContainText("src/widget/total.ts")

    await advanceTo(page, sessionId, 13)
    await expect(page.getByTestId("terminal-tool-part").last()).toContainText("3 passed")

    await advanceTo(page, sessionId, 14)
    await expect(page.getByTestId("plan-approval-dock")).toBeVisible({ timeout: 10_000 })

    await advanceTo(page, sessionId, 15)
    const dock = page.getByTestId("artifact-workspace-dock")
    await expect(dock).toBeVisible({ timeout: 10_000 })
    await expect(dock).toContainText("release-notes.md")

    const last = await advanceTo(page, sessionId, 16)
    expect(last.done).toBe(true)
    const dialog = page.getByRole("dialog").last()
    await expect(dialog).toBeVisible({ timeout: 10_000 })
    await expect(dialog).toContainText("git push origin release/1.2.0")

    // Persisted, not only rendered: the recorder's screenshots reload into this.
    const stored = await page.evaluate(async (id) => {
      const rows = await window.__cogniaReadMessages!()
      return rows
        .filter((row) => row.sessionId === id)
        .map((row) => ({ role: row.role, text: row.text }))
    }, sessionId)
    expect(stored.map((row) => row.role)).toEqual(["user", "assistant"])
    // A stream stage persists its final frame: the whole narration, not a prefix.
    expect(stored[1].text).toBe(
      "Reproducing the failure first. Here is the plan. Applying the fix. Checking again."
    )
  })

  test("stops at the last stage instead of replaying it", async ({ page }) => {
    const { sessionId } = await openStagedSession(page)
    const last = SCRIPT.stages.length - 1
    const final = await advanceTo(page, sessionId, last)
    expect(final).toEqual({ index: last, done: true })
    const count = () =>
      page.evaluate(
        async (id) =>
          (await window.__cogniaReadMessages!()).filter((row) => row.sessionId === id).length,
        sessionId
      )
    const before = await count()
    expect(await advance(page, sessionId)).toEqual({ index: last, done: true })
    expect(await count()).toBe(before)
    await expect(page.getByRole("dialog")).toHaveCount(1)
  })
})
