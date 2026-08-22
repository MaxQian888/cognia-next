import type { MigrationVendor, MigrationVendorProbe } from "@/lib/agent-migration/types"
import type { OnboardingShell } from "@cognia/agent-config-types"
import { vendorLabel, type OnboardingCapability, type ScanResult } from "./scan"

/**
 * The recommended path's plan: everything setup is about to do, on one screen,
 * before it does any of it.
 *
 * ## Why a plan object rather than "just do it"
 *
 * Two of these lines write to the user's machine — the ADR-0107 config
 * migration copies another agent's commands, settings, skills and MCP servers
 * into Cognia, and the ADR-0062 history import writes every transcript it can
 * find into Dexie. Neither has an undo. Doing that silently because the user
 * pressed a button labelled "recommended" is not a shortcut, it is a decision
 * taken on their behalf, so the recommended path shows the list first and lets
 * any line be dropped.
 *
 * ## Why it is a pure function
 *
 * The three facts it reads — what the probe found, how many transcripts are on
 * disk, whether this device can already reach a model — arrive from three
 * hooks with entirely different settling behaviour (`useMachineScan`'s
 * soft/hard timers, `useHistoryImport`'s source walk, `useModelAccess`'s
 * latch). Keeping the derivation here means every combination of those, and
 * every shell, is testable without a Tauri webview.
 *
 * ## Shape of a line
 *
 * A line is either an **action** the user can drop (`required: false` — it
 * renders a checkbox) or a **statement of fact** they cannot (`required: true`
 * — no checkbox, because there is nothing to decide). "We will use the Claude
 * Code login already on this machine" is the second kind: deselecting it would
 * not mean "do less", it would mean "now ask me to sign in again".
 */
export type ExpressItemKind =
  /** Bring one vendor's commands / settings / skills / MCP across (ADR-0107). */
  | "migrate-config"
  /** Bring past conversations across, from every ADR-0062 source. */
  | "import-history"
  /** Reach the model through an agent CLI that is already signed in. */
  | "use-runtime"
  /** Connect a model. Interactive — the step renders a sign-in block for it. */
  | "sign-in"
  /**
   * Pair with a desktop. Interactive, and the paired phone's substitute for
   * every credential line: its compute and its credentials both live on the
   * machine it pairs with, so asking it to sign in would configure the wrong
   * device (the same reason `provider` is not in its step-by-step sequence).
   */
  | "pair"
  /** What the first task will be able to do on this device. */
  | "capabilities"

export interface ExpressPlanItem {
  /** Stable within a plan; used as a React key and a scene node id. */
  id: string
  kind: ExpressItemKind
  /** Pre-checked. Dropping a line is a deliberate act, not the default. */
  selected: boolean
  /** True for statements of fact — rendered without a checkbox. */
  required: boolean
  /** Which vendor a `migrate-config` line acts on. */
  vendor?: MigrationVendor
  /** Transcript count for `import-history`; capability count for `capabilities`. */
  count?: number
  /**
   * Display label — the preset's own name for `use-runtime`, and the vendor's
   * for `migrate-config`. Resolved here rather than in the component because
   * the raw `MigrationVendor` id is an internal token: a line reading "Bring
   * over your claude-code setup" is printing a slug at the user.
   */
  label?: string
  /** Capabilities a `capabilities` line is reporting. */
  capabilities?: readonly OnboardingCapability[]
}

export interface BuildExpressPlanInput {
  shell: OnboardingShell
  scan: ScanResult
  /** Conversations found across every source. `useHistoryImport().total`. */
  historyTotal: number
  /**
   * Whether this device can already reach a model. `null` means the probe has
   * not settled (or cannot answer, as on a paired phone) — treated as "yes"
   * so the plan does not flash a sign-in line that disappears a tick later.
   */
  modelAccess: boolean | null
  /**
   * Whether this phone has a companion target. Only consulted on
   * `mobile-paired`; `null` while the config is still loading, which reads as
   * "do not claim it is unpaired yet".
   */
  paired?: boolean | null
}

/**
 * Order is the order the screen lists them and the order they run in.
 *
 * Config before history: the migration writes settings and skills, and a
 * transcript imported before its skills exist would render referencing a
 * subagent Cognia does not have yet. Model access last, because it is the only
 * line that can block on a browser round-trip and the writes above should not
 * be waiting behind it.
 */
