import { renderHook } from "@testing-library/react"
import { useEffectiveCwd, resolveEffectiveCwdForSession } from "./use-effective-cwd"
import { useProjectStore } from "@/stores/project/project-store"
import { useSettingsStore } from "@/stores/settings"
import { useCharacter } from "@/lib/data-hooks/context"
import { resolveCharacterById } from "@/lib/db/characters"
import type { Project } from "@/types"
import type { AppSettings } from "@/lib/claude/types"

jest.mock("@/lib/data-hooks/context", () => ({ useCharacter: jest.fn() }))
jest.mock("@/lib/db/characters", () => ({ resolveCharacterById: jest.fn() }))

const useCharacterMock = useCharacter as jest.Mock
const resolveCharacterByIdMock = resolveCharacterById as jest.Mock

function makeProject(path: string): Project {
  return {
    id: "proj-1",
    name: "Workspace",
    roots: [{ id: "r1", path, isPrimary: true }],
    knowledgeBase: [],
    sessionIds: [],
    sessionCount: 0,
    messageCount: 0,
    isArchived: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastAccessedAt: new Date(),
  } as Project
}

function seedStores(opts: {
  project?: Project | null
  active?: boolean
  defaultWorkingDir?: string
}) {
  const projects = opts.project ? [opts.project] : []
  useProjectStore.setState({
    projects,
    activeProjectId: opts.active && opts.project ? opts.project.id : null,
    loaded: false,
  })
  useSettingsStore.setState({
    settings: { defaultWorkingDir: opts.defaultWorkingDir } as AppSettings,
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  useCharacterMock.mockReturnValue(undefined)
  seedStores({})
})

describe("useEffectiveCwd", () => {
  it("returns the session workingDir when set", () => {
    seedStores({ project: makeProject("/ws"), active: true, defaultWorkingDir: "/def" })
    const { result } = renderHook(() => useEffectiveCwd({ workingDir: "/session" }))
    expect(result.current).toBe("/session")
  })

  it("falls back to the active workspace primary root", () => {
    seedStores({ project: makeProject("/ws"), active: true, defaultWorkingDir: "/def" })
    const { result } = renderHook(() => useEffectiveCwd({}))
    expect(result.current).toBe("/ws")
  })

  it("ignores a workspace that exists but is not active", () => {
    seedStores({ project: makeProject("/ws"), active: false, defaultWorkingDir: "/def" })
    const { result } = renderHook(() => useEffectiveCwd({}))
    expect(result.current).toBe("/def")
  })

  it("uses the character default between workspace and app default", () => {
    seedStores({ defaultWorkingDir: "/def" })
    useCharacterMock.mockReturnValue({ id: "char-1", workingDir: "/char" })
    const { result } = renderHook(() => useEffectiveCwd({ characterId: "char-1" }))
    expect(useCharacterMock).toHaveBeenCalledWith("char-1")
    expect(result.current).toBe("/char")
  })

  it("returns null when nothing in the chain resolves", () => {
    const { result } = renderHook(() => useEffectiveCwd(null))
    expect(result.current).toBeNull()
  })
})

describe("resolveEffectiveCwdForSession", () => {
  it("prefers session workingDir", async () => {
    seedStores({ project: makeProject("/ws"), active: true })
    await expect(resolveEffectiveCwdForSession({ workingDir: "/session" })).resolves.toBe(
      "/session"
    )
    expect(resolveCharacterByIdMock).not.toHaveBeenCalled()
  })

  it("falls back to the active workspace root", async () => {
    seedStores({ project: makeProject("/ws"), active: true })
    await expect(resolveEffectiveCwdForSession({})).resolves.toBe("/ws")
  })

  it("resolves the character from Dexie when needed", async () => {
    seedStores({})
    resolveCharacterByIdMock.mockResolvedValue({ id: "char-1", workingDir: "/char" })
    await expect(resolveEffectiveCwdForSession({ characterId: "char-1" })).resolves.toBe("/char")
    expect(resolveCharacterByIdMock).toHaveBeenCalledWith("char-1")
  })

  it("survives a character lookup failure and uses the app default", async () => {
    seedStores({ defaultWorkingDir: "/def" })
    resolveCharacterByIdMock.mockRejectedValue(new Error("dexie down"))
    await expect(resolveEffectiveCwdForSession({ characterId: "char-1" })).resolves.toBe("/def")
  })

  it("returns null when nothing resolves", async () => {
    await expect(resolveEffectiveCwdForSession(null)).resolves.toBeNull()
  })
})
