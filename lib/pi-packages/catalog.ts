/**
 * Curated Pi package catalog.
 *
 * Source of truth: `docs/research/pi-agent-plugin-stack-2026-08-13.md`, which
 * carries the pins, maintenance signals, overlap groups and context costs that
 * no registry exposes. pi.dev/packages is an npm-keyword gallery with no JSON
 * API, and npm itself can only tell you versions and download counts — none of
 * the fields below. That is why the catalog is curated rather than fetched.
 *
 * **Structure only.** Every user-facing sentence (summary, risk, removal
 * criterion) lives in `i18n/messages/{en,zh-CN}/piPackages.json` under a key
 * derived mechanically from `id`, so `pnpm lint:i18n` can actually check the
 * pair. The numeric fields here are not prose — they are the inputs to the
 * budget meter and the conflict graph.
 *
 * Token figures are the research report's estimates for *always-visible*
 * surface (tool schemas plus any per-turn injected text). They are deliberately
 * order-of-magnitude: the point is to rank packages against each other, not to
 * predict a bill.
 */

/** How strongly the research recommends a package. */
export type PiPackageTier = "core" | "optional" | "avoid"

/**
 * Capability groups where installing two packages is actively harmful — they
 * compete for the same hooks and tool names, double the prompts, and enlarge
 * the schema surface without adding independent capability.
 */
export type PiOverlapGroup =
  | "permission"
  | "footer"
  | "plan"
  | "mcp-adapter"
  | "subagents"
  | "browser"
  | "memory"
  | "goal"
  | "notification"

export interface PiCatalogEntry {
  /** Stable id; also the i18n key suffix. */
  id: string
  /** The exact pinned spec the research recommends installing. */
  spec: string
  tier: PiPackageTier
  /** Groups this package occupies. Two entries sharing one group conflict. */
  overlapGroups: PiOverlapGroup[]
  /** Always-visible tool schemas this package contributes. */
  toolCount: number
  /** Rough always-on prompt tokens (schemas + per-turn injected text). */
  staticTokens: number
  /**
   * True when the package can start additional *paid model contexts*
   * (subagents, autonomous goal continuation). This dominates cost far more
   * than schema size, so the budget view reports it separately rather than
   * folding it into a token count that would understate it.
   */
  spawnsContexts?: boolean
  docsUrl?: string
  /** When a human last reviewed this row. */
  reviewedAt: string
}

const REVIEWED = "2026-08-13"

/**
 * The curated set. Ordering is stable and meaningful: core first, then
 * optional, then the explicit do-not-install rows — the UI renders in this
 * order rather than sorting, so the recommendation survives.
 */
