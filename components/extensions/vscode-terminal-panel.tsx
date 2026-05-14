"use client"

/**
 * Terminal output panel for VS Code extension terminals.
 *
 * Mounted under the `vscode.terminal.output` extension point. Subscribes
 * to `terminal-bridge.ts` events and renders a sonner-style scrollable
 * log per terminal — NO xterm.js TTY emulator. The plan explicitly carves
 * a terminal emulator out of scope: extensions like Cline only need
 * stdin/stdout RPC, which this panel provides.
 *
 * Layout:
 *   - Top: tabs for each active terminal (extensionName ► terminalName)
 *   - Middle: scrolling log of (kind, text) lines for the active tab
 *   - Bottom: input field + buttons (send / clear / kill)
 *
 * The component wires itself into the bridge through
 * `configureTerminalOutputSink` — the renderer's bootstrap calls that
 * once on mount so subsequent `appendLine` calls land in the React state.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  disposeTerminal,
  getTerminal,
  listTerminals,
  sendText,
  subscribeTerminalEvents,
  type TerminalOutputSink,
  type TerminalRecord,
} from "@/lib/plugin/vscode-shim/terminal-bridge"

export interface TerminalLine {
  kind: "stdout" | "stderr" | "system"
  text: string
  /** Wall-clock at append time, for absolute time tooltips. */
  ts: number
}

let registerSink: ((sink: TerminalOutputSink) => void) | null = null
let activeSink: TerminalOutputSink | null = null
const activeLogs: Record<string, TerminalLine[]> = {}
const sinkSubscribers = new Set<() => void>()

/**
 * Install the panel's output sink into the terminal bridge. Called from
 * the renderer's plugin bootstrap once on first mount.
 */
export function configureTerminalOutputSink(): TerminalOutputSink {
  if (activeSink) return activeSink
  const sink: TerminalOutputSink = {
    appendLine(terminalId, kind, text) {
      let arr = activeLogs[terminalId]
      if (!arr) {
        arr = []
        activeLogs[terminalId] = arr
      }
      arr.push({ kind, text, ts: Date.now() })
      // Cap each terminal log at 5000 lines; older lines drop off.
      if (arr.length > 5000) arr.splice(0, arr.length - 5000)
      notifySubscribers()
    },
    markClosed(_terminalId, _exitCode) {
      notifySubscribers()
    },
  }
  activeSink = sink
  if (registerSink) registerSink(sink)
  return sink
}

function notifySubscribers(): void {
  for (const fn of sinkSubscribers) {
    try {
      fn()
    } catch (err) {
      console.warn("vscode-terminal-panel: subscriber threw:", err)
    }
  }
}

/** Test-only — drop accumulated state so unit tests are hermetic. */
export function __resetTerminalPanelStateForTesting(): void {
  for (const k of Object.keys(activeLogs)) delete activeLogs[k]
  sinkSubscribers.clear()
  activeSink = null
  registerSink = null
}

export function VscodeTerminalPanel() {
  const terminals = useTerminals()
  // Stores the user's explicit tab selection. The actual displayed active
  // id is derived from this + the terminal list so we never need an
  // effect to "fix up" stale state after external dispose (which would
  // trigger react-hooks/set-state-in-effect).
  const [userActiveId, setUserActiveId] = useState<string | null>(null)
  const activeId = useMemo<string | null>(() => {
    if (userActiveId && terminals.some((t) => t.id === userActiveId && !t.disposed)) {
      return userActiveId
    }
    const firstLive = terminals.find((t) => !t.disposed)
    return firstLive?.id ?? null
  }, [terminals, userActiveId])
  const lines = useTerminalLines(activeId)

  // Make sure the sink is installed once.
  useEffect(() => {
    configureTerminalOutputSink()
  }, [])

  if (terminals.length === 0) {
    return (
      <div
        className="flex h-full w-full items-center justify-center text-sm text-muted-foreground"
        data-testid="vscode-terminal-panel-empty"
      >
        No active VS Code extension terminals.
      </div>
    )
  }
  return (
    <div className="flex h-full w-full flex-col" data-testid="vscode-terminal-panel">
      <TerminalTabs terminals={terminals} activeId={activeId} onSelect={setUserActiveId} />
      <TerminalLog lines={lines} />
      <TerminalComposer terminalId={activeId} />
    </div>
  )
}

