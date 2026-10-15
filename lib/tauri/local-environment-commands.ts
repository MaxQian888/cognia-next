/**
 * The runtime-environment commands a desktop answers itself (ADR-0221 G7).
 *
 * A desktop with remote sandboxes installs the same pool a server does, so
 * its brain reads the catalog, the driver status and the declarations under
 * the same `environment_*` names it would send a paired Host. Locally there
 * is one Tauri command for all of them, `environment_local_call`, which
 * answers through the Host's own companion arms (`rpc/environment.rs`) — so
 * the desktop and a server can never disagree about what a call means.
 *
 * The list is the Rust arm's `COMMANDS`; the co-located test reads that file
 * and fails when the two drift.
 */

export const LOCAL_ENVIRONMENT_COMMAND = "environment_local_call"

export const LOCAL_ENVIRONMENT_COMMANDS: ReadonlySet<string> = new Set([
  "environment_delivery_list",
  "environment_catalog_list",
  "environment_catalog_get",
  "environment_catalog_create",
  "environment_catalog_update",
  "environment_catalog_delete",
  "environment_declaration_read",
  "environment_build_start",
  "environment_build_get",
  "environment_build_cancel",
  "environment_ports_list",
  "environment_spec_resolve_preview",
  "environment_approval_list",
  "environment_approval_get",
  "environment_approval_approve",
  "environment_approval_revoke",
  "environment_egress_grant_create",
  "environment_egress_grant_delete",
  "environment_probe_get",
  "environment_driver_status",
  "environment_image_inspect",
])

/** The local invoke a desktop sends for `name`: itself, or the environment dispatcher. */
export function localInvocation(
  name: string,
  args?: Record<string, unknown>
): { command: string; args: Record<string, unknown> | undefined } {
  if (!LOCAL_ENVIRONMENT_COMMANDS.has(name)) return { command: name, args }
  return { command: LOCAL_ENVIRONMENT_COMMAND, args: { name, args: args ?? {} } }
}
