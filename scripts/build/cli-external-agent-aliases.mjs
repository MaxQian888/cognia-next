import path from "node:path"

/** Build-only aliases that install the standalone CLI's Node process host. */
export function createCliExternalAgentAliasPlugin(root) {
  const aliases = new Map([
    [
      path.join(root, "lib/native/external-agent"),
      path.join(root, "cli/src/runtime/external/native-shim.ts"),
    ],
    [
      path.join(root, "lib/ai/agent/external/agent-transport"),
      path.join(root, "cli/src/runtime/external/host-branch.ts"),
    ],
    [
      path.join(root, "lib/ai/agent/external/agent-hooks"),
      path.join(root, "cli/src/runtime/external/agent-hooks-shim.ts"),
    ],
  ])
  return {
    name: "cli-external-agent-host",
    setup(build) {
      build.onResolve({ filter: /^(?:@\/|\.{1,2}\/)/ }, (args) => {
        const unresolved = args.path.startsWith("@/")
          ? path.join(root, args.path.slice(2))
          : path.resolve(args.resolveDir, args.path)
        const key = unresolved.replace(/\.(?:ts|tsx|js|mjs)$/, "")
        const replacement = aliases.get(key)
        return replacement ? { path: replacement } : undefined
      })
    },
  }
}
