"use client"

/**
 * React glue for the composer's `!` shell intelligence.
 *
 * Everything that decides anything lives in `lib/shell-intelligence/` and is
 * pure. This hook owns only what a hook has to own: the settings and host
 * capabilities it reads, the two clocks (completion debounce, diagnostic idle),
 * the probe cache the "command not found" check consults, and the teardown that
 * stops all of it when `!` mode is left.
 *
 * The master switch is `terminal.autocomplete.enabled` — the same setting that
 * governs the integrated terminal's completion, because this is the same
 * feature on a second surface and two switches for one behaviour is a support
 * question waiting to happen. With it off the hook reports `enabled: false` and
 * every list is empty, which leaves `!` mode exactly as it was.
 *
 * Both "clocks" below are written as *derived* state rather than as a flag an
 * effect resets: `idle` is "the timer last fired for THIS line", not a boolean
 * an effect has to clear on every keystroke. Same for `submitted`. That is what
 * keeps this hook free of the cascading-render pattern, and it is also simply
 * more correct — a flag reset in an effect is briefly stale, and the thing it
 * gates here is whether to underline the user's half-typed command.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"

import { ALL_SPECS } from "@/lib/terminal/completion/spec"
import { shellBuiltins } from "@/lib/terminal/completion/shell-builtins"
import {
  ensureHostCapabilities,
  getHostCapabilities,
  subscribeHostCapabilities,
  type TerminalHostCapabilities,
} from "@/lib/terminal/host-capabilities"
import { useRuntimeSnapshot } from "@/hooks/use-runtime-snapshot"
import { isTauri } from "@/lib/platform/detect"
import { resolveOperationAvailability } from "@/lib/runtime/operation-availability"
import { resolveShellContext, type ShellContext } from "@/lib/shell-intelligence/availability"
import {
  commandNamesInLine,
  computeDiagnostics,
  isStaticallyKnownCommand,
  type CommandVerdict,
  type DiagnosticMessages,
} from "@/lib/shell-intelligence/diagnostics"
import { CompletionScheduler } from "@/lib/shell-intelligence/orchestrator"
import { describeCursor } from "@/lib/shell-intelligence/segments"
import { shellUsesBackslashEscapes } from "@/lib/terminal/completion/tokenize"
import { hostCompletionSources, type CompletionSources } from "@/lib/shell-intelligence/providers"
import {
  COMPLETION_DEBOUNCE_MS,
  DIAGNOSTIC_IDLE_MS,
  type ResolvedShell,
  type ShellAvailability,
  type ShellCompletion,
  type ShellDiagnostic,
} from "@/lib/shell-intelligence/types"
import { useSettingsStore } from "@/stores/settings"

export interface UseShellIntelligenceOptions {
  /**
   * The shell line, with the leading `!` already stripped — or null whenever
   * the composer is not in `!` mode, which tears everything down.
   */
  line: string | null
  /** Caret offset within `line`. */
  cursor: number
  /** Effective working directory, or null when the session has none. */
  cwd: string | null
  /** Translated diagnostic text. Must be referentially stable (memoise it). */
  messages: DiagnosticMessages
  /** Test seams. */
  sources?: CompletionSources
  hostReachable?: boolean
}

/**
 * Returned whenever there is nothing to offer, so the identity is stable.
 *
 * `!` mode is inactive on almost every render of a composer, and this value is
 * a dependency of the popover's `displayList` memo.
 */
const NO_COMPLETIONS: ShellCompletion[] = []

export interface ShellIntelligence {
  /** False when the master switch is off — every list below is then empty. */
  enabled: boolean
  shell: ResolvedShell
  availability: ShellAvailability
  completions: ShellCompletion[]
  /**
   * The token the list is completing — the word under the cursor, not the line.
   *
   * Surfaced because the empty state names it ("No completions for X"), and the
   * whole point of the segmentation layer is that in `cat foo | gre` the answer
   * is `gre`. Deriving it in the component would mean a second copy of the
   * shell-family escaping rule.
   */
  query: string
  diagnostics: ShellDiagnostic[]
  /** Note that the user pressed Enter — commits every command for diagnostics. */
  markSubmitted: () => void
  /** Stop the pending query and clear the list (Escape, or leaving the mode). */
  dismiss: () => void
}

