/**
 * CharacterPackUpdateDialog tests (ADR-0030 v50).
 *
 * Pinned to the public contract: open the dialog with a characterId,
 * the diff preview renders three buckets (will-overwrite, preserved,
 * no-baseline warning), and the Apply button triggers the onConfirm
 * callback exactly once.
 */

import "fake-indexeddb/auto"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { CharacterPackUpdateDialog } from "./character-pack-update-dialog"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import {
  __resetCharacterPacksForTesting,
  buildOverlayCharacterId,
  registerCharacterPack,
} from "@/lib/plugin/registries/character-pack-registry"
import { duplicateCharacter } from "@/lib/db/characters"
import type {
  PluginCharacterDef,
  PluginCharacterPackDef,
} from "@/types/plugin/plugin-character-pack"

const PLUGIN_ID = "demo"
const PACK_ID = "demo-pack"

function makeChar(over: Partial<PluginCharacterDef> = {}): PluginCharacterDef {
  return {
    localId: "alice",
    name: "Alice",
    avatarColor: "x",
    systemPrompt: "v1",
    description: "v1 desc",
    ...over,
  }
}

function makePack(
  ch: PluginCharacterDef,
  over: Partial<PluginCharacterPackDef> = {}
): PluginCharacterPackDef {
  return { id: PACK_ID, name: "Demo", version: "1.0.0", characters: [ch], ...over }
}

// next-intl is mocked in `jest.setup.ts` to resolve keys against the real
// `i18n/messages/en.json`. NextIntlClientProvider becomes a no-op pass-through
// — wrapping with it is unnecessary and confusing. We rely on the canonical
// English strings emitted by the production messages bundle.
function renderDialog(props: Parameters<typeof CharacterPackUpdateDialog>[0]) {
  return render(<CharacterPackUpdateDialog {...props} />)
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  await getDb().characters.clear()
  __resetCharacterPacksForTesting()
})

describe("CharacterPackUpdateDialog", () => {
  it("renders will-overwrite + preserved columns when there are diffs", async () => {
    registerCharacterPack(PACK_ID, makePack(makeChar()), { pluginId: PLUGIN_ID })
    const clone = await duplicateCharacter(buildOverlayCharacterId(PLUGIN_ID, PACK_ID, "alice"))
    // User edited systemPrompt.
    await getDb().characters.update(clone.id, { systemPrompt: "MY EDIT" })
    // New pack version differs on systemPrompt and description.
    registerCharacterPack(
      PACK_ID,
      makePack(makeChar({ systemPrompt: "v2", description: "v2 desc" }), { version: "2.0.0" }),
      { pluginId: PLUGIN_ID }
    )

    const onCancel = jest.fn()
    const onConfirm = jest.fn().mockResolvedValue(undefined)
    renderDialog({
      open: true,
      characterId: clone.id,
      characterName: clone.name,
      onCancel,
      onConfirm,
    })

    await waitFor(() => expect(screen.queryByText("Will overwrite")).toBeInTheDocument())
    expect(screen.getByText("Preserved (you edited it)")).toBeInTheDocument()
    // description sits in willOverwrite, systemPrompt in preserved. Both
    // appear as <code>-style monospace field-name rows.
    expect(screen.getByText("description")).toBeInTheDocument()
    expect(screen.getByText("systemPrompt")).toBeInTheDocument()
  })

  it("shows the no-baseline warning when pristineSnapshot is missing", async () => {
    registerCharacterPack(PACK_ID, makePack(makeChar()), { pluginId: PLUGIN_ID })
    const clone = await duplicateCharacter(buildOverlayCharacterId(PLUGIN_ID, PACK_ID, "alice"))
    await getDb()
      .characters.where("id")
      .equals(clone.id)
      .modify((obj) => {
        const r = obj as unknown as Record<string, unknown>
        delete r.pristineSnapshot
      })
    registerCharacterPack(
      PACK_ID,
      makePack(makeChar({ systemPrompt: "v2" }), { version: "2.0.0" }),
      { pluginId: PLUGIN_ID }
    )

    renderDialog({
      open: true,
      characterId: clone.id,
      characterName: clone.name,
      onCancel: jest.fn(),
      onConfirm: jest.fn().mockResolvedValue(undefined),
    })

    // Real en.json copy includes additional wording; assert on the
    // load-bearing prefix so this doesn't bit-rot on phrasing tweaks.
    await waitFor(() =>
      expect(screen.queryByText(/This clone has no recorded baseline/)).toBeInTheDocument()
    )
  })

  it("calls onConfirm when the user clicks Apply", async () => {
    const user = userEvent.setup()
    registerCharacterPack(PACK_ID, makePack(makeChar()), { pluginId: PLUGIN_ID })
    const clone = await duplicateCharacter(buildOverlayCharacterId(PLUGIN_ID, PACK_ID, "alice"))
    registerCharacterPack(
      PACK_ID,
      makePack(makeChar({ systemPrompt: "v2" }), { version: "2.0.0" }),
      { pluginId: PLUGIN_ID }
    )

    const onConfirm = jest.fn().mockResolvedValue(undefined)
    renderDialog({
      open: true,
      characterId: clone.id,
      characterName: clone.name,
      onCancel: jest.fn(),
      onConfirm,
    })

    const applyBtn = await screen.findByRole("button", { name: /Apply update/ })
    await user.click(applyBtn)
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it("calls onCancel when the user clicks Cancel", async () => {
    const user = userEvent.setup()
    registerCharacterPack(PACK_ID, makePack(makeChar()), { pluginId: PLUGIN_ID })
    const clone = await duplicateCharacter(buildOverlayCharacterId(PLUGIN_ID, PACK_ID, "alice"))
    registerCharacterPack(
      PACK_ID,
      makePack(makeChar({ systemPrompt: "v2" }), { version: "2.0.0" }),
      { pluginId: PLUGIN_ID }
    )

    const onCancel = jest.fn()
    renderDialog({
      open: true,
      characterId: clone.id,
      characterName: clone.name,
      onCancel,
      onConfirm: jest.fn(),
    })

    const cancelBtn = await screen.findByRole("button", { name: /Cancel/ })
    await user.click(cancelBtn)
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it("renders the no-op note when the row isn't a clone", async () => {
    // Insert a plain user-created row.
    await getDb().characters.add({
      id: "char_plain",
      name: "Plain",
      avatarColor: "x",
      systemPrompt: "x",
      createdAt: 0,
      updatedAt: 0,
    })

    renderDialog({
      open: true,
      characterId: "char_plain",
      characterName: "Plain",
      onCancel: jest.fn(),
      onConfirm: jest.fn(),
    })

    // The production en.json wraps the name in double quotes; assert on
    // the human-recognisable phrasing rather than the exact quoting.
    await waitFor(() =>
      expect(screen.queryByText(/Nothing to update for ['"]Plain['"]\./)).toBeInTheDocument()
    )
  })
})
