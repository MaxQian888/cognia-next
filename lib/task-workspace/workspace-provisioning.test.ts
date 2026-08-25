import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import {
  provisioningForProject,
  provisioningForWorkspaceRoot,
  type ProvisioningProject,
} from "./workspace-provisioning"
import type { Project } from "@/types"

const LOCAL: ProvisioningProject = {
  roots: [{ id: "r1", path: "/repos/app", isPrimary: true }],
  workspaceProvisioning: {
    accepted: ["cacheLink:node_modules", "include:.env"],
    reviewed: ["cacheLink:node_modules", "include:.env"],
  },
}

describe("provisioningForProject", () => {
  it("unions the repository's declaration with what this device accepted", async () => {
    const provisioning = await provisioningForProject(LOCAL, {
      declared: async () => ({ sparsePaths: ["apps/web"], include: ["config.local.json"] }),
    })
    expect(provisioning).toEqual({
      sparsePaths: ["apps/web"],
      cacheLinks: [{ source: "node_modules", target: "node_modules" }],
      include: ["config.local.json", ".env"],
    })
  })

  it("returns the accepted set alone when the repository declares nothing", async () => {
    expect(await provisioningForProject(LOCAL, { declared: async () => undefined })).toEqual({
      cacheLinks: [{ source: "node_modules", target: "node_modules" }],
      include: [".env"],
    })
  })

  it("keeps the local acceptance when the declaration cannot be read", async () => {
    // The declaration is what failed. Dropping the user's own accepted set
    // because a file they never wrote is unreadable would be collateral.
    const provisioning = await provisioningForProject(LOCAL, {
      declared: async () => {
        throw new Error("EACCES")
      },
    })
    expect(provisioning).toEqual({
      cacheLinks: [{ source: "node_modules", target: "node_modules" }],
      include: [".env"],
    })
  })

  it("returns undefined when neither side asks for anything", async () => {
    expect(
      await provisioningForProject({ roots: [] }, { declared: async () => undefined })
    ).toBeUndefined()
  })
})

describe("provisioningForWorkspaceRoot", () => {
  const projects = [
    { id: "p1", roots: [{ id: "r1", path: "/repos/other", isPrimary: true }] },
    { id: "p2", ...LOCAL },
  ] as unknown as Project[]

  it("resolves the workspace that mounts the path", async () => {
    const provisioning = await provisioningForWorkspaceRoot("/repos/app", {
      projects: async () => projects,
      declared: async () => undefined,
    })
    expect(provisioning).toEqual({
      cacheLinks: [{ source: "node_modules", target: "node_modules" }],
      include: [".env"],
    })
  })

  it("returns undefined for a directory no workspace mounts", async () => {
    // An adopted folder or a bare `--cwd`: the same answer these call sites
    // had before provisioning reached them at all.
    expect(
      await provisioningForWorkspaceRoot("/tmp/scratch", {
        projects: async () => projects,
        declared: async () => undefined,
      })
    ).toBeUndefined()
  })

  it("returns undefined for an empty root without touching the store", async () => {
    const projectsDep = jest.fn(async () => projects)
    expect(await provisioningForWorkspaceRoot("  ", { projects: projectsDep })).toBeUndefined()
    expect(projectsDep).not.toHaveBeenCalled()
  })

  it("degrades to undefined when the workspace list is unreadable", async () => {
    // Headless shells have neither a hydrated store nor Dexie. A worktree with
    // a cold cache is slower; a throw here would mean no worktree at all.
    const provisioning = await provisioningForWorkspaceRoot("/repos/app", {
      projects: async () => {
        throw new Error("no database in this shell")
      },
    })
    expect(provisioning).toBeUndefined()
  })
})

/**
 * The guard against this going dormant again.
 *
 * Provisioning existed and worked for a year while reaching exactly one of the
 * six places that acquire a workspace bundle, because nothing connected "a new
 * acquisition site" to "ask what it should be provisioned with". A seventh site
 * added without that call fails here.
 */
describe("every acquisition site asks for provisioning", () => {
  const callers = execFileSync(
    "git",
    ["grep", "-l", "acquireWorkspaceBundle\\|acquireBundle(", "--", "*.ts", "*.tsx"],
    { cwd: process.cwd(), encoding: "utf8" }
  )
    .split("\n")
    .filter(Boolean)
    .filter((file) => !file.endsWith(".test.ts") && !file.endsWith(".test.tsx"))
    // The client declares the function; the types file names it. Neither
    // acquires anything.
    .filter(
      (file) =>
        file !== "lib/task-workspace/client.ts" &&
        file !== "lib/task-workspace/types.ts" &&
        file !== "lib/task-workspace/workspace-provisioning.ts"
    )

  it("found the acquisition sites to check", () => {
    // A sweep that scanned nothing passes every assertion below it.
    expect(callers.length).toBeGreaterThanOrEqual(6)
  })

  it.each(callers)("%s passes provisioning to the bundle it acquires", (file) => {
    const source = readFileSync(join(process.cwd(), file), "utf8")
    expect(source).toMatch(/provisioning/i)
  })
})
