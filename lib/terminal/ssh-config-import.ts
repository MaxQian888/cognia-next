/**
 * One-way import of `~/.ssh/config` into saved SSH host profiles.
 *
 * Import, not sync. Nothing here writes back to the file and nothing watches
 * it: the config is read once, turned into a plan the user approves, and then
 * the profiles are theirs. A two-way binding would have to reconcile a format
 * far richer than this app's model, and would silently lose whatever it could
 * not represent on the next write.
 *
 * That richness is the reason for [`SshConfigNotice`]. OpenSSH configs are full
 * of things a host list cannot hold — `Match` blocks, `Host *` defaults,
 * `Include`, `ProxyCommand` — and quietly dropping them would leave the user
 * believing an alias was imported faithfully when its most important line was
 * discarded. Everything skipped or narrowed is named, with the line it came
 * from.
 *
 * Secrets are not imported because there are none to import: `~/.ssh/config`
 * holds key *paths*, never passphrases.
 */

import {
  nextSshHostId,
  type LocalForward,
  type RemoteForward,
  type SshHostProfile,
} from "./ssh-profiles"

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export interface ParsedForward {
  /** Present only when the config named one; always narrowed on import. */
  bindAddress?: string
  listenPort: number
  destinationHost: string
  destinationPort: number
}

export interface SshConfigHostEntry {
  /** Literal aliases from the `Host` line. Patterns are reported, not kept. */
  aliases: string[]
  hostName?: string
  user?: string
  port?: number
  identityFile?: string
  /** Raw `ProxyJump` value, resolved into hops by the planner. */
  proxyJump?: string
  localForwards: ParsedForward[]
  remoteForwards: ParsedForward[]
  /** 1-based line of the `Host` line this block opened with. */
  line: number
}

export type SshConfigNoticeKind =
  | "wildcardHost"
  | "matchBlock"
  | "include"
  | "proxyCommand"
  | "malformedForward"
  | "missingHostName"
  | "unsupportedDirective"

export interface SshConfigNotice {
  kind: SshConfigNoticeKind
  /** 1-based line in the source file. */
  line: number
  /** The alias or directive the notice is about. */
  subject: string
}

export interface SshConfigDocument {
  entries: SshConfigHostEntry[]
  notices: SshConfigNotice[]
}

/** Directives this app models. Everything else is reported, not guessed at. */
const SUPPORTED = new Set([
  "host",
  "hostname",
  "user",
  "port",
  "identityfile",
  "proxyjump",
  "localforward",
  "remoteforward",
])

/**
 * Directives that are common, harmless, and genuinely irrelevant here.
 *
 * Reporting these would bury the notices that matter under a wall of
 * `StrictHostKeyChecking` — this app's TOFU store answers that question, and
 * `Compression` has no surface to land on.
 */
const IGNORABLE = new Set([
  "addkeystoagent",
  "compression",
  "controlmaster",
  "controlpath",
  "controlpersist",
  "forwardagent",
  "forwardx11",
  "forwardx11trusted",
  "hostkeyalgorithms",
  "identitiesonly",
  "loglevel",
  "pubkeyauthentication",
  "serveralivecountmax",
  "serveraliveinterval",
  "sethostkeyalgorithmstoavoid",
  "stricthostkeychecking",
  "tcpkeepalive",
  "userknownhostsfile",
])

function isPattern(alias: string): boolean {
  return alias.includes("*") || alias.includes("?") || alias.startsWith("!")
}

function unquote(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

/** Split a config line into its keyword and the rest, honouring `key=value`. */
function splitDirective(line: string): { keyword: string; value: string } | null {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith("#")) return null
  const separator = trimmed.search(/[\s=]/)
  if (separator < 0) return { keyword: trimmed.toLowerCase(), value: "" }
  return {
    keyword: trimmed.slice(0, separator).toLowerCase(),
    value: trimmed.slice(separator + 1).trim(),
  }
}

