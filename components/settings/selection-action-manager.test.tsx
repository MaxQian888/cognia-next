/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"

import {
  mergeRetainedSelectionActionOrder,
  moveSelectionActionId,
  SelectionActionManager,
} from "./selection-action-manager"

jest.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations: () => (key: string, vars?: Record<string, string>) =>
    vars?.title ? `${key}:${vars.title}` : key,
}))

jest.mock("@/lib/i18n/plugin-i18n-registry", () => ({
  lookupPluginMessage: () => "Localized plugin rewrite",
}))

const setPrefMock = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/tauri/store", () => ({
  getPref: jest.fn(async (key: string) =>
    key === "selectionToolbar.actionLayout.v1"
      ? { ordered: ["missing-plugin:retained"], hidden: [], pinned: [] }
      : []
  ),
  setPref: (...args: unknown[]) => setPrefMock(...args),
}))

jest.mock("@/lib/plugin/registries/quick-action-registry", () => {
  const entries = [
    {
      id: "rewrite",
      fullId: "plug-a:rewrite",
      pluginId: "plug-a",
      commandId: "_qa:plug-a:rewrite",
      title: "Plugin rewrite",
      labelKey: "surfaces.selectionReplace",
      surfaces: ["selection"],
      selection: { input: "text", output: "replace" },
    },
    {
      id: "preview",
      fullId: "plug-b:preview",
      pluginId: "plug-b",
      commandId: "_qa:plug-b:preview",
      title: "Preview action",
      surfaces: ["selection"],
      selection: { input: "metadata", output: "preview" },
    },
    {
      id: "palette",
      fullId: "plug-c:palette",
      pluginId: "plug-c",
      commandId: "qa:plug-c:palette",
      title: "Palette only",
      surfaces: ["palette"],
    },
  ]
  return {
    subscribeQuickActions: () => jest.fn(),
    getQuickActionSnapshot: () => entries,
  }
})

const bindShortcutMock = jest.fn().mockResolvedValue({ ok: true })
jest.mock("@/lib/shortcuts/registry", () => ({
  useShortcutStore: {
    getState: () => ({ bind: (...args: unknown[]) => bindShortcutMock(...args) }),
  },
}))

it("manages visibility, pinning, direct replacement consent, and scoped shortcuts", async () => {
  render(<SelectionActionManager replaceAvailable />)
  const row = await screen.findByRole("group", { name: "Localized plugin rewrite" })

  fireEvent.click(within(row).getByRole("switch", { name: "enabled:Localized plugin rewrite" }))
  await waitFor(() =>
    expect(setPrefMock).toHaveBeenCalledWith(
      "selectionToolbar.actionLayout.v1",
      expect.objectContaining({ hidden: ["plug-a:rewrite"] })
    )
  )
  fireEvent.click(within(row).getByRole("switch", { name: "enabled:Localized plugin rewrite" }))

  fireEvent.click(within(row).getByRole("switch", { name: "pinned:Localized plugin rewrite" }))
  fireEvent.click(within(row).getByRole("button", { name: "moveUp:Localized plugin rewrite" }))
  await waitFor(() =>
    expect(setPrefMock).toHaveBeenCalledWith(
      "selectionToolbar.actionLayout.v1",
      expect.objectContaining({ ordered: expect.arrayContaining(["plug-a:rewrite"]) })
    )
  )
  fireEvent.click(within(row).getByRole("switch", { name: "pinned:Localized plugin rewrite" }))
  fireEvent.click(
    within(row).getByRole("switch", { name: "directReplace:Localized plugin rewrite" })
  )
  fireEvent.change(
    within(row).getByRole("textbox", { name: "shortcut:Localized plugin rewrite" }),
    {
      target: { value: "alt+shift+r" },
    }
  )
  fireEvent.click(
    within(row).getByRole("button", { name: "saveShortcut:Localized plugin rewrite" })
  )

  await waitFor(() =>
    expect(bindShortcutMock).toHaveBeenCalledWith({
      id: "selection.action:plug-a:rewrite",
      chord: "alt+shift+r",
    })
  )
  expect(setPrefMock).toHaveBeenCalledWith("selectionToolbar.directReplaceAllowlist.v1", [
    "plug-a:rewrite",
  ])
  fireEvent.click(
    within(row).getByRole("switch", { name: "directReplace:Localized plugin rewrite" })
  )
  await waitFor(() =>
    expect(setPrefMock).toHaveBeenCalledWith("selectionToolbar.directReplaceAllowlist.v1", [])
  )
})

it("ignores an empty shortcut instead of registering a dead chord", async () => {
  render(<SelectionActionManager replaceAvailable />)
  const row = await screen.findByRole("group", { name: "copy" })
  expect(within(row).getByRole("button", { name: "moveUp:copy" })).toBeDisabled()
  expect(within(row).getByRole("button", { name: "moveDown:copy" })).toBeDisabled()
  expect(within(row).getByRole("switch", { name: "enabled:copy" })).toBeDisabled()
  expect(within(row).getByRole("switch", { name: "pinned:copy" })).toBeDisabled()
  fireEvent.click(within(row).getByRole("button", { name: "saveShortcut:copy" }))
  expect(bindShortcutMock).not.toHaveBeenCalled()
})

it("renders the direct-replace switch inert when the build cannot replace", async () => {
  // No build sets COGNIA_SELECTION_REPLACE, so `replaceAvailable` is false and
  // the switch must say so rather than accept a preference nothing can honour.
  render(<SelectionActionManager replaceAvailable={false} />)
  const row = await screen.findByRole("group", { name: "Localized plugin rewrite" })
  const toggle = within(row).getByRole("switch", {
    name: "directReplaceUnavailable:Localized plugin rewrite",
  })
  expect(toggle).toBeDisabled()
  expect(toggle).not.toBeChecked()
  fireEvent.click(toggle)
  expect(setPrefMock).not.toHaveBeenCalledWith(
    "selectionToolbar.directReplaceAllowlist.v1",
    expect.arrayContaining(["plug-a:rewrite"])
  )
})

it("keeps ordering stable when a move would leave the list", () => {
  expect(moveSelectionActionId(["copy", "ask"], "copy", -1)).toEqual(["copy", "ask"])
  expect(moveSelectionActionId(["copy", "ask"], "missing", 1)).toEqual(["copy", "ask"])
  expect(moveSelectionActionId(["copy", "ask"], "copy", 1)).toEqual(["ask", "copy"])
})

it("keeps inactive plugin ids in place while reordering visible actions", () => {
  expect(
    mergeRetainedSelectionActionOrder(
      ["copy", "missing-plugin:retained", "ask"],
      ["ask", "copy", "translate"]
    )
  ).toEqual(["ask", "missing-plugin:retained", "copy", "translate"])
})
