const hostProfile = jest.fn(() => "desktop")
jest.mock("@/lib/platform/capabilities", () => ({ detectHostProfile: () => hostProfile() }))
jest.mock("@/lib/accounts/active-account-id", () => ({ getActiveAccountId: () => "acct_alpha" }))
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({ name: "cognia-account-acct_alpha-encrypted-v1" }),
}))

// An AppData tree: directory paths, each with the names inside it.
const tree = new Map<string, Set<string>>()
const heldOpen = new Set<string>()
function mkdirs(...paths: string[]) {
  for (const path of paths) {
    const parts = path.split("/")
    for (let i = 1; i <= parts.length; i += 1) {
      const dir = parts.slice(0, i).join("/")
      if (!tree.has(dir)) tree.set(dir, new Set())
      if (i > 1) tree.get(parts.slice(0, i - 1).join("/"))!.add(parts[i - 1])
    }
  }
}
const removeAppDataDirectory = jest.fn(async (path: string) => {
  if (heldOpen.has(path)) throw new Error(`in use: ${path}`)
  for (const dir of [...tree.keys()]) {
    if (dir === path || dir.startsWith(`${path}/`)) tree.delete(dir)
  }
  const parent = path.split("/").slice(0, -1).join("/")
  tree.get(parent)?.delete(path.split("/").at(-1)!)
})
jest.mock("@/lib/tauri/app-data-files", () => ({
  removeAppDataDirectory: (path: string) => removeAppDataDirectory(path),
  listAppDataDirectory: async (path: string) =>
    [...(tree.get(path) ?? [])].map((name) => {
      const isDirectory = tree.has(`${path}/${name}`)
      return { name, isDirectory, isFile: !isDirectory }
    }),
}))

import {
  ACCOUNT_APP_DATA_DIRS,
  activeDatabaseAppDataDir,
  databaseAppDataDir,
  purgeAccountAppData,
  purgeDatabaseAppData,
  sweepDroppedDatabaseAppData,
} from "./account-app-data"

beforeEach(() => {
  tree.clear()
  heldOpen.clear()
  removeAppDataDirectory.mockClear()
  hostProfile.mockReturnValue("desktop")
})

describe("layout", () => {
  it("nests each database under its account", () => {
    expect(databaseAppDataDir("generated-videos", "acct_alpha", "cognia-account-acct_alpha")).toBe(
      "generated-videos/acct_alpha/cognia-account-acct_alpha"
    )
    expect(activeDatabaseAppDataDir("composer-video-staging")).toBe(
      "composer-video-staging/acct_alpha/cognia-account-acct_alpha-encrypted-v1"
    )
  })

  it("refuses a segment that could leave its directory", () => {
    expect(() => databaseAppDataDir("generated-videos", "../etc", "db")).toThrow()
    expect(() => databaseAppDataDir("generated-videos", "acct_alpha", "..")).toThrow(
      "Not a database name"
    )
    expect(() => databaseAppDataDir("generated-videos", "acct_alpha", "a/b")).toThrow()
  })
})

describe("purges", () => {
  it("removes an account's directory in every account-scoped directory", async () => {
    await purgeAccountAppData("acct_alpha")
    expect(removeAppDataDirectory.mock.calls.map(([path]) => path)).toEqual(
      ACCOUNT_APP_DATA_DIRS.map((dir) => `${dir}/acct_alpha`)
    )
  })

  it("removes one database's directories and leaves the account's others", async () => {
    mkdirs("generated-videos/acct_alpha/db-one", "generated-videos/acct_alpha/db-two")
    await purgeDatabaseAppData("acct_alpha", "db-one")
    expect(tree.has("generated-videos/acct_alpha/db-one")).toBe(false)
    expect(tree.has("generated-videos/acct_alpha/db-two")).toBe(true)
  })

  it("tries every directory before reporting the ones that failed", async () => {
    heldOpen.add("generated-videos/acct_alpha")
    await expect(purgeAccountAppData("acct_alpha")).rejects.toThrow("in use")
    expect(removeAppDataDirectory).toHaveBeenCalledWith("composer-video-staging/acct_alpha")

    heldOpen.add("composer-video-staging/acct_alpha")
    await expect(purgeAccountAppData("acct_alpha")).rejects.toThrow(
      "2 AppData directories were not removed"
    )
  })

  it("does nothing off the desktop, where AppData is not written", async () => {
    hostProfile.mockReturnValue("web")
    await purgeAccountAppData("acct_alpha")
    await purgeDatabaseAppData("acct_alpha", "db-one")
    expect(removeAppDataDirectory).not.toHaveBeenCalled()
    await expect(sweepDroppedDatabaseAppData(async () => false)).resolves.toBe(0)
  })
})

describe("sweepDroppedDatabaseAppData", () => {
  it("removes the directories of databases that no longer exist", async () => {
    mkdirs(
      "generated-videos/acct_alpha/live-db",
      "generated-videos/acct_alpha/dropped-db",
      "generated-videos/acct_gone/gone-db",
      "composer-video-staging/acct_gone/gone-db"
    )
    const live = new Set(["live-db"])
    await expect(sweepDroppedDatabaseAppData(async (name) => live.has(name))).resolves.toBe(3)
    expect(tree.has("generated-videos/acct_alpha/live-db")).toBe(true)
    expect(tree.has("generated-videos/acct_alpha/dropped-db")).toBe(false)
    // An account left with nothing goes too.
    expect(tree.has("generated-videos/acct_gone")).toBe(false)
    expect(tree.has("composer-video-staging/acct_gone")).toBe(false)
  })

  it("leaves what this layout did not create", async () => {
    mkdirs("generated-videos/x", "generated-videos/acct_alpha")
    tree.get("generated-videos")!.add("vjob_legacy.mp4")
    tree.get("generated-videos/acct_alpha")!.add("stray.mp4")
    await expect(sweepDroppedDatabaseAppData(async () => false)).resolves.toBe(0)
    // "x" is too short to be an account id; files are not database directories.
    expect(tree.has("generated-videos/x")).toBe(true)
    expect(tree.get("generated-videos")!.has("vjob_legacy.mp4")).toBe(true)
    expect(tree.has("generated-videos/acct_alpha")).toBe(true)
  })

  it("keeps a directory it cannot remove for the next sweep", async () => {
    mkdirs("generated-videos/acct_alpha/dropped-db")
    heldOpen.add("generated-videos/acct_alpha/dropped-db")
    await expect(sweepDroppedDatabaseAppData(async () => false)).resolves.toBe(0)
    expect(tree.has("generated-videos/acct_alpha")).toBe(true)
    heldOpen.clear()
    await expect(sweepDroppedDatabaseAppData(async () => false)).resolves.toBe(1)
  })
})