function TerminalTabs({
  terminals,
  activeId,
  onSelect,
}: {
  terminals: TerminalRecord[]
  activeId: string | null
  onSelect: (id: string) => void
}) {
  return (
    <div className="flex items-center gap-1 overflow-x-auto border-b bg-muted/30 px-2 py-1">
      {terminals.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onSelect(t.id)}
          className={`shrink-0 rounded px-2 py-0.5 text-xs ${
            t.id === activeId ? "bg-background font-medium" : "text-muted-foreground"
          } ${t.disposed ? "opacity-50" : ""}`}
          data-active={t.id === activeId}
          data-disposed={t.disposed}
        >
          <span className="mr-1 text-xs text-muted-foreground">{t.extensionId}</span>
          <span>{t.name}</span>
          {t.disposed && <span className="ml-1 text-xs text-red-500">(closed)</span>}
        </button>
      ))}
    </div>
  )
}

function TerminalLog({ lines }: { lines: TerminalLine[] }) {
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [lines.length])
  return (
    <div
      ref={ref}
      className="flex-1 overflow-auto bg-background px-2 py-1 font-mono text-xs"
      data-testid="vscode-terminal-log"
    >
      {lines.map((line, idx) => (
        <div
          key={idx}
          className={
            line.kind === "stderr"
              ? "whitespace-pre-wrap text-red-500"
              : line.kind === "system"
                ? "whitespace-pre-wrap text-muted-foreground"
                : "whitespace-pre-wrap"
          }
        >
          {line.text}
        </div>
      ))}
    </div>
  )
}

function TerminalComposer({ terminalId }: { terminalId: string | null }) {
  const [draft, setDraft] = useState("")
  const send = useCallback(() => {
    if (!terminalId || draft.length === 0) return
    sendText(terminalId, draft)
    setDraft("")
  }, [terminalId, draft])
  return (
    <div className="flex items-center gap-1 border-t bg-muted/20 px-2 py-1">
      <input
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") send()
        }}
        placeholder={terminalId ? "Send to terminal…" : "No terminal selected"}
        disabled={!terminalId}
        className="flex-1 rounded border border-input bg-background px-2 py-1 text-xs"
        aria-label="Terminal input"
      />
      <button
        type="button"
        onClick={send}
        disabled={!terminalId || draft.length === 0}
        className="rounded bg-primary px-2 py-1 text-xs text-primary-foreground disabled:opacity-50"
      >
        Send
      </button>
      <button
        type="button"
        onClick={() => terminalId && disposeTerminal(terminalId)}
        disabled={!terminalId}
        className="rounded border border-destructive px-2 py-1 text-xs text-destructive disabled:opacity-50"
        aria-label="Kill terminal"
      >
        Kill
      </button>
    </div>
  )
}

function useTerminals(): TerminalRecord[] {
  const [terminals, setTerminals] = useState<TerminalRecord[]>(listTerminals())
  useEffect(() => {
    const refresh = () => setTerminals(listTerminals())
    const unsubscribe = subscribeTerminalEvents(refresh)
    sinkSubscribers.add(refresh)
    refresh()
    return () => {
      unsubscribe()
      sinkSubscribers.delete(refresh)
    }
  }, [])
  return terminals
}

function useTerminalLines(terminalId: string | null): TerminalLine[] {
  const [_tick, setTick] = useState(0)
  useEffect(() => {
    const refresh = () => setTick((t) => t + 1)
    sinkSubscribers.add(refresh)
    return () => {
      sinkSubscribers.delete(refresh)
    }
  }, [])
  return useMemo(() => {
    if (!terminalId) return []
    const t = getTerminal(terminalId)
    if (!t) return []
    return activeLogs[terminalId] ?? []
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalId, _tick])
}