/**
 * `host:port`, `[v6]:port`, or a bare port.
 *
 * IPv6 needs the bracket form to be unambiguous at all, so it is handled first
 * rather than left to the generic last-colon rule.
 */
function splitHostPort(token: string): { host?: string; port: number } | null {
  const bracketed = /^\[([^\]]+)\]:(\d+)$/.exec(token)
  if (bracketed) {
    return { host: bracketed[1], port: Number(bracketed[2]) }
  }
  const lastColon = token.lastIndexOf(":")
  if (lastColon < 0) {
    const port = Number(token)
    return Number.isInteger(port) && port > 0 ? { port } : null
  }
  const host = token.slice(0, lastColon)
  const port = Number(token.slice(lastColon + 1))
  if (!host || !Number.isInteger(port) || port < 1 || port > 65_535) return null
  return { host, port }
}

function parseForward(value: string): ParsedForward | null {
  const tokens = value.split(/\s+/).filter(Boolean)
  if (tokens.length !== 2) return null
  const listen = splitHostPort(tokens[0])
  const destination = splitHostPort(tokens[1])
  if (!listen || !destination?.host) return null
  if (listen.port < 1 || listen.port > 65_535) return null
  return {
    ...(listen.host ? { bindAddress: listen.host } : {}),
    listenPort: listen.port,
    destinationHost: destination.host,
    destinationPort: destination.port,
  }
}

