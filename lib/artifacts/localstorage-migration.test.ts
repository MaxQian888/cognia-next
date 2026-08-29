/**
 * @jest-environment jsdom
 */

const persistOptions = { name: "cognia-artifacts" }

jest.mock("@/stores/artifact/artifact-store", () => ({
  __esModule: true,
  ARTIFACT_STORAGE_KEY: "cognia-artifacts",
  useArtifactStore: { persist: { getOptions: () => persistOptions } },
}))

jest.mock("@cognia/logging", () => ({
  __esModule: true,
  loggers: { canvas: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } },
}))

import {
  ARTIFACT_MIGRATION_PENDING_KEY,
  capturePendingArtifactMigration,
  clearPendingArtifactMigration,
  readPendingArtifactMigration,
} from "./localstorage-migration"

function writeBlob(key: string, state: Record<string, unknown>) {
  window.localStorage.setItem(key, JSON.stringify({ state, version: 5 }))
}

beforeEach(() => {
  window.localStorage.clear()
  persistOptions.name = "cognia-artifacts"
})

describe("capturePendingArtifactMigration", () => {
  it("parks the artifacts the legacy blob still carries", () => {
    writeBlob("cognia-artifacts", {
      artifacts: { art_1: { id: "art_1", title: "Chart" } },
      artifactVersions: { art_1: [{ id: "ver_1", artifactId: "art_1" }] },
      artifactWorkspace: { scope: "session" },
    })

    const pending = capturePendingArtifactMigration()

    expect(pending?.artifacts.art_1).toMatchObject({ id: "art_1" })
    expect(pending?.artifactVersions.art_1).toHaveLength(1)
    expect(JSON.parse(window.localStorage.getItem(ARTIFACT_MIGRATION_PENDING_KEY)!)).toEqual(
      pending
    )
  })

  it("reads the account bucket once the store has switched to one", () => {
    // An account bucket belongs to a different Dexie database, so the capture
    // has to follow the store's active persist name rather than the default —
    // reading the wrong one would carry another account's artifacts across.
    persistOptions.name = "cognia-artifacts:acct_a"
    writeBlob("cognia-artifacts", { artifacts: { other_account: { id: "other_account" } } })
    writeBlob("cognia-artifacts:acct_a", { artifacts: { art_a: { id: "art_a" } } })

    const pending = capturePendingArtifactMigration()

    expect(Object.keys(pending!.artifacts)).toEqual(["art_a"])
  })

  it("returns null when there is nothing left to migrate", () => {
    writeBlob("cognia-artifacts", { artifactWorkspace: { scope: "session" } })
    expect(capturePendingArtifactMigration()).toBeNull()
    expect(window.localStorage.getItem(ARTIFACT_MIGRATION_PENDING_KEY)).toBeNull()
  })

  it("keeps an interrupted run's rows when the blob has since been cleaned", () => {
    // This is the crash the parking exists for: the blob was rewritten without
    // its artifacts before the Dexie write landed, so the parked copy is now
    // the only one. A later boot must replay it, not report "nothing to do".
    writeBlob("cognia-artifacts", { artifacts: { art_1: { id: "art_1" } } })
    capturePendingArtifactMigration()
    writeBlob("cognia-artifacts", { artifactWorkspace: { scope: "session" } })

    const pending = capturePendingArtifactMigration()

    expect(Object.keys(pending!.artifacts)).toEqual(["art_1"])
  })

  it("prefers the already-parked copy over a blob that has since been truncated", () => {
    writeBlob("cognia-artifacts", { artifacts: { art_1: { id: "art_1", content: "full" } } })
    capturePendingArtifactMigration()
    writeBlob("cognia-artifacts", { artifacts: { art_1: { id: "art_1", content: "trunc" } } })

    const pending = capturePendingArtifactMigration()

    expect(pending!.artifacts.art_1).toMatchObject({ content: "full" })
  })

  it("survives a blob that is not JSON at all", () => {
    window.localStorage.setItem("cognia-artifacts", "{")
    expect(capturePendingArtifactMigration()).toBeNull()
  })

  it("survives a quota-exceeded park without stopping the caller", () => {
    writeBlob("cognia-artifacts", { artifacts: { art_1: { id: "art_1" } } })
    const setItem = jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError")
    })
    try {
      // Still returns what it WOULD have parked: the bridge writes it to Dexie
      // from memory, it just loses the crash safety net.
      expect(Object.keys(capturePendingArtifactMigration()!.artifacts)).toEqual(["art_1"])
    } finally {
      setItem.mockRestore()
    }
  })
})

describe("readPendingArtifactMigration / clearPendingArtifactMigration", () => {
  it("treats an empty parked payload as nothing pending", () => {
    window.localStorage.setItem(
      ARTIFACT_MIGRATION_PENDING_KEY,
      JSON.stringify({ artifacts: {}, artifactVersions: {} })
    )
    expect(readPendingArtifactMigration()).toBeNull()
  })

  it("clears the parked copy once it has been written", () => {
    writeBlob("cognia-artifacts", { artifacts: { art_1: { id: "art_1" } } })
    capturePendingArtifactMigration()
    clearPendingArtifactMigration()
    expect(readPendingArtifactMigration()).toBeNull()
  })
})
