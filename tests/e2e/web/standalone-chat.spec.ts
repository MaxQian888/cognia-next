/**
 * E2E: ordinary browser standalone (BYOK) chat.
 *
 * This deliberately does not inject Capacitor or Tauri. It proves the plain
 * Web runtime reaches the shared chat pane, executes the browser AI SDK
 * engine against a configured Provider, and restores the durable turn.
 */

import { expect, test, type Page } from "@/tests/e2e/fixtures/test"
import { ensureCogniaAccount, setCogniaSettings, waitForTestGlobals } from "../helpers/db-reset"

interface PersistedChatRow {
  database: string
  role: string
  text: string
}

function anthropicMockBaseUrl(): string {
  const url = process.env.E2E_ANTHROPIC_BASE_URL
  if (!url) {
    throw new Error(
      "E2E_ANTHROPIC_BASE_URL not published — global-setup didn't boot the anthropic mock"
    )
  }
  return `${url.replace(/\/$/, "")}/v1`
}

async function readPersistedChatRows(page: Page) {
  return page.evaluate(async (): Promise<PersistedChatRow[]> => {
    const databases = await indexedDB.databases()
    const rows: PersistedChatRow[] = []
    for (const descriptor of databases) {
      const name = descriptor.name
      if (!name?.startsWith("cognia-account-")) continue
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(name)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      if (!database.objectStoreNames.contains("messages")) {
        database.close()
        continue
      }
      const stored = await new Promise<Array<{ role?: string; parts?: unknown[] }>>(
        (resolve, reject) => {
          const request = database
            .transaction("messages", "readonly")
            .objectStore("messages")
            .getAll()
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
        }
      )
      database.close()
      for (const row of stored) {
        rows.push({
          database: name,
          role: row.role ?? "",
          text: (row.parts ?? [])
            .filter((part): part is { type: "text"; text: string } =>
              Boolean(
                part &&
                typeof part === "object" &&
                (part as { type?: unknown }).type === "text" &&
                typeof (part as { text?: unknown }).text === "string"
              )
            )
            .map((part) => part.text)
            .join(""),
        })
      }
    }
    return rows
  })
}

test.describe("web — standalone chat", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await ensureCogniaAccount(page)
    await page.goto("about:blank")
    await page.goto("/", { waitUntil: "domcontentloaded" })
    await waitForTestGlobals(page, 30_000)
    await setCogniaSettings(page, {
      defaultProvider: "anthropic",
      providerSettings: {
        anthropic: {
          enabled: true,
          apiKey: "test-e2e-key",
          baseURL: anthropicMockBaseUrl(),
        },
      },
    })
  })

  test("@smoke @critical sends, streams, and restores a browser-native turn", async ({ page }) => {
    await page.goto("about:blank")
    await page.goto("/", { waitUntil: "domcontentloaded" })

    await page.getByRole("button", { name: "New chat" }).first().click()
    const picker = page.getByRole("dialog", { name: /pick a character/i })
    await expect(picker).toBeVisible({ timeout: 10_000 })
    await picker.getByRole("option").first().click()

    const composer = page.getByRole("textbox", { name: /message/i }).first()
    await expect(composer).toBeVisible({ timeout: 30_000 })

    await composer.fill("ping from ordinary web standalone")
    await composer.press("Enter")

    await expect(
      page.getByText(/mock-anthropic-echo.*ping from ordinary web standalone/i).first()
    ).toBeVisible({ timeout: 30_000 })
    // The response text can render before the final Dexie transaction commits.
    // The composer returns from Stop to Send only after turnComplete has awaited
    // that durable snapshot, so this is the reload-safe terminal state.
    await expect(page.getByRole("button", { name: "Send" }).first()).toBeVisible({
      timeout: 30_000,
    })
    await expect
      .poll(async () => readPersistedChatRows(page))
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "assistant",
            text: expect.stringMatching(/mock-anthropic-echo.*ping from ordinary web standalone/i),
          }),
        ])
      )

    await page.goto("about:blank")
    await page.goto("/", { waitUntil: "domcontentloaded" })
    await expect(page.getByText("ping from ordinary web standalone").first()).toBeVisible({
      timeout: 20_000,
    })
    await expect(
      page.getByText(/mock-anthropic-echo.*ping from ordinary web standalone/i).first()
    ).toBeVisible({ timeout: 20_000 })
  })
})
