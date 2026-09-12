import { expect, test, type Page } from "@/tests/e2e/fixtures/test"
import { installCollabScenario, GUEST_ID } from "../helpers/shared-chat"
import {
  ensureCogniaAccount,
  waitForTestGlobals,
  setCogniaSettings,
  readDexieRows,
} from "../helpers/db-reset"

async function configureStandaloneChat(page: Page) {
  await page.goto("/")
  await ensureCogniaAccount(page)
  await page.goto("about:blank")
  await page.goto("/", { waitUntil: "domcontentloaded" })
  await waitForTestGlobals(page, 30_000)
  await setCogniaSettings(page, {
    onboardingProgress: { version: 2, path: "completed", completedAt: "2026-09-07T00:00:00.000Z" },
    defaultProvider: "anthropic",
    providerSettings: {
      anthropic: {
        enabled: true,
        apiKey: "test-e2e-key",
        baseURL: `${process.env.E2E_ANTHROPIC_BASE_URL}/v1`,
      },
    },
  })
  await page.goto("about:blank")
  await page.goto("/", { waitUntil: "domcontentloaded" })
  await page.getByRole("button", { name: "New chat" }).first().click()
  const picker = page.getByRole("dialog", { name: /pick a character/i })
  await expect(picker).toBeVisible()
  await picker.getByRole("option").first().click()
  await expect(page.getByRole("textbox", { name: /message/i }).first()).toBeVisible()
}

