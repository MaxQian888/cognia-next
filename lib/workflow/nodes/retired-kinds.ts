/**
 * Node kinds that this app used to provide and no longer does.
 *
 * A saved workflow keeps whatever `node.type` string it was authored with, and
 * `WorkflowNodeKind` is a closed union — so once a kind is retired, an existing
 * workflow holds a `node.type` that resolves to nothing. Without this list the
 * two "no executor" cases are indistinguishable at runtime, because a node
 * records no provenance: a kind whose plugin is merely uninstalled looks
 * exactly like a kind that was deleted from the product. Telling a user to
 * install a plugin that can never exist is the failure this prevents.
 *
 * Entries are permanent. A retired kind may be re-used only if it is restored
 * with the same contract, in which case its entry is removed here.
 */

/** Why a kind is gone, and what (if anything) replaces it. */
export interface RetiredNodeKind {
  /** App version the kind stopped being provided in. */
  readonly removedIn: string
  /**
   * Replacement kind, when a like-for-like one exists. Absent when the
   * capability left the product entirely — the workflow needs re-authoring,
   * not a substitution.
   */
  readonly replacedBy?: string
}

/**
 * The thirteen `action.github.*` kinds and `trigger.github.webhook` were
 * provided by the bundled github-delivery plugin, removed in favour of the
 * Marketplace Integration runtime (ADR-0018, ADR-0026). No built-in kind
 * replaces them, so none carries a `replacedBy`.
 *
 * The compatibility installer re-registers these same kind strings from a
 * third-party plugin. That is why availability is checked before retirement
 * downstream: with the compat plugin installed these resolve normally, and a
 * workflow using them is not broken and must not be reported as such.
 */
const GITHUB_DELIVERY_REMOVAL = "0.2.0"

// `Object.freeze` is shallow, so each record is frozen on the way in — a
// caller that reaches an entry must not be able to rewrite its `removedIn`.
const freezeAll = (
  entries: Record<string, RetiredNodeKind>
): Readonly<Record<string, RetiredNodeKind>> => {
  for (const entry of Object.values(entries)) Object.freeze(entry)
  return Object.freeze(entries)
}

const RETIRED = freezeAll({
  "trigger.github.webhook": { removedIn: GITHUB_DELIVERY_REMOVAL },
  "action.github.openPr": { removedIn: GITHUB_DELIVERY_REMOVAL },
  "action.github.mergePr": { removedIn: GITHUB_DELIVERY_REMOVAL },
  "action.github.closePr": { removedIn: GITHUB_DELIVERY_REMOVAL },
  "action.github.reviewPr": { removedIn: GITHUB_DELIVERY_REMOVAL },
  "action.github.reviewPrInline": { removedIn: GITHUB_DELIVERY_REMOVAL },
  "action.github.commentPr": { removedIn: GITHUB_DELIVERY_REMOVAL },
  "action.github.commentIssue": { removedIn: GITHUB_DELIVERY_REMOVAL },
  "action.github.closeIssue": { removedIn: GITHUB_DELIVERY_REMOVAL },
  "action.github.labelIssue": { removedIn: GITHUB_DELIVERY_REMOVAL },
  "action.github.runIssueLoop": { removedIn: GITHUB_DELIVERY_REMOVAL },
  "action.github.createRelease": { removedIn: GITHUB_DELIVERY_REMOVAL },
  "action.github.generateChangelog": { removedIn: GITHUB_DELIVERY_REMOVAL },
  "action.github.pushTag": { removedIn: GITHUB_DELIVERY_REMOVAL },
})

/**
 * The retirement record for `kind`, or `undefined` if it was never retired.
 *
 * `kind` is persisted, caller-controlled data, so the lookup is own-property
 * only: a bare index would answer truthy for `constructor` / `toString` and
 * report an arbitrary node as retired.
 */
export function retiredNodeKind(kind: string): RetiredNodeKind | undefined {
  return Object.hasOwn(RETIRED, kind) ? RETIRED[kind] : undefined
}

/** Every retired kind string. Test/diagnostic use — not an execution path. */
export function retiredNodeKinds(): readonly string[] {
  return Object.keys(RETIRED)
}
