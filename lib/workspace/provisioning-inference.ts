/**
 * What a repository probably wants copied or linked into a managed worktree —
 * and why that stays a proposal instead of becoming a default.
 *
 * # The problem this exists for
 *
 * A managed worktree is a second checkout of the same repository. Git gives it
 * the tracked files and nothing else, so everything a build actually needs to
 * be fast — `node_modules`, `target`, `.venv` — is absent, and everything a
 * build needs to *work* that git never had — `.env` — is absent too. The first
 * turn in a fresh worktree therefore pays a cold install, every time.
 *
 * `apply_provisioning` in the native task-workspace service already fixes this:
 * it symlinks cache directories in and copies gitignored files in. Until now
 * the only thing that could ask for it was `.cognia/workspace.json`, a file the
 * repository author has to have committed. Almost no repository has one, so in
 * practice the mechanism was reachable but unreached.
 *
 * # Why this is not just "turn it on"
 *
 * A cache link is a symlink from the worktree to a directory **inside the
 * user's own checkout**. A task that runs `pnpm install` on a branch with
 * different dependencies rewrites the `node_modules` the user is working in.
 * Two tasks running at once write it simultaneously. That is a real cost, paid
 * by someone who did not ask for it, so it needs a person to say yes — pnpm's
 * own documentation makes the same point about sharing one writable store
 * between agents that do not trust each other.
 *
 * And an `include` copies a credential file into a second directory on disk.
 * Worth doing — a worktree without `.env` cannot run the app — but worth
 * naming.
 *
 * # Why this is device-local and not a repository declaration
 *
 * `.cognia/workspace.json` means "the person who wrote this repository asks for
 * X", and the approval dialog says exactly that. An inference means "Cognia
 * guessed X from a lockfile". Routing a guess through the repository-declaration
 * gate would make the trust prompt lie about where the request came from, so
 * the accepted set lives on the workspace row (`Project.workspaceProvisioning`)
 * and is merged *alongside* the declaration at acquisition time, never folded
 * into it. See `lib/workspace/repo-declared.ts` for the other half.
 *
 * # Pure
 *
 * Everything here is a function of a directory listing. The listing, the pnpm
 * probe and the persistence live in `hooks/workspace/use-provisioning-offer`.
 */

import type { WorkspaceProvisioning } from "@/lib/task-workspace/types"

/**
 * Whether pnpm on this machine can give a worktree its own `node_modules`
 * without copying anything, by linking from a store shared across projects.
 *
 * `enabled` is the outcome that changes what we propose: with a global virtual
 * store an install in a fresh worktree is already fast **and** isolated, which
 * is strictly better than sharing the source checkout's directory — so we stop
 * proposing the share.
 */
export type PnpmVirtualStore =
  /** `virtualStoreType=global` (or the legacy `enableGlobalVirtualStore`) is on. */
  | "enabled"
  /** pnpm is new enough to offer it, but it is off. */
  | "available"
  /** pnpm is absent or too old (the setting landed in 11.23). */
  | "unsupported"
  /** Not probed — web, or the probe failed. Treated like `unsupported`. */
  | "unknown"

/** The pnpm release that introduced `virtualStoreType`. */
export const PNPM_GLOBAL_STORE_MIN_VERSION = "11.23.0"

/** The one command that turns it on, shown verbatim rather than run for the user. */
export const PNPM_GLOBAL_STORE_COMMAND = "pnpm config set --global virtualStoreType global"

export type ProvisioningCandidateKind = "cacheLink" | "include"

export interface ProvisioningCandidate {
  /** Stable across probes — the accepted/reviewed record keys on this. */
  id: string
  kind: ProvisioningCandidateKind
  /** Relative to the workspace root; source and target are the same path. */
  path: string
  /** Marker files that produced the proposal, so the guess stays auditable. */
  evidence: string[]
  /**
   * i18n key suffix under `projectEnvironment.provisioning.risk.*`. Each rule
   * names its own consequence: "your main checkout changes too" and "branches
   * evict each other's build artifacts" are not the same warning.
   */
  riskKey: string
}

export interface ProvisioningConsent {
  /** Candidate ids the user accepted. */
  accepted: string[]
  /**
   * Candidate ids already decided, accepted or not. Kept separately so a
   * declined proposal is never offered again — the same "offer once" rule the
   * repository-declaration seeding uses, for the same reason: a card that
   * re-asks on every render is a card people learn to dismiss blindly.
   */
  reviewed: string[]
}

export const EMPTY_CONSENT: ProvisioningConsent = { accepted: [], reviewed: [] }

