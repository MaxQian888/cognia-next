import type { Project } from "@/types"
import type { ProjectEnvironment, ProjectEnvironmentVersion } from "@/types/project-environment"
import { projectRepositoryCandidate, resolveSquadBindingCandidates } from "./binding-candidates"

const project = {
  id: "project-1",
  name: "Project",
  roots: [{ id: "root-1", isPrimary: true, path: "/repo", label: "repo" }],
  rootDir: "/repo",
} as Project

const environment = {
  id: "env-1",
  projectId: "project-1",
  name: "Development",
  isEnabled: true,
} as ProjectEnvironment

const version = {
  id: "env-1:v2",
  environmentId: "env-1",
  projectId: "project-1",
  version: 2,
  policy: { requiredRuntimeCapabilities: ["filesystem"] },
} as ProjectEnvironmentVersion

const enforceable = () => ({ preflight: () => ({ ok: true, missing: [] }) }) as never

describe("projectRepositoryCandidate", () => {
  it("prefers rootDir, then the single primary root", () => {
    expect(projectRepositoryCandidate(project)).toBe("/repo")
    expect(
      projectRepositoryCandidate({
        ...project,
        rootDir: undefined,
        roots: [
          { id: "a", isPrimary: true, path: "/a", label: "a" },
          { id: "b", isPrimary: true, path: "/b", label: "b" },
        ],
      } as unknown as Project)
    ).toBeUndefined()
    expect(projectRepositoryCandidate(undefined)).toBeUndefined()
  })
})

describe("resolveSquadBindingCandidates", () => {
  it("yields both candidates when exactly one enforceable environment exists", async () => {
    await expect(
      resolveSquadBindingCandidates(project, {
        listEnvironments: async () => [environment],
        listVersions: async () => [version],
        createEnvironment: enforceable,
      })
    ).resolves.toEqual({
      repositoryPath: "/repo",
      environment: { environmentId: "env-1", versionId: "env-1:v2" },
    })
  })

  it("omits the environment when the host cannot enforce it", async () => {
    await expect(
      resolveSquadBindingCandidates(project, {
        listEnvironments: async () => [environment],
        listVersions: async () => [version],
        createEnvironment: () =>
          ({ preflight: () => ({ ok: false, missing: ["sandbox"] }) }) as never,
      })
    ).resolves.toEqual({ repositoryPath: "/repo" })
  })

  /** Two usable environments is a choice for the user, not a guess. */
  it("omits the environment when several are usable", async () => {
    await expect(
      resolveSquadBindingCandidates(project, {
        listEnvironments: async () => [environment, { ...environment, id: "env-2" }],
        listVersions: async (id) => [{ ...version, id: `${id}:v1`, environmentId: id }],
        createEnvironment: enforceable,
      })
    ).resolves.toEqual({ repositoryPath: "/repo" })
  })

  it("skips disabled environments and versionless ones", async () => {
    await expect(
      resolveSquadBindingCandidates(project, {
        listEnvironments: async () => [
          { ...environment, isEnabled: false },
          { ...environment, id: "env-2" },
        ],
        listVersions: async (id) => (id === "env-2" ? [] : [version]),
        createEnvironment: enforceable,
      })
    ).resolves.toEqual({ repositoryPath: "/repo" })
  })

  it("still names the repository when the environment read fails", async () => {
    await expect(
      resolveSquadBindingCandidates(project, {
        listEnvironments: async () => {
          throw new Error("db locked")
        },
        createEnvironment: enforceable,
      })
    ).resolves.toEqual({ repositoryPath: "/repo" })
  })

  it("has nothing to offer without a project", async () => {
    await expect(resolveSquadBindingCandidates(undefined)).resolves.toEqual({})
  })
})
