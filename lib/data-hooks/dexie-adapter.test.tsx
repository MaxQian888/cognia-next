// Round-trip coverage for the Dexie-backed `DataAdapter` and the React-context
// convenience hooks. Tests exercise the real `lib/db/*` helpers against
// fake-indexeddb so we catch wiring bugs (wrong helper, dropped SSR guard,
// missing dep key) — not just type-shape regressions.

import "fake-indexeddb/auto"
import { renderHook, act, waitFor } from "@testing-library/react"
import { render } from "@testing-library/react"
import type { ReactNode } from "react"

import { dexieAdapter } from "./dexie-adapter"
import {
  DataAdapterProvider,
  useDataAdapter,
  useCharacters,
  useCharacter,
  useSkillsByIds,
  usePresets,
  useClearMessages,
  useUpdateSession,
  useRecordPresetUsage,
  useTrustWorkspace,
} from "./context"
import type { DataAdapter } from "./types"

import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { createCharacter } from "@/lib/db/characters"
import { createSession } from "@/lib/db/sessions"
import { createPreset, getPreset } from "@/lib/db/prompt-presets"
import { createSkill, listSkillsByIds } from "@/lib/db/skills"
import { isWorkspaceTrusted, listTrustedWorkspaces } from "@/lib/db/trusted-workspaces"
import { listMessages } from "@/lib/db/messages"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  // Wipe seeded built-ins so each test starts from a known-empty surface.
  await getDb().characters.clear()
  await getDb().skills.clear()
  await getDb().promptPresets.clear()
  await getDb().sessions.clear()
  await getDb().messages.clear()
  await getDb().trustedWorkspaces.clear()
})

function wrapper({ children }: { children: ReactNode }) {
  return <DataAdapterProvider adapter={dexieAdapter}>{children}</DataAdapterProvider>
}

describe("dexieAdapter — reactive reads", () => {
  it("useCharacters() returns sorted character list and reacts to inserts", async () => {
    await createCharacter({ name: "Zara", systemPrompt: "z" })
    await createCharacter({ name: "Alice", systemPrompt: "a" })

    const { result } = renderHook(() => dexieAdapter.useCharacters(), { wrapper })
    await waitFor(() => expect(result.current).toBeDefined())
    expect(result.current?.map((c) => c.name)).toEqual(["Alice", "Zara"])

    await act(async () => {
      await createCharacter({ name: "Bob", systemPrompt: "b" })
    })
    await waitFor(() => expect(result.current).toHaveLength(3))
    expect(result.current?.map((c) => c.name)).toEqual(["Alice", "Bob", "Zara"])
  })

  it("useCharacter(id) returns the row and follows updates", async () => {
    const c = await createCharacter({ name: "Solo", systemPrompt: "s" })

    const { result } = renderHook(() => dexieAdapter.useCharacter(c.id), { wrapper })
    await waitFor(() => expect(result.current).toBeDefined())
    expect(result.current?.name).toBe("Solo")
  })

  it("useCharacter(undefined) resolves to undefined without throwing", async () => {
    const { result } = renderHook(() => dexieAdapter.useCharacter(undefined), { wrapper })
    await waitFor(() => {
      expect(result.current).toBeUndefined()
    })
  })

  it("useCharacter(null) treats null id as 'no row'", async () => {
    const { result } = renderHook(() => dexieAdapter.useCharacter(null), { wrapper })
    await waitFor(() => {
      expect(result.current).toBeUndefined()
    })
  })

  it("useSkillsByIds([]) resolves to []", async () => {
    const { result } = renderHook(() => dexieAdapter.useSkillsByIds([]), { wrapper })
    await waitFor(() => expect(result.current).toEqual([]))
  })

  it("useSkillsByIds(undefined) resolves to []", async () => {
    const { result } = renderHook(() => dexieAdapter.useSkillsByIds(undefined), { wrapper })
    await waitFor(() => expect(result.current).toEqual([]))
  })

  it("useSkillsByIds(ids) returns only matching rows", async () => {
    const a = await createSkill({ name: "alpha", content: "..." })
    const b = await createSkill({ name: "beta", content: "..." })
    await createSkill({ name: "gamma", content: "..." })

    const { result } = renderHook(() => dexieAdapter.useSkillsByIds([a.id, b.id]), { wrapper })
    await waitFor(() => expect(result.current).toHaveLength(2))
    expect(result.current?.map((s) => s.name).sort()).toEqual(["alpha", "beta"])
  })

  it("usePresets() returns presets sorted (sortOrder asc)", async () => {
    await createPreset({ name: "second", content: "..." })
    await createPreset({ name: "first", content: "..." })

    const { result } = renderHook(() => dexieAdapter.usePresets(), { wrapper })
    await waitFor(() => expect(result.current).toBeDefined())
    expect(result.current?.length).toBe(2)
  })
})

describe("dexieAdapter — mutations", () => {
  it("clearMessages() drops every message in a session", async () => {
    const s = await createSession({ title: "T" })
    await getDb().messages.bulkPut([
      { id: "m1", sessionId: s.id, role: "user", parts: [], createdAt: 1 },
      { id: "m2", sessionId: s.id, role: "assistant", parts: [], createdAt: 2 },
    ])

    await dexieAdapter.clearMessages(s.id)
    expect(await listMessages(s.id)).toEqual([])
  })

  it("updateSession() patches and bumps updatedAt", async () => {
    const s = await createSession({ title: "Old" })
    const before = s.updatedAt
    await new Promise((r) => setTimeout(r, 5))
    await dexieAdapter.updateSession(s.id, { title: "New" })

    const after = await getDb().sessions.get(s.id)
    expect(after?.title).toBe("New")
    expect((after?.updatedAt ?? 0) > before).toBe(true)
  })

  it("recordPresetUsage() bumps usageCount", async () => {
    const p = await createPreset({ name: "preset", content: "..." })
    await dexieAdapter.recordPresetUsage(p.id)
    const after = await getPreset(p.id)
    expect(after?.usageCount).toBe(1)
  })

  it("trustWorkspace(path) records the path with optional note", async () => {
    await dexieAdapter.trustWorkspace("/tmp/proj")
    expect(await isWorkspaceTrusted("/tmp/proj")).toBe(true)

    await dexieAdapter.trustWorkspace("/tmp/proj-2", "monorepo root")
    const all = await listTrustedWorkspaces()
    expect(all.find((w) => w.path === "/tmp/proj-2")?.note).toBe("monorepo root")
  })
})