/** One immediate child of the workspace root. */
export interface ProbeEntry {
  name: string
  isDir: boolean
}

export interface ProvisioningProbe {
  /** Immediate children of the workspace root, gitignored ones included. */
  entries: readonly ProbeEntry[]
  /** Names among `entries` that git ignores. */
  ignored: readonly string[]
  pnpm: PnpmVirtualStore
}

interface CacheRule {
  path: string
  markers: string[]
  riskKey: string
  /** Only meaningful for the Node rule; see `inferProvisioning`. */
  pnpmManaged?: boolean
}

/**
 * Directories worth linking, and the marker that says the repository has one.
 *
 * Deliberately short. Go's module cache and Ruby's gem home are already global
 * on the machine, so a worktree does not miss them and proposing a link would
 * be theatre.
 */
const CACHE_RULES: CacheRule[] = [
  {
    path: "node_modules",
    markers: [
      "pnpm-lock.yaml",
      "package-lock.json",
      "yarn.lock",
      "bun.lockb",
      "bun.lock",
      "npm-shrinkwrap.json",
      "package.json",
    ],
    riskKey: "sharedInstall",
    pnpmManaged: true,
  },
  {
    path: "target",
    markers: ["Cargo.toml"],
    riskKey: "sharedBuildDir",
  },
  {
    path: ".venv",
    markers: ["uv.lock", "poetry.lock", "Pipfile", "pyproject.toml", "requirements.txt"],
    riskKey: "sharedInstall",
  },
]

/** The one risk an `include` carries: the file is credential-shaped. */
const INCLUDE_RISK_KEY = "copiedSecret"

/**
 * Every `riskKey` a candidate can carry, derived from the rules rather than
 * re-listed — `lint:i18n` cannot see a key built as `risk.${candidate.riskKey}`,
 * so the catalogue guard checks this set against both locales and a new rule
 * without a message fails there instead of rendering a raw key.
 */
export const PROVISIONING_RISK_KEYS: readonly string[] = [
  ...new Set([...CACHE_RULES.map((rule) => rule.riskKey), INCLUDE_RISK_KEY]),
].sort()

/** The two candidate kinds, for the same catalogue guard. */
export const PROVISIONING_CANDIDATE_KINDS = ["cacheLink", "include"] as const

/** `.env.example` and friends are committed samples, not the real file. */
const ENV_SAMPLE_SUFFIXES = ["example", "sample", "template", "dist", "defaults"]

function isEnvSecretName(name: string): boolean {
  if (name === ".env") return true
  if (!name.startsWith(".env.")) return false
  const suffix = name.slice(".env.".length).toLowerCase()
  return !ENV_SAMPLE_SUFFIXES.includes(suffix)
}

export function candidateId(kind: ProvisioningCandidateKind, path: string): string {
  return `${kind}:${path}`
}

/**
 * Propose provisioning for a workspace root.
 *
 * Ordering is cache links first, includes second — the same order
 * `apply_provisioning` applies them in, so the card reads like the thing that
 * will happen.
 */
export function inferProvisioning(probe: ProvisioningProbe): ProvisioningCandidate[] {
  const names = new Set(probe.entries.map((entry) => entry.name))
  const ignored = new Set(probe.ignored)
  const candidates: ProvisioningCandidate[] = []

  for (const rule of CACHE_RULES) {
    const evidence = rule.markers.filter((marker) => names.has(marker))
    if (!evidence.length) continue
    // A repository that TRACKS the directory already ships it to every
    // checkout, worktrees included. Linking over it would replace real content
    // with a pointer, and `apply_provisioning` would refuse anyway once the
    // path exists — so the proposal would be a promise we cannot keep.
    if (names.has(rule.path) && !ignored.has(rule.path)) continue
    // With a global virtual store a fresh worktree installs from links in a
    // shared store: fast without sharing a mutable directory. Proposing the
    // share on top of that is strictly worse.
    if (rule.pnpmManaged && probe.pnpm === "enabled" && evidence.includes("pnpm-lock.yaml")) {
      continue
    }
    candidates.push({
      id: candidateId("cacheLink", rule.path),
      kind: "cacheLink",
      path: rule.path,
      evidence,
      riskKey: rule.riskKey,
    })
  }

  for (const entry of probe.entries) {
    if (entry.isDir || !isEnvSecretName(entry.name)) continue
    // Only the ignored ones. A tracked `.env` is already in the worktree, and
    // copying it over itself is a no-op the user would still have to approve.
    if (!ignored.has(entry.name)) continue
    candidates.push({
      id: candidateId("include", entry.name),
      kind: "include",
      path: entry.name,
      evidence: [entry.name],
      riskKey: INCLUDE_RISK_KEY,
    })
  }

  return candidates
}

