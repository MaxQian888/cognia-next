/** Portable execution ceilings shared by dispatcher and receiver. No credentials or host paths. */
import type { HandoffPolicyV1 } from "@cognia/agent/handoff-envelope"
import type { AgentPermissionCeiling } from "@/types/agent/permission-ceiling"
import type { BuildOptionsContext } from "@/lib/claude/build-options"
import { deriveExternalSessionPermission } from "@/lib/ai/agent/external/policy/permission-cascade"
import { isPathUnderRoot } from "@/lib/sandbox/policy-bridge"

export const REMOTE_WORKER_POLICY_CAPABILITY = "worker-policy-v1"

export function encodeRemoteWorkerPolicy(
  ceiling: AgentPermissionCeiling,
  sandboxRequired: boolean,
  workspaceRoot?: string
): HandoffPolicyV1 | undefined {
  if (!Object.keys(ceiling).length && !sandboxRequired) return undefined
  const portableRoots = (roots: string[] | undefined): string[] | undefined =>
    roots?.map((root) => {
      const normalized = root.replace(/\\/g, "/").replace(/\/+$/, "")
      const base = workspaceRoot?.replace(/\\/g, "/").replace(/\/+$/, "")
      if (!base || (normalized !== base && !normalized.startsWith(`${base}/`))) {
        throw new Error(
          "Remote worker cannot enforce a sandbox root outside its repository binding"
        )
      }
      const relative = normalized === base ? "." : normalized.slice(base.length + 1)
      if (relative.split("/").includes(".."))
        throw new Error("Remote worker sandbox root must be normalized")
      return relative
    })
  const policy = ceiling.sandboxPolicy
  return {
    policyVersion: 1,
    ...(ceiling.permissionMode ? { permissionMode: ceiling.permissionMode } : {}),
    ...(ceiling.allowedTools ? { allowedTools: [...ceiling.allowedTools] } : {}),
    ...(ceiling.disallowedTools ? { disallowedTools: [...ceiling.disallowedTools] } : {}),
    ...(ceiling.mcpServers ? { mcpServerNames: ceiling.mcpServers.map(({ name }) => name) } : {}),
    sandboxRequired: sandboxRequired || !!policy,
    ...(policy
      ? {
          sandboxPolicy: {
            ...policy,
            writableRoots: portableRoots(policy.writableRoots),
            readableRoots: portableRoots(policy.readableRoots),
          },
        }
      : {}),
  }
}

export function decodeRemoteWorkerPolicy(
  policy: HandoffPolicyV1,
  workspaceRoot: string
): AgentPermissionCeiling {
  const bind = (roots: string[] | undefined) =>
    roots?.map((root) =>
      root === "." ? workspaceRoot : `${workspaceRoot.replace(/[\\/]$/, "")}/${root}`
    )
  return {
    ...(policy.permissionMode ? { permissionMode: policy.permissionMode } : {}),
    ...(policy.allowedTools ? { allowedTools: [...policy.allowedTools] } : {}),
    ...(policy.disallowedTools ? { disallowedTools: [...policy.disallowedTools] } : {}),
    ...(policy.mcpServerNames
      ? { mcpServers: policy.mcpServerNames.map((name) => ({ name })) }
      : {}),
    ...(policy.sandboxPolicy
      ? {
          sandboxPolicy: {
            ...policy.sandboxPolicy,
            writableRoots: bind(policy.sandboxPolicy.writableRoots),
            readableRoots: bind(policy.sandboxPolicy.readableRoots),
          },
        }
      : {}),
  }
}

/** Compose host and sender ceilings; a host's broader roots must never erase a narrower sender root. */
export function remoteWorkerCeiling(
  policy: HandoffPolicyV1,
  workspaceRoot: string,
  local?: AgentPermissionCeiling
): AgentPermissionCeiling {
  const incoming = decodeRemoteWorkerPolicy(policy, workspaceRoot)
  const effective = deriveExternalSessionPermission(incoming, local)
  for (const dimension of ["writableRoots", "readableRoots"] as const) {
    const parent = incoming.sandboxPolicy?.[dimension]
    const child = local?.sandboxPolicy?.[dimension]
    const roots =
      parent && child
        ? Array.from(
            new Set(
              parent.flatMap((a) =>
                child.flatMap((b) =>
                  isPathUnderRoot(a, b) ? [a] : isPathUnderRoot(b, a) ? [b] : []
                )
              )
            )
          )
        : (parent ?? child)
    // Current sandbox adapters interpret an empty path list as host defaults, not deny-all.
    // Refuse that unrepresentable contract rather than silently substituting defaults.
    if (roots?.length === 0)
      throw new Error(`Worker sandbox cannot represent an empty ${dimension} ceiling`)
    if (roots) effective.sandboxPolicy = { ...effective.sandboxPolicy, [dimension]: roots }
  }
  return effective
}

/** Reuse the ordinary final permission clamp and sandbox tool lowering. */
export async function resolveRemoteWorkerOptions(
  ctx: BuildOptionsContext,
  policy: HandoffPolicyV1,
  workspaceRoot: string
) {
  const { resolveSendOptions } = await import("@/lib/claude/build-options")
  const local = deriveExternalSessionPermission(
    { sandboxPolicy: ctx.character?.sandboxPolicy ?? ctx.appSettings?.sandboxPolicy ?? undefined },
    ctx.permissionCeiling
  )
  const effective = remoteWorkerCeiling(policy, workspaceRoot, local)
  const resolved = await resolveSendOptions({
    ...ctx,
    permissionCeiling: effective,
    ...(policy.mcpServerNames
      ? {
          preloadedMcpServers: (ctx.preloadedMcpServers ?? []).filter((server) =>
            policy.mcpServerNames!.includes(server.name)
          ),
        }
      : {}),
    ...(policy.sandboxRequired
      ? {
          session: ctx.session ? { ...ctx.session, sandboxEnabled: true } : ctx.session,
          character: ctx.character
            ? { ...ctx.character, sandboxEnabled: true, sandboxPolicy: effective.sandboxPolicy }
            : ctx.character,
          appSettings: {
            ...ctx.appSettings,
            sandboxDefaultEnabled: true,
            sandboxPolicy: effective.sandboxPolicy,
          } as BuildOptionsContext["appSettings"],
        }
      : {}),
  })
  if (policy.mcpServerNames && resolved.mcpServers) {
    resolved.mcpServers = Object.fromEntries(
      Object.entries(resolved.mcpServers).filter(([name]) => policy.mcpServerNames!.includes(name))
    )
  }
  return resolved
}
