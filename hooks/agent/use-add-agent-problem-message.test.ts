/**
 * @jest-environment jsdom
 */
import { renderHook } from "@testing-library/react"

import en from "@/i18n/messages/en.json"
import zh from "@/i18n/messages/zh-CN.json"
import type { AddAgentFormProblem } from "@/lib/ai/agent/external/config/add-agent-form"

import { useAddAgentProblemMessage } from "./use-add-agent-problem-message"

// Exhaustive by construction: adding a problem code without listing it here
// fails the `satisfies` check, so the suite cannot silently skip one.
const PROBLEMS = {
  unsupportedProtocol: "externalAgent.manager.unsupportedProtocol",
  nameRequired: "externalAgent.settings.nameRequired",
  endpointRequired: "externalAgent.settings.endpointRequired",
  commandRequired: "externalAgent.settings.commandRequired",
  cogniaModelInvalid: "externalAgent.cogniaModel.invalid",
  argumentsInvalid: "externalAgent.settings.argumentsInvalid",
  environmentInvalid: "externalAgent.settings.environmentInvalid",
} satisfies Record<AddAgentFormProblem, string>

function lookup(bundle: unknown, dotted: string): unknown {
  return dotted
    .split(".")
    .reduce<unknown>(
      (cursor, segment) =>
        cursor && typeof cursor === "object"
          ? (cursor as Record<string, unknown>)[segment]
          : undefined,
      bundle
    )
}

describe("useAddAgentProblemMessage", () => {
  const entries = Object.entries(PROBLEMS) as Array<[AddAgentFormProblem, string]>

  it.each(entries)("maps %s to its English message", (problem, path) => {
    const { result } = renderHook(() => useAddAgentProblemMessage())
    const message = result.current(problem)
    expect(typeof message).toBe("string")
    expect(message.length).toBeGreaterThan(0)
    // The jest next-intl mock falls back to the raw key when a message is
    // missing; resolving to the catalogue string proves the key exists.
    expect(message).toBe(lookup(en, path))
    expect(message).not.toBe(path.split(".").pop())
  })

  it.each(entries)("has a zh-CN message for %s", (_problem, path) => {
    const value = lookup(zh, path)
    expect(typeof value).toBe("string")
    expect((value as string).length).toBeGreaterThan(0)
  })

  it("says something different for each problem", () => {
    const { result } = renderHook(() => useAddAgentProblemMessage())
    const messages = entries.map(([problem]) => result.current(problem))
    expect(new Set(messages).size).toBe(entries.length)
  })
})
