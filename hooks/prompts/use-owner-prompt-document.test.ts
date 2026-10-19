/** @jest-environment jsdom */

import "fake-indexeddb/auto"
import { act, renderHook, waitFor } from "@testing-library/react"
import { createPreset, updatePreset } from "@/lib/db/prompt-presets"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { presetPromptAdapter } from "@/lib/prompts/adapters/presets"
import { resourceKey } from "@/lib/prompts/resources"
import { useOwnerPromptDocument } from "./use-owner-prompt-document"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)
afterEach(() => jest.restoreAllMocks())

const ctx = {}

it("reads the owner's text and rereads on reload", async () => {
  const preset = await createPreset({ name: "Mine", content: "First." })
  const key = resourceKey("preset", preset.id)
  const { result } = renderHook(() => useOwnerPromptDocument(key, ctx))
  await waitFor(() =>
    expect(result.current.state).toEqual({ status: "ready", document: { key, text: "First." } })
  )
  await updatePreset(preset.id, { content: "Second." })
  act(() => result.current.reload())
  await waitFor(() =>
    expect(result.current.state).toEqual({ status: "ready", document: { key, text: "Second." } })
  )
})

it("starts over from loading when the key changes", async () => {
  const one = await createPreset({ name: "One", content: "1" })
  const two = await createPreset({ name: "Two", content: "2" })
  const { result, rerender } = renderHook(({ key }) => useOwnerPromptDocument(key, ctx), {
    initialProps: { key: resourceKey("preset", one.id) },
  })
  await waitFor(() => expect(result.current.state.status).toBe("ready"))
  rerender({ key: resourceKey("preset", two.id) })
  expect(result.current.state.status).toBe("loading")
  await waitFor(() =>
    expect(result.current.state).toMatchObject({ status: "ready", document: { text: "2" } })
  )
})

it("reports missing resources, unknown sources and read failures", async () => {
  const missing = renderHook(() => useOwnerPromptDocument(resourceKey("preset", "gone"), ctx))
  await waitFor(() => expect(missing.result.current.state.status).toBe("missing"))
  const unknown = renderHook(() => useOwnerPromptDocument("nonsense:x", ctx))
  expect(unknown.result.current.state.status).toBe("missing")

  jest.spyOn(presetPromptAdapter, "read").mockRejectedValue(new Error("locked"))
  const failed = renderHook(() => useOwnerPromptDocument(resourceKey("preset", "p"), ctx))
  await waitFor(() =>
    expect(failed.result.current.state).toEqual({ status: "error", error: "locked" })
  )
})