/** Candidates the user has not decided on yet. */
export function pendingCandidates(
  candidates: readonly ProvisioningCandidate[],
  consent: ProvisioningConsent | undefined
): ProvisioningCandidate[] {
  const reviewed = new Set(consent?.reviewed ?? [])
  return candidates.filter((candidate) => !reviewed.has(candidate.id))
}

/** Candidates the user accepted, still supported by the current probe. */
export function activeCandidates(
  candidates: readonly ProvisioningCandidate[],
  consent: ProvisioningConsent | undefined
): ProvisioningCandidate[] {
  const accepted = new Set(consent?.accepted ?? [])
  return candidates.filter((candidate) => accepted.has(candidate.id))
}

/**
 * Record a decision.
 *
 * Accepting is idempotent and declining is permanent-until-re-accepted: both
 * mark the id reviewed, and only acceptance adds it to `accepted`. Re-accepting
 * a previously declined id works — the card keeps showing accepted rows, so the
 * user can always change their mind.
 */
export function withDecision(
  consent: ProvisioningConsent | undefined,
  ids: readonly string[],
  accept: boolean
): ProvisioningConsent {
  const accepted = new Set(consent?.accepted ?? [])
  const reviewed = new Set(consent?.reviewed ?? [])
  for (const id of ids) {
    reviewed.add(id)
    if (accept) accepted.add(id)
    else accepted.delete(id)
  }
  return { accepted: [...accepted].sort(), reviewed: [...reviewed].sort() }
}

/**
 * The accepted set as a provisioning payload, from the stored ids alone.
 *
 * Deliberately probe-free. This runs on every worktree acquisition, and
 * re-deriving candidates there would mean listing the workspace root and — for
 * the pnpm question — spawning a process, on a path whose whole purpose is to
 * be fast. The ids carry everything the payload needs.
 *
 * Ids are still re-validated rather than trusted. They come from a persisted
 * row, and a row can be edited, synced from an older shape, or corrupted; an
 * id that does not parse is dropped instead of being handed to the native
 * provisioner as a path.
 */
export function provisioningFromConsent(
  consent: ProvisioningConsent | undefined
): WorkspaceProvisioning | undefined {
  const cacheLinks: Array<{ source: string; target: string }> = []
  const include: string[] = []
  for (const id of consent?.accepted ?? []) {
    const separator = id.indexOf(":")
    if (separator <= 0) continue
    const kind = id.slice(0, separator)
    const path = id.slice(separator + 1)
    if (!isSafeRelativePath(path)) continue
    if (kind === "cacheLink") {
      if (!cacheLinks.some((link) => link.target === path)) {
        cacheLinks.push({ source: path, target: path })
      }
    } else if (kind === "include") {
      if (!include.includes(path)) include.push(path)
    }
  }
  const payload: WorkspaceProvisioning = {
    ...(cacheLinks.length ? { cacheLinks } : {}),
    ...(include.length ? { include } : {}),
  }
  return Object.keys(payload).length ? payload : undefined
}

/** Relative, inside the workspace, and not a Windows drive or UNC path. */
function isSafeRelativePath(path: string): boolean {
  if (!path || path.startsWith("/") || path.startsWith("\\")) return false
  if (/^[A-Za-z]:/.test(path)) return false
  return path
    .split(/[\\/]/)
    .every((segment) => segment !== ".." && segment !== "." && segment.length > 0)
}

/**
 * Union of what the repository declared and what the user accepted here.
 *
 * The declaration goes first because it is the explicit statement; the local
 * set only adds. `sparsePaths` is taken from the declaration alone — narrowing
 * a checkout deletes files, and no guess of ours is allowed to do that.
 */
export function mergeProvisioning(
  declared: WorkspaceProvisioning | undefined,
  local: WorkspaceProvisioning | undefined
): WorkspaceProvisioning | undefined {
  if (!declared) return local
  if (!local) return declared
  const cacheLinks = [...(declared.cacheLinks ?? [])]
  for (const link of local.cacheLinks ?? []) {
    if (cacheLinks.some((existing) => existing.target === link.target)) continue
    cacheLinks.push(link)
  }
  const include = [...new Set([...(declared.include ?? []), ...(local.include ?? [])])]
  const merged: WorkspaceProvisioning = {
    ...(declared.sparsePaths?.length ? { sparsePaths: declared.sparsePaths } : {}),
    ...(cacheLinks.length ? { cacheLinks } : {}),
    ...(include.length ? { include } : {}),
  }
  return Object.keys(merged).length ? merged : undefined
}
