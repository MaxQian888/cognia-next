/**
 * The absolute path of the folder the user currently has open.
 *
 * This is the one fact almost every filesystem-touching plugin needs and the
 * one it cannot derive: `ctx.fs` is sandboxed to the plugin's own data
 * directory, so a plugin that wants to read the user's project has to be told
 * where that project is. Before this module existed the answer was copied —
 * once in `lib/plugin/cli-tools/execute-cli-tool.ts` and again, verbatim
 * `require`s and all, inside the `workspace-tools` plugin — which is two
 * places to update when the root resolution changes and two chances to drift.
 *
 * The resolution mirrors `lib/claude/build-options.ts`: the active project's
 * PRIMARY root. A project may declare several roots; the primary one is the
 * cwd an agent turn would run in, so it is also the root a plugin tool should
 * read relative to.
 *
 * Both imports are lazy `require`s on purpose: the project store pulls in the
 * renderer's Dexie graph, and a plugin that never asks for the root — or a
 * non-UI bundle that has no store at all — must not pay for it. A missing
 * store is "no workspace open", not an error.
 */
export function getActiveWorkspaceRoot(): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { useProjectStore } = require("@/stores/project/project-store") as {
      useProjectStore: {
        getState: () => {
          activeProjectId: string | null
          projects: Array<{ id: string; roots?: unknown }>
        }
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { primaryRootOf } = require("@/lib/workspace/roots") as {
      primaryRootOf: (p: { roots?: unknown }) => { path?: string } | undefined
    }
    const state = useProjectStore.getState()
    const project = state.activeProjectId
      ? state.projects.find((p) => p.id === state.activeProjectId)
      : undefined
    return project ? primaryRootOf(project)?.path : undefined
  } catch {
    return undefined
  }
}
