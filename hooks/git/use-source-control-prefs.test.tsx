/**
 * @jest-environment jsdom
 */

import { act, renderHook } from "@testing-library/react"

import { useSourceControlPrefs } from "./use-source-control-prefs"
import { useSettingsStore } from "@/stores/settings/settings-store"
import {
  DEFAULT_SOURCE_CONTROL_PANEL_PREFS,
  type PartialSourceControlPanelPrefs,
} from "@/lib/git/panel-prefs"
import type { GitCommitAiSettings } from "@/types/git"

// Apply the patch back into the store (as the real `save` does) so `prefs`
// re-resolves between sequential setter calls and accumulation is exercised.
const saveMock = jest.fn(async (patch?: { gitSettings?: unknown }) => {
  const cur = useSettingsStore.getState().settings
  useSettingsStore.setState({ settings: { ...cur, ...patch } as never })
})

const COMMIT_AI: GitCommitAiSettings = { enabled: true, conventionalCommits: true }

const setStored = (panel?: PartialSourceControlPanelPrefs) =>
  useSettingsStore.setState({
    settings: { gitSettings: { commitMessageAI: COMMIT_AI, panel } } as never,
    save: saveMock as never,
  })

const lastSaved = () =>
  saveMock.mock.calls[saveMock.mock.calls.length - 1]?.[0] as
    { gitSettings?: { commitMessageAI?: GitCommitAiSettings; panel?: unknown } } | undefined

beforeEach(() => {
  saveMock.mockClear()
  setStored(undefined)
})

describe("useSourceControlPrefs", () => {
  it("resolves the defaults when nothing is stored", () => {
    const { result } = renderHook(() => useSourceControlPrefs())
    expect(result.current.prefs).toEqual(DEFAULT_SOURCE_CONTROL_PANEL_PREFS)
    expect(result.current.isDefault).toBe(true)
  })

  it("reflects persisted prefs and reports non-default", () => {
    setStored({ diffView: "inline", autoFetch: true })
    const { result } = renderHook(() => useSourceControlPrefs())
    expect(result.current.prefs.diffView).toBe("inline")
    expect(result.current.prefs.autoFetch).toBe(true)
    expect(result.current.isDefault).toBe(false)
  })

  it("persists a knob without clobbering the sibling commitMessageAI block", async () => {
    const { result } = renderHook(() => useSourceControlPrefs())
    await act(async () => {
      await result.current.setDiffView("inline")
    })
    expect(lastSaved()?.gitSettings?.commitMessageAI).toEqual(COMMIT_AI)
    expect(lastSaved()?.gitSettings?.panel).toMatchObject({ diffView: "inline" })
  })

  it("merges over existing panel prefs", async () => {
    setStored({ smartCommit: true })
    const { result } = renderHook(() => useSourceControlPrefs())
    await act(async () => {
      await result.current.setPostCommit("push")
    })
    expect(lastSaved()?.gitSettings?.panel).toMatchObject({ smartCommit: true, postCommit: "push" })
  })

  it("exposes setters for every knob", async () => {
    const { result } = renderHook(() => useSourceControlPrefs())
    await act(async () => {
      await result.current.setIgnoreWhitespace(true)
      await result.current.setConfirmDiscard(false)
      await result.current.setConfirmForcePush(false)
      await result.current.setSmartCommit(true)
      await result.current.setPullRebase(true)
      await result.current.setFetchPrune(true)
      await result.current.setAutoFetch(true)
      await result.current.setAutoFetchInterval(30)
      await result.current.setBranchSort("name")
      await result.current.setDefaultTimelineView("graph")
    })
    expect(lastSaved()?.gitSettings?.panel).toMatchObject({
      ignoreWhitespace: true,
      confirmDiscard: false,
      confirmForcePush: false,
      smartCommit: true,
      pullRebase: true,
      fetchPrune: true,
      autoFetch: true,
      autoFetchIntervalMinutes: 30,
      branchSort: "name",
      defaultTimelineView: "graph",
    })
  })

  it("reset writes the factory defaults", async () => {
    setStored({ diffView: "inline", autoFetch: true })
    const { result } = renderHook(() => useSourceControlPrefs())
    await act(async () => {
      await result.current.reset()
    })
    expect(lastSaved()?.gitSettings?.panel).toEqual(DEFAULT_SOURCE_CONTROL_PANEL_PREFS)
  })
})
