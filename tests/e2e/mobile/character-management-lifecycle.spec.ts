/**
 * Mobile E2E: paired character management lifecycle (ADR-0056).
 *
 * A desktop-authored character enters through the real Companion sync
 * handler. Editing, deleting, and creating use the product's mobile sheet,
 * local Dexie CRUD, durable outbound queue, and live Companion dispatcher.
 */

import { expect, test, type Page } from "@/tests/e2e/fixtures/test"

import { bootstrapCogniaMobile, readDexieRow, readDexieRows } from "../helpers/db-reset"
import { injectCapacitor } from "../helpers/inject-capacitor"

const SYNCED_CHARACTER_ID = "character-e2e-release-guide"
const UPDATED_NAME = "Release Guide v2"
const CREATED_NAME = "Incident Commander"

interface CapturedRpc {
  command: string
  body: Record<string, unknown>
}

interface CharacterRow {
  id: string
  name: string
  description?: string
  systemPrompt: string
  model?: string
  avatarEmoji?: string
  createdAt: number
  updatedAt: number
}

interface QueueRow {
  id: string
  command: string
  payload: Record<string, unknown>
  status: string
  lastError?: string
}

function mockV2BaseUrl(): string {
  const baseUrl = process.env.E2E_V2_BASE_URL
  if (!baseUrl) throw new Error("E2E_V2_BASE_URL is required for Character Management E2E")
  return baseUrl
}

async function installCharacterDesktop(page: Page): Promise<{ calls: CapturedRpc[] }> {
  const calls: CapturedRpc[] = []
  const baseUrl = mockV2BaseUrl()
  const now = Date.now()
  let deliveredInitialCharacter = false
  const character: CharacterRow = {
    id: SYNCED_CHARACTER_ID,
    name: "Release Guide",
    description: "Coordinates safe releases",
    systemPrompt: "Guide the release with explicit checkpoints.",
    model: "claude-sonnet-4-6",
    avatarEmoji: "🚀",
    createdAt: now - 2_000,
    updatedAt: now,
  }

  await page.route(`${baseUrl}/api/v1/_rpc/**`, async (route) => {
    const request = route.request()
    const command = new URL(request.url()).pathname.split("/").pop() ?? ""
    const body = (request.postDataJSON() ?? {}) as Record<string, unknown>
    calls.push({ command, body })

    if (command === "sync_pull") {
      const shouldDeliver = body.table === "characters" && !deliveredInitialCharacter
      if (shouldDeliver) deliveredInitialCharacter = true
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          rows: shouldDeliver ? [character] : [],
          deleted_ids: [],
          next_since: body.table === "characters" ? now + 1 : 1,
        }),
      })
      return
    }

    if (command === "character_upsert" || command === "character_delete") {
      await route.fulfill({ contentType: "application/json", body: "true" })
      return
    }

    await route.fulfill({ status: 404, contentType: "text/plain", body: "unknown command" })
  })

  return { calls }
}

async function queueStatusFor(
  page: Page,
  command: string,
  characterId: string
): Promise<string> {
  const rows = await readDexieRows<QueueRow>(page, { table: "mobileOutboundQueue" })
  const row = rows.find(
    (candidate) => candidate.command === command && candidate.payload.id === characterId
  )
  return row ? `${row.status}${row.lastError ? `:${row.lastError}` : ""}` : "missing"
}