/**
 * Whether this process has already asked the host to describe itself.
 *
 * `useShellContext` is mounted more than once per composer — the submit path in
 * `Composer` and the completion panel in `ComposerInner` both need the verdict —
 * so a per-mount probe kicked one request per composer on every chat surface,
 * `!` mode or not. `ensureHostCapabilities` already dedupes concurrent probes,
 * but not the effects that call it; this dedupes the effects.
 */
let capabilitiesProbeStarted = false

/**
 * Host capabilities, re-read whenever the host answers.
 *
 * Reads the module-level cache directly through `useSyncExternalStore` rather
 * than copying it into per-hook state: `getHostCapabilities()` returns a stable
 * reference, so every mount shares one subscription and one answer instead of
 * each keeping its own copy and re-rendering on its own `setState`.
 */
function useHostCapabilities(): TerminalHostCapabilities | null {
  const capabilities = useSyncExternalStore(
    subscribeHostCapabilities,
    getHostCapabilities,
    // Cold on the server, and cold on the client's first paint too — the cache
    // is only ever filled by the async probe below.
    () => null
  )
  useEffect(() => {
    if (capabilitiesProbeStarted || getHostCapabilities()) return
    capabilitiesProbeStarted = true
    void ensureHostCapabilities().then((value) => {
      // A probe that answered nothing must NOT latch. The dedupe is only about
      // the two mounts of one composer racing each other; a Host paired later
      // still has to be askable, which is what a fresh mount did before.
      if (!value) capabilitiesProbeStarted = false
    })
  }, [])
  return capabilities
}

/**
 * Just the shell verdict: which shell, and may it run?
 *
 * Split out from the full hook because the composer needs the answer in two
 * places — the completion panel and the submit path, which live in different
 * components. The submit path must not pay for a completion scheduler and an
 * idle clock it never reads, and the two must not be able to disagree about
 * which shell the line runs under.
 */
export function useShellContext(options: { hostReachable?: boolean } = {}): ShellContext {
  const settingShell = useSettingsStore((s) => s.settings?.terminal?.defaultShell)
  const capabilities = useHostCapabilities()
  const runtimeSnapshot = useRuntimeSnapshot()
  const overrideReachable = options.hostReachable
  const terminalAvailability = resolveOperationAvailability({
    snapshot: runtimeSnapshot,
    command: "terminal_exec",
  })
  const detectedReachable =
    (isTauri() && runtimeSnapshot.target?.kind !== "companion") ||
    (runtimeSnapshot.target?.kind === "companion" && terminalAvailability.state === "available")
  const reachable = overrideReachable ?? detectedReachable
  return useMemo(
    () =>
      resolveShellContext({
        settingShell,
        hostCapabilities: capabilities,
        hostReachable: reachable,
      }),
    [settingShell, capabilities, reachable]
  )
}

/** Host-probe answers, scoped to the host+shell they were asked of. */
interface ProbeCache {
  key: string
  verdicts: ReadonlyMap<string, CommandVerdict>
}

