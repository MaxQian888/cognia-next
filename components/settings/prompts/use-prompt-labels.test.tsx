/** @jest-environment jsdom */

const mockMessages: Record<string, Record<string, unknown>> = {
  "settings.promptCenter": { scope: { workspace: "Workspace" } },
  "settings.promptEntries": {
    generation__title__chat: { title: "Chat title", description: "Names a chat." },
  },
}
jest.mock("next-intl", () => ({
  useTranslations: (namespace: string) => {
    const root = mockMessages[namespace]
    const lookup = (key: string) =>
      key
        .split(".")
        .reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], root)
    const t = (key: string) => (typeof lookup(key) === "string" ? lookup(key) : key)
    t.has = (key: string) => typeof lookup(key) === "string"
    return t
  },
}))

import { renderHook } from "@testing-library/react"
import { promptEntryKey, usePromptLabels } from "./use-prompt-labels"

it("turns dotted ids into flat message keys", () => {
  expect(promptEntryKey("generation.title.chat")).toBe("generation__title__chat")
  expect(promptEntryKey("agent.plan-mode")).toBe("agent__plan-mode")
})

it("labels entries from their messages and falls back to the id", () => {
  const { result } = renderHook(() => usePromptLabels())
  expect(result.current.entryTitle("generation.title.chat")).toBe("Chat title")
  expect(result.current.entryDescription("generation.title.chat")).toBe("Names a chat.")
  expect(result.current.entryTitle("unknown.entry")).toBe("unknown.entry")
  expect(result.current.entryDescription("unknown.entry")).toBe("")
  expect(result.current.t("scope.workspace")).toBe("Workspace")
})