export const PI_PACKAGE_CATALOG: readonly PiCatalogEntry[] = [
  {
    id: "aliou-pi-guardrails",
    spec: "npm:@aliou/pi-guardrails@0.17.0",
    tier: "core",
    overlapGroups: ["permission"],
    toolCount: 0,
    staticTokens: 0,
    docsUrl: "https://github.com/aliou/pi-guardrails",
    reviewedAt: REVIEWED,
  },
  {
    id: "narumitw-pi-statusline",
    spec: "npm:@narumitw/pi-statusline@0.49.6",
    tier: "core",
    overlapGroups: ["footer"],
    toolCount: 0,
    staticTokens: 0,
    docsUrl: "https://github.com/narumiruna/pi-extensions",
    reviewedAt: REVIEWED,
  },
  {
    id: "narumitw-pi-plan-mode",
    spec: "npm:@narumitw/pi-plan-mode@0.49.3",
    tier: "core",
    overlapGroups: ["plan"],
    toolCount: 3,
    staticTokens: 600,
    docsUrl: "https://github.com/narumiruna/pi-extensions",
    reviewedAt: REVIEWED,
  },
  {
    id: "pi-mcp-adapter",
    spec: "npm:pi-mcp-adapter@2.23.0",
    tier: "core",
    overlapGroups: ["mcp-adapter"],
    toolCount: 1,
    staticTokens: 200,
    docsUrl: "https://github.com/nicobailon/pi-mcp-adapter",
    reviewedAt: REVIEWED,
  },
  {
    id: "narumitw-pi-subagents",
    spec: "npm:@narumitw/pi-subagents@1.0.0",
    tier: "core",
    overlapGroups: ["subagents"],
    toolCount: 4,
    staticTokens: 800,
    spawnsContexts: true,
    docsUrl: "https://github.com/narumiruna/pi-extensions",
    reviewedAt: REVIEWED,
  },
  {
    id: "juicesharp-rpiv-ask-user-question",
    spec: "npm:@juicesharp/rpiv-ask-user-question@2.4.0",
    tier: "core",
    overlapGroups: [],
    toolCount: 1,
    staticTokens: 250,
    reviewedAt: REVIEWED,
  },
  {
    id: "juicesharp-rpiv-todo",
    spec: "npm:@juicesharp/rpiv-todo@2.4.0",
    tier: "core",
    overlapGroups: [],
    toolCount: 1,
    staticTokens: 200,
    reviewedAt: REVIEWED,
  },
  {
    id: "gotgenes-pi-permission-system",
    spec: "npm:@gotgenes/pi-permission-system@25.0.0",
    tier: "optional",
    overlapGroups: ["permission"],
    toolCount: 0,
    staticTokens: 300,
    reviewedAt: REVIEWED,
  },
  {
    id: "pi-permission-modes",
    spec: "npm:pi-permission-modes@2.2.0",
    tier: "optional",
    // Ships a Plan mode too, but the recommended configuration removes `plan`
    // from `cycleOrder` so the standalone plan package owns planning. Listing
    // `plan` here unconditionally would make the recommended power stack warn
    // about itself; Cognia cannot read that package's own config, so a user
    // who re-enables plan there gets no warning — a documented limitation.
    overlapGroups: ["permission"],
    toolCount: 2,
    staticTokens: 700,
    docsUrl: "https://github.com/wynainfo/pi-permission-modes",
    reviewedAt: REVIEWED,
  },
  {
    id: "narumitw-pi-worktree",
    spec: "npm:@narumitw/pi-worktree@0.50.0",
    tier: "optional",
    overlapGroups: [],
    toolCount: 0,
    staticTokens: 0,
    reviewedAt: REVIEWED,
  },
  {
    id: "narumitw-pi-github-pr",
    spec: "npm:@narumitw/pi-github-pr@0.49.3",
    tier: "optional",
    overlapGroups: [],
    toolCount: 0,
    staticTokens: 0,
    reviewedAt: REVIEWED,
  },
  {
    id: "narumitw-pi-lsp",
    spec: "npm:@narumitw/pi-lsp@0.49.4",
    tier: "optional",
    overlapGroups: [],
    toolCount: 2,
    staticTokens: 450,
    reviewedAt: REVIEWED,
  },
  {
    id: "pi-rtk-optimizer",
    spec: "npm:pi-rtk-optimizer@0.9.0",
    tier: "optional",
    overlapGroups: [],
    toolCount: 0,
    staticTokens: 0,
    reviewedAt: REVIEWED,
  },
  {
    id: "pi-web-access",
    spec: "npm:pi-web-access@0.22.0",
    tier: "optional",
    overlapGroups: [],
    toolCount: 4,
    staticTokens: 900,
    docsUrl: "https://github.com/nicobailon/pi-web-access",
    reviewedAt: REVIEWED,
  },
  {
    id: "narumitw-pi-chrome-devtools",
    spec: "npm:@narumitw/pi-chrome-devtools@0.51.0",
    tier: "optional",
    overlapGroups: ["browser"],
    toolCount: 5,
    staticTokens: 1000,
    reviewedAt: REVIEWED,
  },
  {
    id: "narumitw-pi-goal",
    spec: "npm:@narumitw/pi-goal@0.51.0",
    tier: "optional",
    overlapGroups: ["goal"],
    toolCount: 3,
    staticTokens: 600,
    spawnsContexts: true,
    reviewedAt: REVIEWED,
  },
  {
    id: "pi-memory",
    spec: "npm:pi-memory@0.4.2",
    tier: "optional",
    overlapGroups: ["memory"],
    toolCount: 7,
    staticTokens: 1400,
    docsUrl: "https://github.com/jayzeng/pi-memory",
    reviewedAt: REVIEWED,
  },
  {
    id: "pi-subagents",
    spec: "npm:pi-subagents@0.47.1",
    tier: "optional",
    overlapGroups: ["subagents"],
    toolCount: 8,
    staticTokens: 1600,
    spawnsContexts: true,
    reviewedAt: REVIEWED,
  },
  {
    id: "gotgenes-pi-subagents",
    spec: "npm:@gotgenes/pi-subagents@19.2.2",
    tier: "optional",
    overlapGroups: ["subagents"],
    toolCount: 4,
    staticTokens: 800,
    spawnsContexts: true,
    reviewedAt: REVIEWED,
  },
  {
    id: "pi-atelier",
    spec: "npm:pi-atelier@0.8.1",
    tier: "optional",
    overlapGroups: ["footer", "notification"],
    toolCount: 0,
    staticTokens: 0,
    reviewedAt: REVIEWED,
  },
  {
    id: "narumitw-pi-workflow",
    spec: "npm:@narumitw/pi-workflow@0.2.0",
    tier: "avoid",
    overlapGroups: ["plan", "goal"],
    toolCount: 4,
    staticTokens: 900,
    spawnsContexts: true,
    reviewedAt: REVIEWED,
  },
  {
    id: "vtstech-pi-long-term-memory",
    spec: "npm:@vtstech/pi-long-term-memory@1.3.5",
    tier: "avoid",
    overlapGroups: ["memory"],
    toolCount: 3,
    // The package page documents ~4K tokens injected on *every* turn — by far
    // the largest static cost in the catalog, and the reason it is an "avoid".
    staticTokens: 4000,
    reviewedAt: REVIEWED,
  },
  {
    id: "pi-permission-system-legacy",
    spec: "npm:pi-permission-system@0.8.0",
    tier: "avoid",
    overlapGroups: ["permission"],
    toolCount: 0,
    staticTokens: 300,
    reviewedAt: REVIEWED,
  },
  {
    id: "pi-finish-notification",
    spec: "npm:pi-finish-notification@1.0.4",
    tier: "avoid",
    overlapGroups: ["notification"],
    toolCount: 0,
    staticTokens: 0,
    reviewedAt: REVIEWED,
  },
]

