/**
 * @jest-environment jsdom
 *
 * Persistence coverage for the project store: `load()` hydrates from Dexie,
 * and every mutation (gated on `loaded`) mirrors to the `projects` table /
 * settings singleton. Distinct from `project-store.test.ts`, which covers the
 * plugin-hook dispatches with persistence disabled (never calls `load()`).
 */

import "fake-indexeddb/auto"

jest.mock("@/lib/plugin/messaging/hooks-system", () => ({
  getPluginEventHooks: () => ({
    dispatchProjectCreate: jest.fn(async () => undefined),
    dispatchProjectUpdate: jest.fn(async () => undefined),
    dispatchProjectDelete: jest.fn(async () => undefined),
    dispatchProjectSwitch: jest.fn(),
    dispatchKnowledgeFileAdd: jest.fn(async () => undefined),
    dispatchKnowledgeFileRemove: jest.fn(),
    dispatchSessionLinked: jest.fn(),
    dispatchSessionUnlinked: jest.fn(),
  }),
}))

import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { getAllProjects, loadActiveProjectId } from "@/lib/db/projects"
import { useProjectStore } from "./project-store"

const flush = () => new Promise((r) => setTimeout(r, 0))
async function waitForCondition(assertion: () => Promise<void> | void): Promise<void> {
  let lastError: unknown
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await assertion()
      return
    } catch (error) {
      lastError = error
      await flush()
    }
  }
  throw lastError
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  useProjectStore.setState({ projects: [], activeProjectId: null, loaded: false })
})

describe("load()", () => {
  it("is idempotent and marks the store loaded", async () => {
    await useProjectStore.getState().load()
    expect(useProjectStore.getState().loaded).toBe(true)
    // second call short-circuits
    await useProjectStore.getState().load()
    expect(useProjectStore.getState().loaded).toBe(true)
  })

  it("hydrates persisted projects + active pointer", async () => {
    // Seed a first store lifecycle, then rehydrate a fresh one.
    await useProjectStore.getState().load()
    const p = useProjectStore.getState().createProject({ name: "Alpha", rootDir: "/tmp/a" })
    useProjectStore.getState().setActiveProject(p.id)
    await flush()

    // Simulate a restart: reset in-memory state, reload from Dexie.
    useProjectStore.setState({ projects: [], activeProjectId: null, loaded: false })
    await useProjectStore.getState().load()

    const state = useProjectStore.getState()
    expect(state.projects.map((x) => x.id)).toContain(p.id)
    expect(state.activeProjectId).toBe(p.id)
  })

  it("merges + flushes a project created before hydration resolves (no data loss)", async () => {
    // A prior session persisted "Existing".
    await useProjectStore.getState().load()
    const existing = useProjectStore.getState().createProject({ name: "Existing", rootDir: "/e" })
    await flush()

    // Restart: a NEW project is created while load() is still in flight
    // (loaded === false), so persist() is gated and it lives only in memory.
    useProjectStore.setState({ projects: [], activeProjectId: null, loaded: false })
    const racy = useProjectStore.getState().createProject({ name: "Racy", rootDir: "/r" })

    await useProjectStore.getState().load()
    await flush()

    const ids = useProjectStore.getState().projects.map((x) => x.id)
    // Both survive in memory — load() merged instead of overwriting.
    expect(ids).toEqual(expect.arrayContaining([existing.id, racy.id]))
    // The racy project was flushed, so it survives a future reload too.
    const rows = await getAllProjects()
    expect(rows.map((x) => x.id)).toEqual(expect.arrayContaining([existing.id, racy.id]))
  })

  it("keeps + persists an active pointer chosen before hydration", async () => {
    useProjectStore.getState().setActiveProject("pre-load-id")
    await useProjectStore.getState().load()
    await flush()
    expect(useProjectStore.getState().activeProjectId).toBe("pre-load-id")
    expect(await loadActiveProjectId()).toBe("pre-load-id")
  })
})

describe("mutations persist (only after load)", () => {
  it("does NOT persist before load() has run", async () => {
    useProjectStore.getState().createProject({ name: "Ghost" })
    await flush()
    expect(await getAllProjects()).toEqual([])
  })

  it("createProject persists rootDir + additionalDirs after load", async () => {
    await useProjectStore.getState().load()
    const p = useProjectStore
      .getState()
      .createProject({ name: "Beta", rootDir: "/tmp/b", additionalDirs: ["/x", "/y"] })
    await flush()
    const rows = await getAllProjects()
    const row = rows.find((project) => project.id === p.id)
    expect(row?.rootDir).toBe("/tmp/b")
    expect(row?.additionalDirs).toEqual(["/x", "/y"])
  })

  it("updateProject persists changes", async () => {
    await useProjectStore.getState().load()
    const p = useProjectStore.getState().createProject({ name: "Gamma" })
    useProjectStore.getState().updateProject(p.id, { rootDir: "/tmp/g", additionalDirs: ["/z"] })
    await flush()
    const row = (await getAllProjects()).find((x) => x.id === p.id)
    expect(row?.rootDir).toBe("/tmp/g")
    expect(row?.additionalDirs).toEqual(["/z"])
  })

  it("deleteProject removes the persisted row and clears the active pointer", async () => {
    await useProjectStore.getState().load()
    const p = useProjectStore.getState().createProject({ name: "Delta" })
    useProjectStore.getState().setActiveProject(p.id)
    await flush()
    useProjectStore.getState().deleteProject(p.id)
    await waitForCondition(async () => {
      expect((await getAllProjects()).find((x) => x.id === p.id)).toBeUndefined()
    })
    expect(await loadActiveProjectId()).toBeNull()
  })

  it("setActiveProject persists the pointer", async () => {
    await useProjectStore.getState().load()
    const p = useProjectStore.getState().createProject({ name: "Eps" })
    useProjectStore.getState().setActiveProject(p.id)
    await flush()
    expect(await loadActiveProjectId()).toBe(p.id)
  })
})
