/** @jest-environment jsdom */

import { act, renderHook } from "@testing-library/react"
import {
  __resetPromptResolutionsForTests,
  recordPromptResolution,
} from "@/lib/prompts/resolution-log"
import { useLastPromptResolution } from "./use-last-prompt-resolution"

beforeEach(() => __resetPromptResolutionsForTests())

it("shows the latest resolution of the prompt and ignores others", () => {
  const { result } = renderHook(() => useLastPromptResolution("chat.brief-mode"))
  expect(result.current).toBeUndefined()
  act(() => {
    recordPromptResolution({
      promptId: "generation.title.chat",
      source: { kind: "default" },
      context: {},
      at: 1,
    })
  })
  expect(result.current).toBeUndefined()
  const record = {
    promptId: "chat.brief-mode",
    source: {
      kind: "override" as const,
      scope: "account" as const,
      bindingId: "b",
      revisionId: "r",
    },
    context: { sessionId: "s1" },
    at: 2,
  }
  act(() => recordPromptResolution(record))
  expect(result.current).toEqual(record)
})