/** The three coherent stacks the research recommends, as ordered id lists. */
export const PI_STACK_PRESETS: Readonly<
  Record<"starter" | "balanced" | "power", readonly string[]>
> = {
  starter: ["aliou-pi-guardrails", "narumitw-pi-statusline"],
  balanced: [
    "aliou-pi-guardrails",
    "narumitw-pi-statusline",
    "narumitw-pi-plan-mode",
    "pi-mcp-adapter",
    "narumitw-pi-subagents",
    "narumitw-pi-worktree",
    "narumitw-pi-github-pr",
  ],
  power: [
    "pi-permission-modes",
    "narumitw-pi-statusline",
    "narumitw-pi-plan-mode",
    "pi-mcp-adapter",
    "narumitw-pi-subagents",
    "narumitw-pi-goal",
    "narumitw-pi-worktree",
    "narumitw-pi-github-pr",
    "narumitw-pi-lsp",
    "pi-web-access",
  ],
}

export type PiStackPresetId = keyof typeof PI_STACK_PRESETS

const BY_ID = new Map(PI_PACKAGE_CATALOG.map((entry) => [entry.id, entry]))

export function piCatalogEntry(id: string): PiCatalogEntry | undefined {
  return BY_ID.get(id)
}

/** i18n key for a catalog entry's prose. Derived, never hand-written. */
export function piCatalogMessageKey(id: string, field: "summary" | "risk" | "removeWhen"): string {
  return `catalog.${id}.${field}`
}
