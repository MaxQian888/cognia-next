// `clone_dep_source` / `list_cloned_deps` — clone a dependency's SOURCE repo into
// an ignored local workspace so the agent can read library internals, and list
// what has been cloned. Ported from oh-my-opencode-slim's clonedeps skill into
// cognia's sidecar tool shape. Network + write tool (approval-gated) plus a
// read-only lister.

import { z } from "zod"

import { tool, type ToolArgs } from "../../kernel/define.ts"
import { toolError, toolText } from "../../kernel/result.ts"
import { cloneDependencySource, listClonedDeps } from "./clone.ts"
import type { ClonedepsDeps } from "./clone.ts"

// ---- clone_dep_source -----------------------------------------------------

export const cloneDepSourceShape = {
  cwd: z.string().min(1).describe("Absolute path inside the target git repository."),
  repoUrl: z
    .string()
    .min(1)
    .describe("HTTPS git URL of the dependency's source repo (SSH / http / local paths rejected)."),
  reason: z
    .string()
    .optional()
    .describe("Why this source is needed (recorded in the manifest and shown to future agents)."),
  ref: z
    .string()
    .optional()
    .describe("Tag or branch to clone (prefer a pinned tag). Omit for the default branch."),
  name: z
    .string()
    .optional()
    .describe("Package/dependency name this source backs (e.g. '@opencode-ai/sdk')."),
  packagePath: z
    .string()
    .optional()
    .describe("Sub-path within a monorepo where this package lives (e.g. 'packages/sdk')."),
}

/** Test deps when `extra` carries a `runGit`; the SDK tool context otherwise. */
const injectedDeps = (extra: unknown): Partial<ClonedepsDeps> | undefined =>
  extra && typeof extra === "object" && typeof (extra as ClonedepsDeps).runGit === "function"
    ? (extra as Partial<ClonedepsDeps>)
    : undefined

export async function execCloneDepSource(
  args: ToolArgs<typeof cloneDepSourceShape>,
  deps?: unknown
) {
  try {
    const result = await cloneDependencySource(
      {
        cwd: args.cwd,
        repoUrl: args.repoUrl,
        ref: args.ref,
        name: args.name,
        reason: args.reason,
        packagePath: args.packagePath,
      },
      injectedDeps(deps)
    )
    const verb = result.reused ? "Reused existing clone" : "Cloned"
    return toolText({
      message: `${verb} at ${result.path} (${result.dependencyCount} dependencies tracked).`,
      ...result,
    })
  } catch (err) {
    return toolError(err, "clone_dep_source")
  }
}

export const cloneDepSourceTool = tool(
  "clone_dep_source",
  "Clone a dependency's SOURCE repository into an ignored local workspace " +
    "(.cognia/clonedeps/repos/) so you can read library internals. HTTPS only; idempotent; " +
    "records a tracked manifest and a managed .gitignore block. No build/install scripts run.",
  cloneDepSourceShape,
  execCloneDepSource
)

// ---- list_cloned_deps -----------------------------------------------------

export const listClonedDepsShape = {
  cwd: z.string().min(1).describe("Absolute path inside the target git repository."),
}

export async function execListClonedDeps(
  args: ToolArgs<typeof listClonedDepsShape>,
  deps?: unknown
) {
  try {
    const result = await listClonedDeps({ cwd: args.cwd }, injectedDeps(deps))
    return toolText({
      manifest: result.path,
      count: result.dependencies.length,
      dependencies: result.dependencies,
    })
  } catch (err) {
    return toolError(err, "list_cloned_deps")
  }
}

export const listClonedDepsTool = tool(
  "list_cloned_deps",
  "List the dependency source repos already cloned into .cognia/clonedeps/ for this workspace " +
    "(reads the manifest). Read-only.",
  listClonedDepsShape,
  execListClonedDeps
)

// ---- category export ------------------------------------------------------

/** Fixed registration order — do not reorder (prompt-cache stability). New tools APPEND. */
export const CLONEDEPS_TOOL_NAMES = Object.freeze(["clone_dep_source", "list_cloned_deps"])

/** All clonedeps tool definitions, in CLONEDEPS_TOOL_NAMES order. */
export const clonedepsTools = [cloneDepSourceTool, listClonedDepsTool]

for (let i = 0; i < clonedepsTools.length; i++) {
  if (clonedepsTools[i]!.name !== CLONEDEPS_TOOL_NAMES[i]) {
    throw new Error(
      `clonedeps tool order drift: expected ${CLONEDEPS_TOOL_NAMES[i]}, got ${clonedepsTools[i]!.name}`
    )
  }
}

/** Test-only handler exports. */
export const __testExports = { execCloneDepSource, execListClonedDeps }
