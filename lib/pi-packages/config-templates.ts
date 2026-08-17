/**
 * Reviewed default configuration for individual Pi packages.
 *
 * **These are not a Pi contract.** `~/.pi/agent/<name>.json` is a convention
 * each extension invented for itself — Pi's core knows nothing about these
 * files, and there is no schema anywhere to validate them against. That is why
 * the editor offers no completion or validation and this module offers only
 * "insert the values a human reviewed", never "here is the correct shape".
 *
 * The values come from `docs/research/pi-agent-plugin-stack-2026-08-13.md`.
 * Each one encodes a decision, not a preference:
 *
 *   - subagents starts *blocking-only* with depth 1, because every task is a
 *     fresh paid model context and the package's own defaults are unbounded;
 *   - goal caps automatic continuation, because autonomous turns are the one
 *     setting in this catalog that can compound cost without a ceiling;
 *   - permission-modes omits `plan` from `cycleOrder`, so the standalone plan
 *     package owns planning and the two do not both claim the mode;
 *   - plan-mode's `safeSubcommands` is an allowlist of *inspection* verbs. Note
 *     what it is not: read-only Git is reduced mutation, not confidentiality —
 *     history and remote metadata can still hold secrets.
 *
 * Structure only, so no i18n: these are literal file bodies a user inserts.
 */

/** Config file basename → reviewed body. Keyed by Pi's own file naming. */
export const PI_CONFIG_TEMPLATES: Readonly<Record<string, unknown>> = {
  "pi-statusline": {
    palettePreset: "ocean",
    density: "compact",
    separator: "dot",
    segments: ["model", "thinking", "cwd", "branch", "context", "cache", "cost"],
  },
  "pi-plan-mode": {
    thinkingLevel: "inherit",
    defaultPlanTools: ["read", "bash", "grep", "find", "ls"],
    implementationPlanRetention: "clear-on-start",
    defaultPlanExportPath: "PLAN.md",
    safeSubcommands: {
      git: [
        "status",
        "log",
        "diff",
        "show",
        "branch",
        "remote",
        "ls-files",
        "grep",
        "rev-parse",
        "blame",
        "describe",
        "merge-base",
        "ls-tree",
        "cat-file",
      ],
      gh: ["pr view", "pr list", "issue view", "issue list"],
    },
  },
  "pi-subagents": {
    blocking: { enabled: true, maxParallelTasks: 4 },
    // Retained but disabled on purpose: this is a section kept for a later
    // controlled trial, not dead config. Do not raise `maxDepth` until
    // one-level delegation has shown a concrete limitation.
    stateful: {
      enabled: false,
      transport: "auto",
      completionDelivery: "auto-resume",
      maxAgents: 6,
      maxActiveTurns: 2,
      maxDepth: 1,
      maxChildrenPerAgent: 2,
      maxMailboxMessages: 40,
      maxMailboxMessageBytes: 16384,
      idleTtlMs: 1800000,
      retentionDays: 7,
      maxStoredAgents: 20,
    },
    cwdPolicy: { consultation: "anywhere", delegation: "trusted-targets" },
    consult: { resources: "project-context" },
  },
  "pi-goal": {
    toolVisibility: "after-first-goal",
    experimental: { goals: false },
    rpc: { enabled: false },
    continuationLimits: { automaticTurns: 12, noProgressTurns: 3 },
  },
  "permission-mode": {
    $schema:
      "https://raw.githubusercontent.com/wynainfo/pi-permission-modes/main/schemas/permission-mode.schema.json",
    defaultMode: "default",
    // `plan` is absent deliberately — the standalone plan package owns
    // planning, and this also keeps YOLO unreachable from the cycle.
    cycleOrder: ["default", "build"],
  },
}

/**
 * The config file a package writes, as a basename without `.json`.
 *
 * Derived from the unscoped npm name, which is the convention every observed
 * package follows (`@narumitw/pi-statusline` → `pi-statusline.json`). Returns
 * null for git and local specs, where there is no name to derive from.
 */
export function piConfigBasename(spec: string): string | null {
  if (!spec.startsWith("npm:")) return null
  const withoutPrefix = spec.slice("npm:".length)
  // Strip the version pin before the scope, so `@a/b@1.0.0` → `@a/b`.
  const at = withoutPrefix.lastIndexOf("@")
  const name = at > 0 ? withoutPrefix.slice(0, at) : withoutPrefix
  const unscoped = name.includes("/") ? name.slice(name.lastIndexOf("/") + 1) : name
  return unscoped || null
}

/** Reviewed defaults for a spec, or null when none were recorded. */
export function piConfigTemplateFor(spec: string): unknown | null {
  const basename = piConfigBasename(spec)
  if (!basename) return null
  // `pi-permission-modes` writes `permission-mode.json` — singular, and not
  // derivable from the package name. Special-cased rather than guessed.
  const key = basename === "pi-permission-modes" ? "permission-mode" : basename
  return key in PI_CONFIG_TEMPLATES ? PI_CONFIG_TEMPLATES[key] : null
}

/** The absolute path a package's config file lives at, given Pi's agent dir. */
export function piConfigPath(agentDir: string, spec: string): string | null {
  const basename = piConfigBasename(spec)
  if (!basename) return null
  const key = basename === "pi-permission-modes" ? "permission-mode" : basename
  return `${agentDir.replace(/[\\/]+$/, "")}/${key}.json`
}