test.describe("web — shared AI chat", () => {
  test.beforeEach(async ({ page }) => {
    await installCollabScenario(page)
    await configureStandaloneChat(page)
  })

  test("@critical imports full history only after explicit confirmation", async ({ page }) => {
    await page.getByRole("button", { name: "Open private conversation controls" }).click()
    await expect(page.getByText(/0 messages and 0 attachments/i)).toBeVisible()
    await expect(page.getByText(/Everyone invited later can read the full history/i)).toBeVisible()
    await page.getByRole("button", { name: /convert and share/i }).click()
    await expect(page.getByText(/conversation is now shared/i)).toBeVisible()

    await page.reload({ waitUntil: "domcontentloaded" })
    await expect(
      page.getByRole("button", { name: "Open shared conversation controls" })
    ).toBeVisible()
  })

  test("@critical manages Guest, queue, and high-risk approval from the shared drawer", async ({
    page,
  }) => {
    await page.getByRole("button", { name: "Open private conversation controls" }).click()
    await page.getByRole("button", { name: /convert and share/i }).click()
    await page.reload({ waitUntil: "domcontentloaded" })

    await page.getByRole("button", { name: "Open shared conversation controls" }).click()
    await expect(page.getByText("External Reviewer")).toBeVisible()
    await expect(
      page.getByRole("region", { name: "Members (2)" }).getByText("External guest")
    ).toBeVisible()
    await expect(page.getByText(/#1 queued by/)).toBeVisible()
    await expect(page.getByText("delete production artifact")).toBeVisible()

    await page.getByRole("button", { name: "Approve", exact: true }).click()
    await expect(page.getByText("delete production artifact")).toHaveCount(0)

    await page.getByRole("checkbox", { name: "External guest" }).check()
    await page.getByRole("button", { name: /create invite/i }).click()
    await expect(page.getByRole("button", { name: "Copy one-time invite token" })).toBeVisible()

    await page
      .getByRole("region", { name: "Members (2)" })
      .getByRole("button", { name: "Remove", exact: true })
      .click()
    await expect(page.getByText("External Reviewer")).toHaveCount(0)
  })
})

test("@critical ordinary Send persists once and Request AI references that message", async ({
  page,
}) => {
  const scenario = await installCollabScenario(page)
  await configureStandaloneChat(page)
  await page.getByRole("button", { name: "Open private conversation controls" }).click()
  await page.getByRole("button", { name: /convert and share/i }).click()
  await expect(
    page.getByRole("button", { name: "Open shared conversation controls" })
  ).toBeVisible()
  const composer = page.getByRole("textbox", { name: /message/i }).first()
  await composer.fill("Discuss before asking AI")
  await composer.press("Enter")
  await expect
    .poll(() => scenario.events.filter((event) => event.kind === "message.created").length)
    .toBe(1)
  expect(
    scenario.requests.filter(
      (request) => request.method === "POST" && request.pathname.endsWith("/queue")
    )
  ).toHaveLength(0)
  await page.getByRole("button", { name: "Request AI", exact: true }).click()
  await expect
    .poll(
      () =>
        scenario.requests.filter(
          (request) => request.method === "POST" && request.pathname.endsWith("/queue")
        ).length
    )
    .toBe(1)
  const message = scenario.events[0].payload as { messageId: string }
  expect(scenario.queue.at(-1)?.payload).toMatchObject({ messageId: message.messageId })
  expect(scenario.events.filter((event) => event.kind === "message.created")).toHaveLength(1)
})

test("@critical a second participant joins by invitation and receives the first participant's messages", async ({
  page,
  browser,
}) => {
  const scenario = await installCollabScenario(page)
  await configureStandaloneChat(page)
  await page.getByRole("button", { name: "Open private conversation controls" }).click()
  await page.getByRole("button", { name: /convert and share/i }).click()
  await expect(
    page.getByRole("button", { name: "Open shared conversation controls" })
  ).toBeVisible()
  const otherContext = await browser.newContext({
    baseURL: new URL(page.url()).origin,
    locale: "en-US",
  })
  try {
    const other = await otherContext.newPage()
    await installCollabScenario(other, scenario, GUEST_ID)
    await configureStandaloneChat(other)
    await other.getByRole("button", { name: "Join shared conversation", exact: true }).click()
    const join = other.getByRole("dialog", { name: "Join shared conversation", exact: true })
    await join.getByLabel("Invitation token").fill("invite-secret-visible-once")
    await join.getByRole("button", { name: "Join shared conversation", exact: true }).click()
    await expect(
      other.getByRole("button", { name: "Open shared conversation controls" })
    ).toBeVisible()
    await expect(other.getByRole("status").filter({ hasText: /^Connected$/ })).toBeVisible()
    const composer = page.getByRole("textbox", { name: /message/i }).first()
    await composer.fill("Shared message from the first participant")
    await composer.press("Enter")
    await expect
      .poll(() => scenario.events.filter((event) => event.kind === "message.created").length)
      .toBe(1)
    await expect(
      other.getByText("Shared message from the first participant", { exact: true }).first()
    ).toBeVisible()
    expect(scenario.events.filter((event) => event.kind === "message.created")).toHaveLength(1)

    // Keep the shared tab open while viewing a different local conversation.
    await other.getByRole("button", { name: "New chat" }).first().click()
    const picker = other.getByRole("dialog", { name: /pick a character/i })
    await expect(picker).toBeVisible()
    await picker.getByRole("option").first().click()
    await expect(
      other.getByRole("button", { name: "Open private conversation controls" })
    ).toBeVisible()
    const previousMessages = await readDexieRows<{ id: string }>(other, { table: "messages" })
    await composer.fill("Shared message while the other tab is active")
    await composer.press("Enter")
    // Message payloads are encrypted at rest; observe the durable row addition
    // without bypassing the profile's encryption boundary.
    await expect
      .poll(async () => {
        const messages = await readDexieRows<{ id: string }>(other, { table: "messages" })
        return messages.filter(
          (message) => !previousMessages.some((prior) => prior.id === message.id)
        ).length
      })
      .toBe(1)
    expect(scenario.events.filter((event) => event.kind === "message.created")).toHaveLength(2)
  } finally {
    if (test.info().status !== test.info().expectedStatus) {
      const other = otherContext.pages()[0]
      const diagnostic = await other?.evaluate(async () => {
        const databases = await indexedDB.databases()
        return Promise.all(
          databases
            .filter((entry) => entry.name?.startsWith("cognia"))
            .map(async (entry) => {
              const db = await new Promise<IDBDatabase>((resolve, reject) => {
                const request = indexedDB.open(entry.name!)
                request.onsuccess = () => resolve(request.result)
                request.onerror = () => reject(request.error)
              })
              try {
                const rows: Record<string, unknown> = { name: db.name }
                for (const table of ["collabChatSyncStates", "sessions", "messages"]) {
                  if (!db.objectStoreNames.contains(table)) continue
                  rows[table] = await new Promise((resolve, reject) => {
                    const request = db.transaction(table).objectStore(table).getAll()
                    request.onsuccess = () => resolve(request.result)
                    request.onerror = () => reject(request.error)
                  })
                }
                return rows
              } finally {
                db.close()
              }
            })
        )
      })
      await test.info().attach("shared-projection-state", {
        body: JSON.stringify(diagnostic),
        contentType: "application/json",
      })
    }
    await otherContext.close()
  }
})