export function parseSshConfig(text: string): SshConfigDocument {
  const entries: SshConfigHostEntry[] = []
  const notices: SshConfigNotice[] = []
  let current: SshConfigHostEntry | null = null
  // A `Match` block runs until the next `Host`/`Match`, and nothing inside it
  // can be attributed to a specific host — so its body is skipped wholesale
  // rather than leaking onto whichever alias happened to precede it.
  let inMatch = false

  text.split(/\r?\n/).forEach((raw, index) => {
    const line = index + 1
    const directive = splitDirective(raw)
    if (!directive) return
    const { keyword, value } = directive

    if (keyword === "match") {
      current = null
      inMatch = true
      notices.push({ kind: "matchBlock", line, subject: value || "Match" })
      return
    }

    if (keyword === "host") {
      inMatch = false
      const aliases = value.split(/\s+/).map(unquote).filter(Boolean)
      const literals = aliases.filter((alias) => !isPattern(alias))
      for (const pattern of aliases.filter(isPattern)) {
        notices.push({ kind: "wildcardHost", line, subject: pattern })
      }
      if (literals.length === 0) {
        current = null
        return
      }
      current = {
        aliases: literals,
        localForwards: [],
        remoteForwards: [],
        line,
      }
      entries.push(current)
      return
    }

    if (keyword === "include") {
      notices.push({ kind: "include", line, subject: value })
      return
    }

    if (inMatch || !current) {
      // A directive outside any block is an OpenSSH global default, which has
      // no single host to attach to.
      if (!inMatch && !SUPPORTED.has(keyword) && !IGNORABLE.has(keyword)) {
        notices.push({ kind: "unsupportedDirective", line, subject: keyword })
      }
      return
    }

    switch (keyword) {
      case "hostname":
        current.hostName = unquote(value)
        return
      case "user":
        current.user = unquote(value)
        return
      case "port": {
        const port = Number(unquote(value))
        if (Number.isInteger(port) && port >= 1 && port <= 65_535) current.port = port
        return
      }
      case "identityfile":
        // OpenSSH tries each `IdentityFile` in order; this app holds one, so
        // the first is kept and later ones are simply not represented.
        current.identityFile ??= unquote(value)
        return
      case "proxyjump":
        current.proxyJump = unquote(value)
        return
      case "proxycommand":
        notices.push({ kind: "proxyCommand", line, subject: current.aliases[0] })
        return
      case "localforward":
      case "remoteforward": {
        const forward = parseForward(value)
        if (!forward) {
          notices.push({ kind: "malformedForward", line, subject: value })
          return
        }
        if (keyword === "localforward") current.localForwards.push(forward)
        else current.remoteForwards.push(forward)
        return
      }
      default:
        if (!IGNORABLE.has(keyword)) {
          notices.push({ kind: "unsupportedDirective", line, subject: keyword })
        }
    }
  })

  for (const entry of entries) {
    // `Host foo` with no `HostName` means "connect to literally `foo`", which
    // only works if `foo` resolves. It usually does — that is the point of the
    // shorthand — so this is a note, not a rejection.
    if (!entry.hostName) {
      notices.push({ kind: "missingHostName", line: entry.line, subject: entry.aliases[0] })
    }
  }

  return { entries, notices }
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export type SshImportAdjustment =
  "bindNarrowedToLoopback" | "remoteForwardDisabled" | "extraAliasesDropped"

export type SshImportResolution = "create" | "overwrite" | "skip"

export interface SshImportEntry {
  /** Stable within one plan; how entries reference each other's jump hosts. */
  key: string
  /** Display name and, for a conflict, the name that already exists. */
  name: string
  host: string
  username: string
  port: number
  privateKeyPath?: string
  localForwards: LocalForward[]
  remoteForwards: RemoteForward[]
  /** Key of the entry this one jumps through, resolved to an id on apply. */
  jumpKey?: string
  /** Id of the saved profile this would replace, when one already exists. */
  existingId?: string
  /**
   * Invented to satisfy a `ProxyJump` that named a host with no `Host` block
   * of its own. Surfaced so the user is not surprised by a profile they never
   * wrote down.
   */
  synthesized: boolean
  adjustments: SshImportAdjustment[]
  /** Default the UI starts on: replace a match, otherwise create. */
  defaultResolution: SshImportResolution
}

export interface SshImportPlan {
  entries: SshImportEntry[]
  notices: SshConfigNotice[]
}

/** `user@host:port`, as `ProxyJump` and `-J` both spell it. */
function parseJumpSpec(spec: string): { user?: string; host: string; port?: number } | null {
  const at = spec.lastIndexOf("@")
  const user = at >= 0 ? spec.slice(0, at) : undefined
  const rest = at >= 0 ? spec.slice(at + 1) : spec
  if (!rest) return null
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(rest)
  if (bracketed) {
    return { user, host: bracketed[1], ...(bracketed[2] ? { port: Number(bracketed[2]) } : {}) }
  }
  const colon = rest.lastIndexOf(":")
  if (colon < 0) return { user, host: rest }
  const port = Number(rest.slice(colon + 1))
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null
  return { user, host: rest.slice(0, colon), port }
}

function toLocalForward(forward: ParsedForward, index: number): LocalForward {
  return {
    id: `lfwd-${index + 1}`,
    localPort: forward.listenPort,
    remoteHost: forward.destinationHost,
    remotePort: forward.destinationPort,
    enabled: true,
  }
}

function toRemoteForward(forward: ParsedForward, index: number): RemoteForward {
  return {
    id: `rfwd-${index + 1}`,
    remotePort: forward.listenPort,
    localHost: forward.destinationHost,
    localPort: forward.destinationPort,
    // Imported inert. The file may say this forward was in use, but turning it
    // on opens a listening socket on a remote machine, and that is a decision
    // the user makes here rather than one inherited from a file.
    enabled: false,
  }
}

function isWiderThanLoopback(bind: string | undefined): boolean {
  return bind !== undefined && bind !== "127.0.0.1" && bind !== "localhost" && bind !== "::1"
}

function adjustmentsFor(entry: SshConfigHostEntry): SshImportAdjustment[] {
  const adjustments: SshImportAdjustment[] = []
  const widened = [...entry.localForwards, ...entry.remoteForwards].some((forward) =>
    isWiderThanLoopback(forward.bindAddress)
  )
  if (widened) adjustments.push("bindNarrowedToLoopback")
  if (entry.remoteForwards.length > 0) adjustments.push("remoteForwardDisabled")
  if (entry.aliases.length > 1) adjustments.push("extraAliasesDropped")
  return adjustments
}

/**
 * Turn a parsed config into the set of profiles an import would produce.
 *
 * Nothing is written here. The plan is what the preview renders and what the
 * user resolves conflicts against; [`applySshConfigImport`] consumes it.
 */
export function planSshConfigImport(
  document: SshConfigDocument,
  existing: readonly SshHostProfile[]
): SshImportPlan {
  const notices = [...document.notices]
  const entries: SshImportEntry[] = []
  const byAlias = new Map<string, SshImportEntry>()

  const findExisting = (name: string): SshHostProfile | undefined =>
    existing.find((profile) => profile.name === name)

  for (const parsed of document.entries) {
    const name = parsed.aliases[0]
    const match = findExisting(name)
    const entry: SshImportEntry = {
      key: `alias:${name}`,
      name,
      // A `Host` block with no `HostName` connects to the alias itself.
      host: parsed.hostName ?? name,
      username: parsed.user ?? "",
      port: parsed.port ?? 22,
      ...(parsed.identityFile ? { privateKeyPath: parsed.identityFile } : {}),
      localForwards: parsed.localForwards.map(toLocalForward),
      remoteForwards: parsed.remoteForwards.map(toRemoteForward),
      ...(match ? { existingId: match.id } : {}),
      synthesized: false,
      adjustments: adjustmentsFor(parsed),
      defaultResolution: match ? "overwrite" : "create",
    }
    entries.push(entry)
    for (const alias of parsed.aliases) byAlias.set(alias, entry)
  }

  // Second pass: `ProxyJump` can name an alias defined further down the file,
  // so the chain is only resolvable once every block has been seen.
  for (const [index, parsed] of document.entries.entries()) {
    const jump = parsed.proxyJump?.trim()
    if (!jump || jump.toLowerCase() === "none") continue
    const hops = jump
      .split(",")
      .map((hop) => hop.trim())
      .filter(Boolean)
    // OpenSSH orders `ProxyJump a,b` outermost-first, and each hop is reached
    // through the one before it — the same chain this app stores as a linked
    // list of `jumpHostId`s.
    let previousKey: string | undefined
    for (const hop of hops) {
      const known = byAlias.get(hop)
      if (known) {
        // An alias that already carries its own `ProxyJump` keeps it; the file
        // has said the same thing twice and the block's own line wins.
        if (!known.jumpKey && previousKey && previousKey !== known.key) {
          known.jumpKey = previousKey
        }
        previousKey = known.key
        continue
      }
      const spec = parseJumpSpec(hop)
      if (!spec) {
        notices.push({ kind: "malformedForward", line: parsed.line, subject: hop })
        previousKey = undefined
        continue
      }
      const key = `jump:${hop}`
      let synthesized = entries.find((candidate) => candidate.key === key)
      if (!synthesized) {
        const match = findExisting(spec.host)
        synthesized = {
          key,
          name: spec.host,
          host: spec.host,
          username: spec.user ?? "",
          port: spec.port ?? 22,
          localForwards: [],
          remoteForwards: [],
          ...(match ? { existingId: match.id } : {}),
          synthesized: true,
          adjustments: [],
          defaultResolution: match ? "skip" : "create",
        }
        if (previousKey) synthesized.jumpKey = previousKey
        entries.push(synthesized)
      }
      previousKey = synthesized.key
    }
    if (previousKey) entries[index].jumpKey = previousKey
  }

  return { entries, notices }
}

// ---------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------

export interface SshImportResult {
  profiles: SshHostProfile[]
  created: number
  replaced: number
  /**
   * Entries whose jump host was not imported, so they connect direct.
   *
   * Reported rather than silently dropped: connecting direct reaches a
   * different machine than the user's config described.
   */
  droppedJumps: string[]
}

/**
 * Merge an approved plan into the saved host list.
 *
 * Pure: it returns the next list rather than persisting, so the caller owns the
 * single `save` and the terminal-host profile sync that follows it.
 */
export function applySshConfigImport(
  existing: readonly SshHostProfile[],
  plan: SshImportPlan,
  resolutions: Readonly<Record<string, SshImportResolution>>
): SshImportResult {
  const resolutionFor = (entry: SshImportEntry): SshImportResolution =>
    resolutions[entry.key] ?? entry.defaultResolution

  // Ids first, so a jump reference can point at a profile created later in the
  // same pass.
  const idByKey = new Map<string, string>()
  let allocated: SshHostProfile[] = [...existing]
  for (const entry of plan.entries) {
    const resolution = resolutionFor(entry)
    if (resolution === "overwrite" && entry.existingId) {
      idByKey.set(entry.key, entry.existingId)
      continue
    }
    if (resolution === "skip") {
      // A skipped entry that matches a saved profile is still a usable jump
      // target — the user declined to change it, not to reference it.
      if (entry.existingId) idByKey.set(entry.key, entry.existingId)
      continue
    }
    const id = nextSshHostId(allocated)
    idByKey.set(entry.key, id)
    allocated = [...allocated, { ...blankProfile(id) }]
  }

  const droppedJumps: string[] = []
  const next = new Map(existing.map((profile) => [profile.id, profile]))
  let created = 0
  let replaced = 0

  for (const entry of plan.entries) {
    const resolution = resolutionFor(entry)
    if (resolution === "skip") continue
    const id = idByKey.get(entry.key)
    if (!id) continue

    let jumpHostId: string | null = null
    if (entry.jumpKey) {
      jumpHostId = idByKey.get(entry.jumpKey) ?? null
      if (!jumpHostId) droppedJumps.push(entry.name)
    }

    const previous = next.get(id)
    const profile: SshHostProfile = {
      id,
      name: entry.name,
      host: entry.host,
      username: entry.username,
      port: entry.port,
      // A key path means key auth; anything else needs a secret this file
      // never held, so it defaults to a password the user supplies later.
      authMethod: entry.privateKeyPath ? "privateKey" : "password",
      ...(entry.privateKeyPath ? { privateKeyPath: entry.privateKeyPath } : {}),
      // The keyring reference belongs to whatever was saved under this id
      // before; the config file has nothing to say about it.
      ...(previous?.credentialRef ? { credentialRef: previous.credentialRef } : {}),
      jumpHostId,
      localForwards: entry.localForwards,
      remoteForwards: entry.remoteForwards,
    }
    if (previous) replaced += 1
    else created += 1
    next.set(id, profile)
  }

  return { profiles: [...next.values()], created, replaced, droppedJumps }
}

/** Placeholder used only to reserve an id while the plan is being laid out. */
function blankProfile(id: string): SshHostProfile {
  return { id, name: id, host: "", port: 22, username: "", authMethod: "password" }
}

// ---------------------------------------------------------------------------
// Reading the file
// ---------------------------------------------------------------------------

export interface ReadSshConfigDeps {
  home: () => Promise<string | null>
  exists: (path: string) => Promise<boolean>
  readTextFile: (path: string) => Promise<string>
}

async function defaultDeps(): Promise<ReadSshConfigDeps> {
  const [{ resolveHome }, files] = await Promise.all([
    import("@/lib/memory/external/home"),
    import("@/lib/file/file-operations"),
  ])
  return { home: resolveHome, exists: files.exists, readTextFile: files.readTextFile }
}

export type SshConfigSource =
  { kind: "found"; path: string; text: string } | { kind: "absent"; path: string | null }

/**
 * Read `~/.ssh/config` if it is there.
 *
 * A missing file is the common case on a fresh machine and is not an error;
 * only an unreadable one throws, because that is something the user can act on.
 */
export async function readSshConfigFile(deps?: ReadSshConfigDeps): Promise<SshConfigSource> {
  const resolved = deps ?? (await defaultDeps())
  const home = await resolved.home()
  if (!home) return { kind: "absent", path: null }
  const path = `${home.replace(/[/\\]+$/, "")}/.ssh/config`
  if (!(await resolved.exists(path))) return { kind: "absent", path }
  return { kind: "found", path, text: await resolved.readTextFile(path) }
}