test.describe("mobile — paired character management", () => {
  test("syncs, edits, deletes, creates, dispatches, and restores characters", async ({ page }) => {
    const desktop = await installCharacterDesktop(page)
    const companionConfig = {
      baseUrl: mockV2BaseUrl(),
      deviceJwt: "e2e-character-jwt",
      deviceId: "device-e2e-character",
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

    await page.goto("/discover?category=characters", { waitUntil: "domcontentloaded" })
    await expect(page.getByTestId("discover-page")).toBeVisible()
    await expect(page.getByTestId(`character-card-${SYNCED_CHARACTER_ID}`)).toContainText(
      "Release Guide"
    )
    await expect
      .poll(() =>
        desktop.calls.find(
          (call) =>
            call.command === "sync_pull" &&
            call.body.table === "characters" &&
            call.body.since === 0
        )
      )
      .toMatchObject({ command: "sync_pull", body: { table: "characters", since: 0 } })

    await page.getByTestId(`character-card-${SYNCED_CHARACTER_ID}`).click()
    await expect(page.getByTestId("character-detail-sheet")).toBeVisible()
    await expect(page.getByTestId("character-name")).toHaveValue("Release Guide")
    await page.getByTestId("character-name").fill(UPDATED_NAME)
    await page.getByTestId("character-description").fill("Coordinates verified releases")
    await page
      .getByTestId("character-system-prompt")
      .fill("Guide releases and require an explicit rollback checkpoint.")
    await page.getByTestId("character-default-model").fill("claude-opus-4-6")
    await page.getByTestId("character-avatar-emoji").fill("🛰️")
    await page.getByTestId("character-save").click()

    await expect(page.getByTestId("character-detail-sheet")).toHaveCount(0)
    await expect(page.getByTestId(`character-card-${SYNCED_CHARACTER_ID}`)).toContainText(
      UPDATED_NAME
    )
    await expect
      .poll(async () =>
        readDexieRow<CharacterRow>(page, {
          table: "characters",
          key: SYNCED_CHARACTER_ID,
        })
      )
      .toMatchObject({
        name: UPDATED_NAME,
        description: "Coordinates verified releases",
        systemPrompt: "Guide releases and require an explicit rollback checkpoint.",
        model: "claude-opus-4-6",
        avatarEmoji: "🛰️",
      })
    await expect
      .poll(() => queueStatusFor(page, "character_upsert", SYNCED_CHARACTER_ID))
      .toBe("sent")
    await expect
      .poll(() =>
        desktop.calls.find(
          (call) => call.command === "character_upsert" && call.body.id === SYNCED_CHARACTER_ID
        )
      )
      .toMatchObject({
        command: "character_upsert",
        body: {
          id: SYNCED_CHARACTER_ID,
          draft: {
            name: UPDATED_NAME,
            description: "Coordinates verified releases",
            systemPrompt: "Guide releases and require an explicit rollback checkpoint.",
            model: "claude-opus-4-6",
            avatarEmoji: "🛰️",
          },
        },
      })

    await page.getByTestId(`character-card-${SYNCED_CHARACTER_ID}`).click()
    await expect(page.getByTestId("character-detail-sheet")).toBeVisible()
    await page.getByTestId("character-delete").click()
    await expect(page.getByTestId("character-detail-sheet")).toHaveCount(0)
    await expect(page.getByTestId(`character-card-${SYNCED_CHARACTER_ID}`)).toHaveCount(0)
    await expect
      .poll(() =>
        readDexieRow<CharacterRow>(page, { table: "characters", key: SYNCED_CHARACTER_ID })
      )
      .toBeUndefined()
    await expect
      .poll(() => queueStatusFor(page, "character_delete", SYNCED_CHARACTER_ID))
      .toBe("sent")
    await expect
      .poll(() =>
        desktop.calls.find(
          (call) => call.command === "character_delete" && call.body.id === SYNCED_CHARACTER_ID
        )
      )
      .toMatchObject({ command: "character_delete", body: { id: SYNCED_CHARACTER_ID } })

    await page.getByTestId("character-create-fab").click()
    await page.getByTestId("character-name").fill(CREATED_NAME)
    await page
      .getByTestId("character-system-prompt")
      .fill("Coordinate incidents and publish verified status updates.")
    await page.getByTestId("character-avatar-emoji").fill("🚨")
    await page.getByTestId("character-save").click()

    await expect(page.getByTestId("character-detail-sheet")).toHaveCount(0)
    await expect
      .poll(() =>
        desktop.calls.find(
          (call) =>
            call.command === "character_upsert" &&
            (call.body.draft as Record<string, unknown> | undefined)?.name === CREATED_NAME
        )
      )
      .toMatchObject({
        command: "character_upsert",
        body: {
          draft: {
            name: CREATED_NAME,
            systemPrompt: "Coordinate incidents and publish verified status updates.",
            avatarEmoji: "🚨",
          },
        },
      })

    const createdRpc = desktop.calls.find(
      (call) =>
        call.command === "character_upsert" &&
        (call.body.draft as Record<string, unknown> | undefined)?.name === CREATED_NAME
    )
    const createdId = createdRpc?.body.id
    expect(typeof createdId).toBe("string")
    await expect(page.getByTestId(`character-card-${createdId as string}`)).toContainText(
      CREATED_NAME
    )
    await expect
      .poll(() => queueStatusFor(page, "character_upsert", createdId as string))
      .toBe("sent")

    await page.reload({ waitUntil: "domcontentloaded" })
    await expect(page.getByTestId(`character-card-${SYNCED_CHARACTER_ID}`)).toHaveCount(0)
    await expect(page.getByTestId(`character-card-${createdId as string}`)).toContainText(
      CREATED_NAME
    )
  })
})