const KIND_ORDER: readonly ExpressItemKind[] = [
  "migrate-config",
  "import-history",
  "use-runtime",
  "sign-in",
  "pair",
  "capabilities",
]

/**
 * Build the plan this device should show.
 *
 * On a machine with nothing installed and no credential this collapses to two
 * lines — sign in, and here is what you will be able to do — which is the
 * intended behaviour rather than a degenerate case: the screen is one adaptive
 * list, not a fixed form with empty rows. The recommended path exists on every
 * shell for the same reason, even where there is nothing local to find; a
 * browser's plan is the sign-in line plus the capability line, and that still
 * folds what used to be two screens into one.
 */
export function buildExpressPlan(input: BuildExpressPlanInput): ExpressPlanItem[] {
  const items: ExpressPlanItem[] = []

  for (const probe of migratableProbes(input.scan.migratable)) {
    items.push({
      id: `migrate-${probe.vendor}`,
      kind: "migrate-config",
      vendor: probe.vendor,
      label: vendorLabel(input.scan, probe.vendor),
      selected: true,
      required: false,
    })
  }

  if (input.historyTotal > 0) {
    items.push({
      id: "history",
      kind: "import-history",
      count: input.historyTotal,
      selected: true,
      required: false,
    })
  }

  // An authenticated CLI is why the step-by-step path can skip its sign-in
  // step entirely, so the recommended path has to say the same thing out loud
  // — otherwise a user with a working Claude Code sees a plan that never
  // mentions how their first task is going to reach a model.
  const signedIn = input.scan.runtimes.find((runtime) => runtime.authenticated)
  if (input.shell === "mobile-paired") {
    items.push({ id: "pair", kind: "pair", selected: true, required: true })
  } else if (signedIn) {
    items.push({
      id: "runtime",
      kind: "use-runtime",
      label: signedIn.label,
      selected: true,
      required: true,
    })
  } else if (input.modelAccess === false) {
    items.push({ id: "sign-in", kind: "sign-in", selected: true, required: true })
  }

  items.push({
    id: "capabilities",
    kind: "capabilities",
    capabilities: input.scan.capabilities,
    count: input.scan.capabilities.length,
    selected: true,
    required: true,
  })

  return items.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind))
}

/**
 * Vendors worth offering. Mirrors `migratableVendors` in `./scan.ts` but keeps
 * the probe rows, because the plan line needs the vendor id *and* the caller
 * needs to know a config path was found.
 */
function migratableProbes(probes: readonly MigrationVendorProbe[]): MigrationVendorProbe[] {
  return probes.filter((probe) => probe.installed)
}

/**
 * Re-apply the user's checkbox state to a freshly built plan.
 *
 * The plan is rebuilt whenever a probe settles, so selection cannot live on
 * the item objects — it has to be folded back in from the ids the screen is
 * holding. Unknown ids are dropped rather than kept: a line the user
 * unchecked and then lost (a probe that stopped reporting a vendor) must not
 * reappear checked, and one that never existed cannot have been chosen.
 */
export function withSelection(
  items: readonly ExpressPlanItem[],
  selectedIds: readonly string[]
): ExpressPlanItem[] {
  const chosen = new Set(selectedIds)
  return items.map((item) => ({ ...item, selected: item.required || chosen.has(item.id) }))
}

/** The lines that will actually run, in execution order. */
export function selectedActions(items: readonly ExpressPlanItem[]): ExpressPlanItem[] {
  return items.filter(
    (item) => item.selected && (item.kind === "migrate-config" || item.kind === "import-history")
  )
}

/**
 * Whether the plan can be applied at all.
 *
 * A plan whose only interactive line is `sign-in` is not runnable until that
 * line is satisfied: applying it would import nothing and hand the user a
 * first task with no model behind it, which is the exact failure the flow's
 * terminal step guards against.
 */
export function isPlanRunnable(input: {
  items: readonly ExpressPlanItem[]
  /** Live model access, including a credential added on this very screen. */
  modelAccess: boolean | null
  /** Companion pairing state, for the one shell whose plan has a `pair` line. */
  paired?: boolean | null
}): boolean {
  if (input.items.some((item) => item.kind === "pair") && input.paired !== true) return false
  const needsSignIn = input.items.some((item) => item.kind === "sign-in")
  if (!needsSignIn) return true
  return input.modelAccess !== false
}
