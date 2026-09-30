/**
 * The External Bridge workspace tool family (roadmap 2026-09-29, Phase 2):
 * names and the scope each one needs. Pure — the MCP sidecar bundle, the
 * permission gate's `TOOL_TO_SCOPE` and the renderer core all read it.
 *
 * Four default-OFF scopes, split by what a grant risks rather than by which
 * host crate answers the call:
 *
 *  - `workspace:read`  — list, read and search files of granted roots;
 *  - `workspace:write` — write, edit, move and delete inside them;
 *  - `git:read`        — status, diffs, history (never a git write);
 *  - `shell:run`       — run commands in a granted root and manage the jobs
 *                        they become. One scope, not a `shell` / `jobs` pair:
 *                        every command runs as a supervised job, so starting
 *                        one and reading or stopping it are the same grant.
 */

export const WORKSPACE_TOOL_SCOPES = {
  workspace_roots: "workspace:read",
  workspace_list: "workspace:read",
  workspace_read: "workspace:read",
  workspace_search: "workspace:read",
  workspace_write: "workspace:write",
  workspace_edit: "workspace:write",
  workspace_move: "workspace:write",
  workspace_delete: "workspace:write",
  git_status: "git:read",
  git_diff: "git:read",
  git_log: "git:read",
  git_show: "git:read",
  shell_run: "shell:run",
  job_output: "shell:run",
  job_list: "shell:run",
  job_kill: "shell:run",
} as const

export type WorkspaceToolName = keyof typeof WORKSPACE_TOOL_SCOPES

export type WorkspaceBridgeScope = (typeof WORKSPACE_TOOL_SCOPES)[WorkspaceToolName]

export const WORKSPACE_TOOL_NAMES = Object.keys(WORKSPACE_TOOL_SCOPES) as WorkspaceToolName[]

export function isWorkspaceToolName(name: unknown): name is WorkspaceToolName {
  return typeof name === "string" && Object.hasOwn(WORKSPACE_TOOL_SCOPES, name)
}
