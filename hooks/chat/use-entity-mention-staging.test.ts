/** @jest-environment jsdom */

const toastErrorMock = jest.fn()
const toastSuccessMock = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    error: (...a: unknown[]) => toastErrorMock(...a),
    success: (...a: unknown[]) => toastSuccessMock(...a),
  },
}))
jest.mock("next-intl", () => ({
  // Echo the key plus the interpolated title, so an assertion can tell WHICH
  // message fired without pinning the English copy.
  useTranslations: () => (key: string, params?: Record<string, string>) =>
    params?.title ? `${key}:${params.title}` : key,
}))

import { act, renderHook } from "@testing-library/react"

import {
  __resetEntityMentionSourcesForTests,
  registerEntityMentionSource,
  unregisterEntityMentionSource,
  type EntityMentionCandidate,
} from "@/lib/chat/mentions/entity-sources"
import { useChatStore } from "@/stores/chat"
import type { EntitySelectionKind } from "@/types/artifact/artifact"
import { useEntityMentionStaging } from "./use-entity-mention-staging"

const CUSTOM = "custom" as EntitySelectionKind

const candidate: EntityMentionCandidate = {
  entityKind: CUSTOM,
  id: "rec_1",
  title: "The record",
  subtitle: "open",
  searchText: "the record",
}

let snapshot: jest.Mock

function stagedSelections() {
  return useChatStore.getState().contextSelections
}

beforeEach(() => {
  toastErrorMock.mockClear()
  toastSuccessMock.mockClear()
  __resetEntityMentionSourcesForTests()
  useChatStore.getState().clearContextSelections(null)
  snapshot = jest.fn(async () => "the body")
  registerEntityMentionSource({
    entityKind: CUSTOM,
    prefix: "custom:",
    search: async () => [candidate],
    snapshot: (c) => snapshot(c),
  })
})

afterEach(() => {
  unregisterEntityMentionSource(CUSTOM)
  useChatStore.getState().clearContextSelections(null)
})

function render() {
  return renderHook(() => useEntityMentionStaging({ sessionId: null })).result
}

describe("useEntityMentionStaging", () => {
  it("stages the body as a context chip and returns the selection", async () => {
    const stage = render()
    let staged: unknown
    await act(async () => {
      staged = await stage.current(candidate)
    })
    expect(staged).toMatchObject({
      kind: "entity",
      entityKind: CUSTOM,
      entityId: "rec_1",
      title: "The record",
      snapshot: "the body",
    })
    expect(stagedSelections()).toHaveLength(1)
    expect(toastSuccessMock).toHaveBeenCalledWith("entityStaged:The record")
  })

  it("says so and stages nothing when the record has vanished", async () => {
    // An empty chip claiming to carry an issue is worse than no chip — the user
    // would believe the model had read it.
    snapshot.mockResolvedValueOnce(null)
    const stage = render()
    let staged: unknown
    await act(async () => {
      staged = await stage.current(candidate)
    })
    expect(staged).toBeNull()
    expect(stagedSelections()).toHaveLength(0)
    expect(toastErrorMock).toHaveBeenCalledWith("entityEmpty:The record")
  })

  it("treats a whitespace-only body as nothing to read", async () => {
    snapshot.mockResolvedValueOnce("   \n  ")
    const stage = render()
    await act(async () => {
      expect(await stage.current(candidate)).toBeNull()
    })
    expect(stagedSelections()).toHaveLength(0)
  })

  it("reports a failed read instead of swallowing it", async () => {
    snapshot.mockRejectedValueOnce(new Error("db closed"))
    const stage = render()
    await act(async () => {
      expect(await stage.current(candidate)).toBeNull()
    })
    expect(stagedSelections()).toHaveLength(0)
    expect(toastErrorMock).toHaveBeenCalledWith("entityFailed:The record")
  })

  it("reports a source that disappeared between the pick and the read", async () => {
    unregisterEntityMentionSource(CUSTOM)
    const stage = render()
    await act(async () => {
      expect(await stage.current(candidate)).toBeNull()
    })
    expect(toastErrorMock).toHaveBeenCalledWith("entityUnavailable:The record")
  })

  it("carries the subtitle onto the chip", async () => {
    const stage = render()
    await act(async () => {
      await stage.current(candidate)
    })
    expect(stagedSelections()[0]).toMatchObject({ subtitle: "open" })
  })
})