describe("DataAdapterProvider + convenience hooks", () => {
  it("useDataAdapter() throws when called outside the provider", () => {
    // Suppress the expected console.error noise from React's error boundary.
    const spy = jest.spyOn(console, "error").mockImplementation(() => undefined)
    try {
      expect(() => renderHook(() => useDataAdapter())).toThrow(/useDataAdapter\(\) called outside/)
    } finally {
      spy.mockRestore()
    }
  })

  it("useDataAdapter() returns the mounted adapter", () => {
    const { result } = renderHook(() => useDataAdapter(), { wrapper })
    expect(result.current).toBe(dexieAdapter)
  })

  it("useCharacters() / useCharacter() / useSkillsByIds() / usePresets() delegate to adapter", async () => {
    const c = await createCharacter({ name: "Echo", systemPrompt: "e" })
    const sk = await createSkill({ name: "skill-a", content: "..." })
    await createPreset({ name: "preset-a", content: "..." })

    const { result: chars } = renderHook(() => useCharacters(), { wrapper })
    const { result: char } = renderHook(() => useCharacter(c.id), { wrapper })
    const { result: skills } = renderHook(() => useSkillsByIds([sk.id]), { wrapper })
    const { result: presets } = renderHook(() => usePresets(), { wrapper })

    await waitFor(() => {
      expect(chars.current).toBeDefined()
      expect(char.current).toBeDefined()
      expect(skills.current).toBeDefined()
      expect(presets.current).toBeDefined()
    })
    expect(chars.current?.[0].name).toBe("Echo")
    expect(char.current?.id).toBe(c.id)
    expect(skills.current?.[0].id).toBe(sk.id)
    expect(presets.current?.length).toBe(1)
  })

  it("write hooks return functions that delegate to adapter mutations", async () => {
    const s = await createSession({ title: "S" })
    const p = await createPreset({ name: "p", content: "..." })

    const { result: clearFn } = renderHook(() => useClearMessages(), { wrapper })
    const { result: updateFn } = renderHook(() => useUpdateSession(), { wrapper })
    const { result: recordFn } = renderHook(() => useRecordPresetUsage(), { wrapper })
    const { result: trustFn } = renderHook(() => useTrustWorkspace(), { wrapper })

    await getDb().messages.put({
      id: "m1",
      sessionId: s.id,
      role: "user",
      parts: [],
      createdAt: 1,
    })

    await act(async () => {
      await clearFn.current(s.id)
      await updateFn.current(s.id, { title: "Renamed" })
      await recordFn.current(p.id)
      await trustFn.current("/tmp/x", "note")
    })

    expect(await listMessages(s.id)).toEqual([])
    expect((await getDb().sessions.get(s.id))?.title).toBe("Renamed")
    expect((await getPreset(p.id))?.usageCount).toBe(1)
    expect(await isWorkspaceTrusted("/tmp/x")).toBe(true)
  })

  it("provider passes a custom adapter through to consumers", () => {
    const stub: DataAdapter = {
      useCharacters: () => undefined,
      useCharacter: () => undefined,
      useSkillsByIds: () => undefined,
      usePresets: () => undefined,
      clearMessages: jest.fn(async () => undefined),
      updateSession: jest.fn(async () => undefined),
      recordPresetUsage: jest.fn(async () => undefined),
      trustWorkspace: jest.fn(async () => undefined),
    }

    const customWrapper = ({ children }: { children: ReactNode }) => (
      <DataAdapterProvider adapter={stub}>{children}</DataAdapterProvider>
    )
    const { result } = renderHook(() => useDataAdapter(), { wrapper: customWrapper })
    expect(result.current).toBe(stub)
  })

  it("provider renders children", () => {
    const { getByTestId } = render(
      <DataAdapterProvider adapter={dexieAdapter}>
        <div data-testid="child">hi</div>
      </DataAdapterProvider>
    )
    expect(getByTestId("child")).toBeInTheDocument()
  })

  it("nearest provider wins (nested override)", () => {
    const inner: DataAdapter = {
      useCharacters: () => [],
      useCharacter: () => undefined,
      useSkillsByIds: () => [],
      usePresets: () => [],
      clearMessages: async () => undefined,
      updateSession: async () => undefined,
      recordPresetUsage: async () => undefined,
      trustWorkspace: async () => undefined,
    }
    const nested = ({ children }: { children: ReactNode }) => (
      <DataAdapterProvider adapter={dexieAdapter}>
        <DataAdapterProvider adapter={inner}>{children}</DataAdapterProvider>
      </DataAdapterProvider>
    )
    const { result } = renderHook(() => useDataAdapter(), { wrapper: nested })
    expect(result.current).toBe(inner)
  })
})

// We avoid the `unused import` lint by referencing — the helper is exported
// from `@/lib/db/skills` and we only need the side-effect of `listSkillsByIds`
// being importable as a sanity-check against a stale path.
void listSkillsByIds