export function useShellIntelligence(options: UseShellIntelligenceOptions): ShellIntelligence {
  const { line, cursor, cwd, messages } = options
  const active = line !== null

  const autocompleteEnabled = useSettingsStore(
    (s) => s.settings?.terminal?.autocomplete?.enabled === true
  )
  const context = useShellContext({ hostReachable: options.hostReachable })
  const { shell, availability } = context
  // Only for the probe cache key below — a plain store read, not a second host
  // probe. `useShellContext` deliberately answers "which shell / may it run",
  // not "which machine".
  const runtimeSnapshot = useRuntimeSnapshot()

  const [completionResult, setCompletionResult] = useState<{
    key: string
    completions: ShellCompletion[]
  }>(() => ({ key: "", completions: NO_COMPLETIONS }))
  // "The idle timer last fired for THIS line" — not a flag an effect resets.
  const [idleLine, setIdleLine] = useState<string | null>(null)
  const [submittedLine, setSubmittedLine] = useState<string | null>(null)
  // Host-probe answers live in STATE, not a ref: the diagnostics memo reads
  // them, and reading a ref during render is exactly the staleness the React
  // compiler refuses to optimise around. The in-flight set below stays a ref
  // because only the effect ever touches it.
  const [probes, setProbes] = useState<ProbeCache>(() => ({ key: "", verdicts: new Map() }))
  const inFlightRef = useRef<Set<string>>(new Set())
  /** The host+shell the in-flight set belongs to. Only a change empties it. */
  const probeKeyRef = useRef<string | null>(null)
  /** False after teardown — the one reason to drop a landed probe result. */
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const sources = options.sources ?? hostCompletionSources
  const schedulerRef = useRef<CompletionScheduler | null>(null)
  if (schedulerRef.current === null) {
    schedulerRef.current = new CompletionScheduler({ sources })
  }

  const dismiss = useCallback(() => {
    schedulerRef.current?.cancel()
    setCompletionResult({ key: "", completions: NO_COMPLETIONS })
  }, [])

  // A different host or shell invalidates every "does this command exist"
  // answer — they were about a different machine. The runtime target id is what
  // names the machine: two paired Hosts that both run `/bin/zsh` are otherwise
  // indistinguishable here, and reusing one's verdicts on the other underlines
  // a command that exists (or clears one that does not).
  const hostId = runtimeSnapshot.target?.id ?? "local"
  const cacheKey = `${hostId}|${shell.path}|${availability}`
  const completionKey = JSON.stringify([line, cursor, cwd, shell.path, shell.kind, availability])

  // ── Completion ────────────────────────────────────────────────────────
  useEffect(() => {
    const scheduler = schedulerRef.current
    if (!scheduler) return
    if (!active || !autocompleteEnabled) {
      scheduler.cancel()
      return
    }
    scheduler.request({ line: line ?? "", cursor, cwd: cwd ?? "", shell, availability }, (result) =>
      setCompletionResult({ key: completionKey, completions: result.completions })
    )
    return () => scheduler.cancel()
  }, [active, autocompleteEnabled, line, cursor, cwd, shell, availability, completionKey])

  // ── The idle clock behind delayed diagnostics ─────────────────────────
  useEffect(() => {
    if (!active || !autocompleteEnabled) return
    const settled = line
    const timer = setTimeout(() => setIdleLine(settled), DIAGNOSTIC_IDLE_MS)
    return () => clearTimeout(timer)
  }, [active, autocompleteEnabled, line])

  // ── Resolving command names against the host ──────────────────────────
  useEffect(() => {
    if (!active || !autocompleteEnabled || !line) return
    if (availability === "static-only") return

    // A host or shell change invalidates every answer — they were about a
    // different machine — and takes the in-flight set with them.
    //
    // Keyed on the cache key CHANGING, not on "the cache has not answered
    // yet". The latter cleared the in-flight set on every keystroke during
    // exactly the window it exists to cover — before the first answer lands —
    // so the same name was re-probed once per character typed.
    if (probeKeyRef.current !== cacheKey) {
      probeKeyRef.current = cacheKey
      inFlightRef.current = new Set()
    }
    const known = probes.key === cacheKey ? probes.verdicts : null
    const inFlight = inFlightRef.current

    const builtins = shellBuiltins(shell.kind)
    const specNames = ALL_SPECS.map((spec) => spec.name)
    const unresolved = commandNamesInLine(line, shell).filter(
      (name) =>
        !known?.has(name) &&
        !inFlight.has(name) &&
        !isStaticallyKnownCommand(name, builtins, specNames)
    )
    if (unresolved.length === 0) return

    // Debounced on the same clock as the completion query, and for the same
    // reason: the head word passes through `k`, `ku`, `kub`, … on its way to
    // `kubectl`, and every prefix is a distinct name that would otherwise cost
    // its own `$PATH` walk on the host — and leave a cached "unknown" verdict
    // for a command nobody ever typed.
    const timer = setTimeout(() => {
      for (const name of unresolved) inFlight.add(name)
      void Promise.all(
        unresolved.map(async (name) => {
          try {
            const matches = await sources.listPathExecutables({ prefix: name, limit: 50 })
            const found = matches.some((m) => m.toLowerCase() === name.toLowerCase())
            return [name, found ? "known" : "unknown"] as const
          } catch {
            // A failed probe is not evidence of absence — and it is not an
            // ANSWER either. Caching `pending` would put the name in `known`,
            // where the unresolved filter skips it forever, so a host that was
            // briefly offline silently disabled the check for that command.
            // `null` is dropped below, leaving the name to be asked again.
            return [name, null] as const
          }
        })
      ).then((results) => {
        for (const name of unresolved) inFlightRef.current.delete(name)
        // Kept unless the hook is GONE. A verdict is about the host, not about
        // the line that prompted it, so discarding it because the user typed
        // another character since would throw away the answer and re-ask for
        // it on the next line that mentions the same command.
        if (!mountedRef.current) return
        // Every probe failed, so there is nothing to record. Returning without
        // touching state matters: `probes` is an effect dependency, and writing
        // an unchanged-but-new cache would re-run this effect, find the same
        // names unresolved, and probe again 80ms later — forever, while the
        // host is down. The names stay unresolved and are retried on the next
        // keystroke instead.
        if (results.every(([, verdict]) => verdict === null)) return
        setProbes((prev) => {
          const verdicts = new Map(prev.key === cacheKey ? prev.verdicts : [])
          for (const [name, verdict] of results) {
            if (verdict !== null) verdicts.set(name, verdict)
          }
          return { key: cacheKey, verdicts }
        })
      })
    }, COMPLETION_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [active, autocompleteEnabled, line, shell, availability, cacheKey, sources, probes])

  const diagnostics = useMemo(() => {
    if (!active || !autocompleteEnabled || line === null) return []
    const builtins = shellBuiltins(shell.kind)
    const specNames = ALL_SPECS.map((spec) => spec.name)
    const cache = probes.key === cacheKey ? probes.verdicts : null
    return computeDiagnostics({
      line,
      shell,
      availability,
      ...(context.reason ? { reason: context.reason } : {}),
      submitted: submittedLine === line,
      idle: idleLine === line,
      lookup: (name) => {
        if (isStaticallyKnownCommand(name, builtins, specNames)) return "known"
        // Without a Host there is nothing to ask, and "unresolved" is the honest
        // answer — better than underlining every command the static lists miss.
        if (availability === "static-only") return "pending"
        return cache?.get(name) ?? "pending"
      },
      messages,
    })
  }, [
    active,
    autocompleteEnabled,
    line,
    shell,
    availability,
    context.reason,
    cacheKey,
    submittedLine,
    idleLine,
    probes,
    messages,
  ])

  const query = useMemo(() => {
    if (line === null) return ""
    const context = describeCursor(line, Math.max(0, Math.min(cursor, line.length)), {
      backslashEscapes: shellUsesBackslashEscapes(shell.kind),
    })
    return context?.token.value ?? ""
  }, [line, cursor, shell.kind])

  const markSubmitted = useCallback(() => setSubmittedLine(line), [line])

  return {
    enabled: autocompleteEnabled,
    query,
    shell,
    availability,
    // A stable empty array, not a fresh literal. This value lands in
    // `ComposerPopover`'s `displayList` dependency list, and `!` mode is
    // inactive on every render that drives the `@` and `/` pickers — a new
    // array each time invalidated that memo on every keystroke in modes this
    // feature never touched.
    completions:
      autocompleteEnabled && active && completionResult.key === completionKey
        ? completionResult.completions
        : NO_COMPLETIONS,
    diagnostics,
    markSubmitted,
    dismiss,
  }
}
