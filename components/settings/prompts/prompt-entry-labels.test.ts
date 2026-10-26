/**
 * Every catalog entry is named in both locales, and no label outlives its
 * entry. Entry labels are keyed by `promptEntryKey(id)`; a new definition
 * without a label would show its raw id in the Prompt Center.
 */

import en from "@/i18n/messages/en/settings/promptEntries.json"
import zh from "@/i18n/messages/zh-CN/settings/promptEntries.json"
import { listPromptDefinitions } from "@/lib/prompts/catalog"
import { promptEntryKey } from "./use-prompt-labels"

const expected = listPromptDefinitions()
  .map((def) => promptEntryKey(def.id))
  .sort()

describe.each([
  ["en", en as Record<string, { title?: unknown; description?: unknown }>],
  ["zh-CN", zh as Record<string, { title?: unknown; description?: unknown }>],
])("settings.promptEntries (%s)", (_locale, labels) => {
  it("labels exactly the catalog's entries", () => {
    expect(Object.keys(labels).sort()).toEqual(expected)
  })

  it("gives every entry a title and a description", () => {
    for (const key of expected) {
      expect(typeof labels[key]?.title).toBe("string")
      expect(typeof labels[key]?.description).toBe("string")
      expect(String(labels[key]?.title).trim()).not.toBe("")
    }
  })

  it("keeps sibling titles distinct", () => {
    const titles = Object.values(labels).map((entry) => entry.title)
    expect(new Set(titles).size).toBe(titles.length)
  })
})
