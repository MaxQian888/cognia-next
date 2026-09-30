const hostProfile = jest.fn(() => "desktop")
jest.mock("@/lib/platform/capabilities", () => ({ detectHostProfile: () => hostProfile() }))
jest.mock("@/lib/db/media-generation-jobs", () => ({ existingVideoJobIds: jest.fn() }))

const VIDEOS = "generated-videos/acct_alpha/db-live"
const STAGING = "composer-video-staging/acct_alpha/db-live"
const sweepDropped = jest.fn(async (_exists: (name: string) => Promise<boolean>) => 2)
jest.mock("@/lib/tauri/account-app-data", () => ({
  GENERATED_VIDEO_APP_DATA_DIR: "generated-videos",
  COMPOSER_VIDEO_STAGING_APP_DATA_DIR: "composer-video-staging",
  activeDatabaseAppDataDir: (dir: string) => `${dir}/acct_alpha/db-live`,
  sweepDroppedDatabaseAppData: (exists: (name: string) => Promise<boolean>) => sweepDropped(exists),
}))

// Files per directory, with their modification times.
const files = new Map<string, Map<string, number | null>>()
const heldOpen = new Set<string>()
const removeAppDataFile = jest.fn(async (path: string) => {
  if (heldOpen.has(path)) throw new Error("in use")
  const dir = path.split("/").slice(0, -1).join("/")
  files.get(dir)?.delete(path.split("/").at(-1)!)
})
jest.mock("@/lib/tauri/app-data-files", () => ({
  removeAppDataFile: (path: string) => removeAppDataFile(path),
  listAppDataDirectory: async (dir: string) => [
    ...[...(files.get(dir)?.keys() ?? [])].map((name) => ({
      name,
      isDirectory: false,
      isFile: true,
    })),
    { name: "nested", isDirectory: true, isFile: false },
  ],
  appDataModifiedAt: async (path: string) => {
    const dir = path.split("/").slice(0, -1).join("/")
    const at = files.get(dir)?.get(path.split("/").at(-1)!)
    if (at === undefined) throw new Error("gone")
    return at
  },
}))

import { STALE_STAGING_MS, sweepVideoAppData, type VideoAppDataSweepDeps } from "./app-data-sweep"

const NOW = 10 * STALE_STAGING_MS

function deps(liveJobs: string[]): VideoAppDataSweepDeps {
  return {
    now: () => NOW,
    databaseExists: jest.fn(async () => true),
    existingJobIds: jest.fn(
      async (ids: readonly string[]) => new Set(ids.filter((id) => liveJobs.includes(id)))
    ),
  }
}

beforeEach(() => {
  files.clear()
  heldOpen.clear()
  removeAppDataFile.mockClear()
  sweepDropped.mockClear()
  hostProfile.mockReturnValue("desktop")
})

describe("sweepVideoAppData", () => {
  it("removes generated videos no job row accounts for, and keeps a download in flight", async () => {
    files.set(
      VIDEOS,
      new Map([
        ["vjob_kept.mp4", NOW],
        ["vjob_orphan.mp4", NOW],
        ["vjob_downloading.mp4.1f2e.part", NOW],
      ])
    )
    const d = deps(["vjob_kept", "vjob_downloading"])
    const result = await sweepVideoAppData(d)
    expect(d.existingJobIds).toHaveBeenCalledWith(["vjob_kept", "vjob_orphan", "vjob_downloading"])
    expect([...files.get(VIDEOS)!.keys()]).toEqual([
      "vjob_kept.mp4",
      "vjob_downloading.mp4.1f2e.part",
    ])
    expect(result).toEqual({ databaseDirectories: 2, orphanVideos: 1, staleStagingCopies: 0 })
  })

  it("removes staging copies a crash left behind, and none still being prepared", async () => {
    files.set(
      STAGING,
      new Map<string, number | null>([
        ["old.mov", NOW - STALE_STAGING_MS - 1],
        ["fresh.mov", NOW - 1000],
        ["unknown.mov", null],
      ])
    )
    const result = await sweepVideoAppData(deps([]))
    expect([...files.get(STAGING)!.keys()]).toEqual(["fresh.mov", "unknown.mov"])
    expect(result.staleStagingCopies).toBe(1)
  })

  it("hands the dropped-database sweep a check for whether a database exists", async () => {
    const d = deps([])
    await sweepVideoAppData(d)
    await sweepDropped.mock.calls[0][0]("db-x")
    expect(d.databaseExists).toHaveBeenCalledWith("db-x")
  })

  it("counts only what it removed; a file held open waits for the next sweep", async () => {
    files.set(VIDEOS, new Map([["vjob_orphan.mp4", NOW]]))
    heldOpen.add(`${VIDEOS}/vjob_orphan.mp4`)
    await expect(sweepVideoAppData(deps([]))).resolves.toMatchObject({ orphanVideos: 0 })
    expect(files.get(VIDEOS)!.has("vjob_orphan.mp4")).toBe(true)
  })

  it("does nothing off the desktop", async () => {
    hostProfile.mockReturnValue("mobile-companion")
    files.set(VIDEOS, new Map([["vjob_orphan.mp4", NOW]]))
    await expect(sweepVideoAppData(deps([]))).resolves.toEqual({
      databaseDirectories: 0,
      orphanVideos: 0,
      staleStagingCopies: 0,
    })
    expect(sweepDropped).not.toHaveBeenCalled()
    expect(removeAppDataFile).not.toHaveBeenCalled()
  })
})
