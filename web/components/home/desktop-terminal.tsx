"use client"

import { useEffect, useState } from "react"
import { useReducedMotion } from "motion/react"

import { Terminal } from "@web/components/ui/terminal"
import { DEMO_TASK, type TestLineState } from "@web/content/demo-task"
import type { TerminalCopy } from "@web/content/types"

interface DesktopTerminalProps {
  copy: TerminalCopy
}

interface TranscriptLine {
  key: string
  content: string
  state: TestLineState | "command" | "detail"
}

const stateClass: Record<TranscriptLine["state"], string> = {
  command: "text-on-stage",
  detail: "text-on-stage-muted",
  pass: "text-success",
  fail: "text-destructive",
  queued: "text-on-stage-muted",
}

const TRANSCRIPT: TranscriptLine[] = [
  { key: "approval", content: `$ ${DEMO_TASK.approval.command}`, state: "command" },
  { key: "target", content: `→ ${DEMO_TASK.approval.target}`, state: "detail" },
  { key: "test-command", content: `$ ${DEMO_TASK.test.command}`, state: "command" },
  ...DEMO_TASK.test.lines.map((line) => ({
    key: line.key,
    content: `${line.state === "pass" ? "✓" : line.state === "fail" ? "✗" : "○"} ${line.name}`,
    state: line.state,
  })),
]

/**
 * A bounded, controllable transcript of the signature task's real demo data.
 * Playback reveals one stable row at a time and stops after the final result;
 * reduced motion receives the same complete transcript immediately.
 */
export function DesktopTerminal({ copy }: DesktopTerminalProps) {
  const reduced = useReducedMotion() ?? false
  const [visibleCount, setVisibleCount] = useState(1)
  const [playRequested, setPlayRequested] = useState(true)
  const complete = reduced || visibleCount >= TRANSCRIPT.length
  const playing = playRequested && !complete

  useEffect(() => {
    if (reduced || !playing || complete) return

    const timer = window.setTimeout(() => {
      setVisibleCount((count) => Math.min(count + 1, TRANSCRIPT.length))
    }, 700)
    return () => window.clearTimeout(timer)
  }, [complete, playing, reduced, visibleCount])

  const restart = () => {
    setVisibleCount(1)
    setPlayRequested(true)
  }

  const visibleLines = reduced ? TRANSCRIPT : TRANSCRIPT.slice(0, visibleCount)

  return (
    <section className="w-full min-w-0" aria-label={copy.title}>
      <Terminal title={copy.title} sequence={false} className="max-w-none border-on-stage-hairline">
        {visibleLines.map((line) => (
          <span key={line.key} className={stateClass[line.state]}>
            {line.content}
          </span>
        ))}
      </Terminal>

      <div className="flex min-h-10 items-center gap-5 border-b border-on-stage-hairline px-4 py-3">
        {reduced ? null : (
          <>
            <button
              type="button"
              onClick={() => setPlayRequested((value) => !value)}
              disabled={complete}
              className="font-mono text-xs text-on-stage-muted transition-colors hover:text-on-stage disabled:opacity-40"
            >
              {playing ? copy.pauseLabel : copy.playLabel}
            </button>
            <button
              type="button"
              onClick={restart}
              className="font-mono text-xs text-on-stage-muted transition-colors hover:text-on-stage"
            >
              {copy.restartLabel}
            </button>
          </>
        )}
        {complete ? (
          <p aria-live="polite" className="ml-auto font-mono text-xs text-success">
            {copy.completeLabel}
          </p>
        ) : null}
      </div>
    </section>
  )
}
