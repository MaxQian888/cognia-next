/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => `t:${key}`,
  useLocale: () => "en",
}))
let mirrored = false
jest.mock("@/lib/plugin/core/mirrored-client", () => ({ isMirroredPluginClient: () => mirrored }))

import { act, renderHook, waitFor } from "@testing-library/react"

import { createDbTestFixture } from "@/lib/db/test-fixture"
import { createCogset, updateCogsetState } from "@/lib/db/plugin-cogsets"
import { upsertPlugin } from "@/lib/db/plugins"
import { useCogsetSessionStore } from "@/stores/plugins/cogset-session-store"
import { useProjectStore } from "@/stores/project/project-store"

import { useCogsetDisplayName, useCogsets, useInstalledPluginSummaries } from "./use-cogsets"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  mirrored = false
  useCogsetSessionStore.getState().clearOverride()
  useProjectStore.setState({ activeProjectId: null, projects: [] })
})
afterAll(dbFixture.dispose)

describe("useCogsets", () => {
  it("resolves the effective cogset by session, workspace, then global", async () => {
    const global = await createCogset({ name: "Global", members: [], source: { kind: "manual" } })
    const bound = await createCogset({ name: "Bound", members: [], source: { kind: "manual" } })
    const session = await createCogset({ name: "Session", members: [], source: { kind: "manual" } })
    await updateCogsetState({ globalCogsetId: global.id, appliedCogsetId: global.id })

    const { result } = renderHook(() => useCogsets())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.effective).toMatchObject({ cogset: { id: global.id }, source: "global" })
    expect(result.current.applied?.id).toBe(global.id)

    act(() => {
      useProjectStore.setState({
        activeProjectId: "p1",
        projects: [{ id: "p1", name: "P1", pluginCogsetId: bound.id } as never],
      })
    })
    await waitFor(() =>
      expect(result.current.effective).toMatchObject({
        cogset: { id: bound.id },
        source: "workspace",
      })
    )
    expect(result.current.workspaceCogset?.id).toBe(bound.id)

    act(() => useCogsetSessionStore.getState().setOverride(session.id))
    await waitFor(() =>
      expect(result.current.effective).toMatchObject({
        cogset: { id: session.id },
        source: "session",
      })
    )
  })

  it("reports a mirrored client", async () => {
    mirrored = true
    const { result } = renderHook(() => useCogsets())
    expect(result.current.mirrored).toBe(true)
  })
})

describe("helpers", () => {
  it("localizes the bootstrapped Default name only while it is unrenamed", () => {
    const { result } = renderHook(() => useCogsetDisplayName())
    expect(result.current({ name: "Default", source: { kind: "default" } })).toBe("t:defaultName")
    expect(result.current({ name: "Mine", source: { kind: "default" } })).toBe("Mine")
    expect(result.current({ name: "Default", source: { kind: "manual" } })).toBe("Default")
  })

  it("lists installed plugins sorted by name", async () => {
    for (const [id, name] of [
      ["b", "Beta"],
      ["a", "Alpha"],
    ]) {
      await upsertPlugin({
        id,
        name,
        version: "1.0.0",
        type: "frontend",
        source: "local",
        path: `/p/${id}`,
        manifest: { id, name },
      })
    }
    const { result } = renderHook(() => useInstalledPluginSummaries())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.plugins.map((p) => p.name)).toEqual(["Alpha", "Beta"])
    expect(result.current.byId.get("b")?.name).toBe("Beta")
  })
})
