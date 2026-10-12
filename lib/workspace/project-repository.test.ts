import {
  captureProjectRepository,
  nextRepository,
  readProjectRepository,
  repositoryRemoteUrl,
  type ProjectRepositoryReader,
} from "./project-repository"

function reader(remote: string | null | Error): ProjectRepositoryReader & { asked: string[] } {
  const asked: string[] = []
  return {
    asked,
    remoteOf: async (root) => {
      asked.push(root)
      if (remote instanceof Error) throw remote
      return remote
    },
    now: () => 1_000,
  }
}

const project = (path?: string) => ({
  roots: path ? [{ id: "r1", path, isPrimary: true }] : [],
})

describe("repositoryRemoteUrl", () => {
  it("records a remote as credential-free https, or not at all", () => {
    expect(repositoryRemoteUrl("git@github.com:acme/app.git")).toBe(
      "https://github.com/acme/app.git"
    )
    expect(repositoryRemoteUrl("ssh://git@github.com/acme/app.git")).toBe(
      "https://github.com/acme/app.git"
    )
    expect(repositoryRemoteUrl("https://ghp_token@github.com/acme/app.git/")).toBe(
      "https://github.com/acme/app.git"
    )
    expect(repositoryRemoteUrl("http://intranet/acme/app.git")).toBeUndefined()
    expect(repositoryRemoteUrl("/srv/git/app.git")).toBeUndefined()
    expect(repositoryRemoteUrl(null)).toBeUndefined()
  })
})

describe("readProjectRepository", () => {
  it("reads the primary folder's remote", async () => {
    const read = reader("git@github.com:acme/app.git")
    await expect(readProjectRepository(project("/Users/me/app"), read)).resolves.toEqual({
      kind: "found",
      repository: { remoteUrl: "https://github.com/acme/app.git", capturedAt: 1_000 },
    })
    expect(read.asked).toEqual(["/Users/me/app"])
  })

  it("tells a folder without a usable remote from one it cannot read", async () => {
    await expect(readProjectRepository(project("/a"), reader(null))).resolves.toEqual({
      kind: "none",
    })
    await expect(readProjectRepository(project("/a"), reader("/srv/app.git"))).resolves.toEqual({
      kind: "none",
    })
    await expect(
      readProjectRepository(project("/a"), reader(new Error("not mounted")))
    ).resolves.toEqual({ kind: "unreadable" })
    await expect(readProjectRepository(project(), reader("x"))).resolves.toEqual({
      kind: "none",
    })
  })
})

describe("nextRepository", () => {
  const recorded = { remoteUrl: "https://github.com/acme/app.git", capturedAt: 5 }

  it("keeps the record when unreadable or unchanged, clears it when gone", () => {
    expect(nextRepository(recorded, { kind: "unreadable" })).toEqual({
      changed: false,
      repository: recorded,
    })
    expect(
      nextRepository(recorded, {
        kind: "found",
        repository: { remoteUrl: recorded.remoteUrl, capturedAt: 9 },
      })
    ).toEqual({ changed: false, repository: recorded })
    expect(nextRepository(recorded, { kind: "none" })).toEqual({
      changed: true,
      repository: undefined,
    })
    expect(nextRepository(undefined, { kind: "none" })).toEqual({
      changed: false,
      repository: undefined,
    })
  })
})

describe("captureProjectRepository", () => {
  it("writes only when the repository changed", async () => {
    const update = jest.fn()
    const base = { id: "p1", ...project("/Users/me/app") }
    await captureProjectRepository(base, {
      reader: reader("https://github.com/acme/app.git"),
      update,
    })
    expect(update).toHaveBeenCalledWith("p1", {
      remoteUrl: "https://github.com/acme/app.git",
      capturedAt: 1_000,
    })

    update.mockClear()
    await captureProjectRepository(
      { ...base, repository: { remoteUrl: "https://github.com/acme/app.git", capturedAt: 1 } },
      { reader: reader("git@github.com:acme/app.git"), update }
    )
    expect(update).not.toHaveBeenCalled()
  })
})
