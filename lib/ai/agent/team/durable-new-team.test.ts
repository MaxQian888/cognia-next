import type { Project } from "@/types"
import type { ProjectEnvironment, ProjectEnvironmentVersion } from "@/types/project-environment"
import { resolveDurableNewTeamConfig } from "./durable-new-team"

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

describe("resolveDurableNewTeamConfig", () => {
  it("selects durable-v2 only when the immutable environment passes host preflight", async () => {
    const config = await resolveDurableNewTeamConfig(project, {
      listEnvironments: async () => [environment],
      listVersions: async () => [version],
      createEnvironment: () => ({ preflight: () => ({ ok: true, missing: [] }) }) as never,
    })

    expect(config).toEqual({
      runtimeVersion: "durable-v2",
      writeMode: "single-writer",
      repositories: [{ id: "primary", role: "primary", path: "/repo", writable: true }],
      environmentRef: { environmentId: "env-1", versionId: "env-1:v2" },
    })
  })

  it("fails closed to the legacy default when the host cannot enforce the profile", async () => {
    await expect(
      resolveDurableNewTeamConfig(project, {
        listEnvironments: async () => [environment],
        listVersions: async () => [version],
        createEnvironment: () =>
          ({ preflight: () => ({ ok: false, missing: ["sandbox"] }) }) as never,
      })
    ).resolves.toBeNull()
  })

  it("requires a project repository root", async () => {
    await expect(resolveDurableNewTeamConfig(undefined)).resolves.toBeNull()
  })
})
