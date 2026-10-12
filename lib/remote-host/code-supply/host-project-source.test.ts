import type { ProjectSource } from "@/lib/task-workspace/types"

import {
  HOST_PROJECT_SOURCE_TTL_MS,
  HostProjectSourceError,
  hostWorkingDirectory,
  knownHostRoots,
  resetHostProjectSources,
  resolveHostProjectSource,
  type HostProject,
  type HostProjectSourceDeps,
} from "./host-project-source"

const CLONE = "/data/task-workspaces/sources/github.com/acme/app"

function deps(
  answer: ProjectSource | Error,
  overrides: Partial<Omit<HostProjectSourceDeps, "ensure">> = {}
): Omit<HostProjectSourceDeps, "ensure"> & { ensure: jest.Mock; clock: { now: number } } {
  const clock = { now: 1_000 }
  const ensure = jest.fn(async () => {
    if (answer instanceof Error) throw answer
    return answer
  })
  return { isHost: () => true, ensure, now: () => clock.now, clock, ...overrides }
}

const clone: ProjectSource = {
  root: CLONE,
  source: "clone",
  standsFor: "/Users/me/app",
  remoteUrl: "https://github.com/acme/app.git",
}

function project(id = "p1", extra: Partial<HostProject> = {}): HostProject {
  return {
    id,
    roots: [
      { id: "r1", path: "/Users/me/app", isPrimary: true },
      { id: "r2", path: "/Users/me/docs", isPrimary: false },
    ],
    repository: { remoteUrl: "https://github.com/acme/app.git", capturedAt: 1 },
    ...extra,
  }
}

beforeEach(() => resetHostProjectSources())

describe("hostWorkingDirectory", () => {
  it("moves a path in the workspace's folder into its clone", async () => {
    const d = deps(clone)
    await expect(
      hostWorkingDirectory({ cwd: "/Users/me/app/web/src/", project: project() }, d)
    ).resolves.toBe(`${CLONE}/web/src`)
    await expect(
      hostWorkingDirectory({ cwd: "/Users/me/app", project: project() }, d)
    ).resolves.toBe(CLONE)
    // No directory given: the clone.
    await expect(hostWorkingDirectory({ project: project() }, d)).resolves.toBe(CLONE)
    // A second folder is not cloned; its work runs at the repository's root.
    await expect(
      hostWorkingDirectory({ cwd: "/Users/me/docs/notes", project: project() }, d)
    ).resolves.toBe(CLONE)
    expect(d.ensure).toHaveBeenCalledTimes(1)
    expect(d.ensure).toHaveBeenCalledWith({
      roots: ["/Users/me/app", "/Users/me/docs"],
      remoteUrl: "https://github.com/acme/app.git",
    })
  })

  it("leaves a directory outside the workspace, or a folder the host has, alone", async () => {
    const d = deps(clone)
    await expect(
      hostWorkingDirectory({ cwd: "/srv/scratch", project: project() }, d)
    ).resolves.toBe("/srv/scratch")
    expect(d.ensure).not.toHaveBeenCalled()

    const local = deps({ root: "/Users/me/app", source: "local", standsFor: null, remoteUrl: null })
    await expect(
      hostWorkingDirectory({ cwd: "/Users/me/app/web", project: project() }, local)
    ).resolves.toBe("/Users/me/app/web")
    await expect(hostWorkingDirectory({ project: project() }, local)).resolves.toBe("/Users/me/app")
  })

  it("changes nothing off a host or without a workspace", async () => {
    const d = deps(clone, { isHost: () => false })
    await expect(
      hostWorkingDirectory({ cwd: "/Users/me/app", project: project() }, d)
    ).resolves.toBe("/Users/me/app")
    await expect(hostWorkingDirectory({ cwd: "/Users/me/app" }, deps(clone))).resolves.toBe(
      "/Users/me/app"
    )
    const empty = deps(clone)
    await expect(
      hostWorkingDirectory({ project: project("p2", { roots: [], repository: undefined }) }, empty)
    ).resolves.toBeUndefined()
    expect(empty.ensure).not.toHaveBeenCalled()
  })

  it("fails a workspace it cannot supply instead of running elsewhere", async () => {
    const d = deps(new Error("project_source_unavailable: none of this project's folders exists"))
    await expect(
      hostWorkingDirectory({ cwd: "/Users/me/app", project: project() }, d)
    ).rejects.toBeInstanceOf(HostProjectSourceError)
  })
})

describe("resolveHostProjectSource", () => {
  it("reuses an answer for a while, and asks again once it is stale or the workspace changed", async () => {
    const d = deps(clone)
    await Promise.all([
      resolveHostProjectSource(project(), d),
      resolveHostProjectSource(project(), d),
    ])
    expect(d.ensure).toHaveBeenCalledTimes(1)
    expect(knownHostRoots("p1")).toEqual([CLONE])

    d.clock.now += HOST_PROJECT_SOURCE_TTL_MS + 1
    await resolveHostProjectSource(project(), d)
    expect(d.ensure).toHaveBeenCalledTimes(2)

    await resolveHostProjectSource(
      project("p1", {
        repository: { remoteUrl: "https://github.com/acme/other.git", capturedAt: 2 },
      }),
      d
    )
    expect(d.ensure).toHaveBeenCalledTimes(3)
    expect(knownHostRoots("unknown")).toEqual([])
  })
})
