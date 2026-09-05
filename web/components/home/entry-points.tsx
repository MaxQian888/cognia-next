"use client"

import { useInView, useReducedMotion } from "motion/react"
import { useRef, type CSSProperties } from "react"

import { Glyph, type GlyphName } from "@web/components/glyph"
import { Icon } from "@web/components/icon"
import { Reveal } from "@web/components/reveal"
import { Section, SectionHeading } from "@web/components/section"
import { DEMO_TASK } from "@web/content/demo-task"
import type {
  EntryPointFramesCopy,
  EntryPointKey,
  EntryPointsCopy,
  ReconstructionCopy,
} from "@web/content/types"
import { useHasMounted } from "@web/hooks/use-has-mounted"
import { useScriptedPhases } from "@web/hooks/use-scripted-phases"

interface EntryPointsProps {
  copy: EntryPointsCopy
  reconstruction: ReconstructionCopy
  index?: number
}

/** How long the handoff rests at each station before moving on. */
export const HANDOFF_STEP_MS = 1100

/** The terminal command that resumes the most recent session, from `cli/src/cli/args.ts`. */
export const CLI_RESUME_COMMAND = "cognia-agent chat --continue"

/** The extension's capture shortcut, from `browser-extension/wxt.config.ts`. */
export const CAPTURE_SHORTCUT = "Alt+Shift+C"

const STATION_GLYPH: Record<EntryPointKey, GlyphName> = {
  desktop: "desktop",
  mobile: "mobile",
  im: "connectors",
  cli: "cli",
  browser: "browser",
}

/**
 * "One workspace, many entry points." The homepage's second stage argument:
 * the desktop runs the task, and four other surfaces reach the same thread,
 * each holding only what its device was granted.
 *
 * The five stations sit on one rail. A marker travels the rail once, each
 * station's top rule lights as it arrives, and the station labels follow the
 * same clock through `useScriptedPhases`. Reduced motion, or a reader who
 * never scrolls here, gets every station lit and every frame complete: the
 * frames are always rendered, and only the highlight is sequenced.
 *
 * Every frame is a labelled reconstruction (ADR-0092 8) of the same demo task.
 * The values inside them come from `DEMO_TASK`, the two commands from the
 * modules that define them, so the miniature surfaces cannot drift from the
 * task the rest of the page follows.
 */
export function EntryPoints({ copy, reconstruction, index }: EntryPointsProps) {
  const reduced = useReducedMotion() ?? false
  const mounted = useHasMounted()
  const ref = useRef<HTMLDivElement>(null)
  const inView = useInView(ref, { once: true, amount: 0.3 })
  const live = mounted && !reduced && inView
  const delays = copy.stations.slice(1).map(() => HANDOFF_STEP_MS)
  const phase = useScriptedPhases({ delays, enabled: live })
  const last = copy.stations.length - 1
  const current = live ? phase : last
  const railStyle = {
    "--handoff-duration": `${HANDOFF_STEP_MS * last}ms`,
  } as CSSProperties

  return (
    <Section id="entries" tone="paper" className="paper-grain">
      <SectionHeading
        index={index}
        eyebrow={copy.eyebrow}
        title={copy.title}
        subtitle={copy.subtitle}
      />

      <Reveal className="mt-14">
        <div ref={ref} data-slot="handoff" data-phase={current} data-live={live || undefined}>
          <p className="sr-only">{copy.sequenceLabel}</p>

          {/* The rail: one rule across every station with the marker on it.
           * Decorative, the station labels and the sentence above carry it. */}
          <div aria-hidden className="relative hidden h-px bg-hairline-strong lg:block">
            {live ? (
              <span
                data-slot="handoff-marker"
                className="handoff-marker absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-action"
                style={railStyle}
              />
            ) : (
              <span className="absolute right-0 top-1/2 size-2 -translate-y-1/2 rounded-full bg-action" />
            )}
          </div>

          <ol className="grid border-y border-hairline bg-hairline gap-px lg:grid-cols-5 lg:border-t-0">
            {copy.stations.map((station, position) => {
              const active = position === current
              const reached = position <= current
              return (
                <li
                  key={station.key}
                  data-station={station.key}
                  data-reached={reached || undefined}
                  className="station-lit relative flex min-w-0 flex-col bg-paper p-6 md:p-7"
                  style={
                    {
                      "--station-delay": `${live ? position * HANDOFF_STEP_MS : 0}ms`,
                    } as CSSProperties
                  }
                >
                  <p
                    className={`flex items-center gap-2.5 font-mono text-xs uppercase tracking-widest transition-colors duration-300 ${
                      reached ? "text-ink" : "text-muted"
                    }`}
                  >
                    <Glyph name={STATION_GLYPH[station.key]} size={16} />
                    <span>{station.name}</span>
                    <span
                      aria-hidden
                      className={`ml-auto size-1.5 rounded-full transition-colors duration-300 ${
                        active ? "bg-action" : reached ? "bg-hairline-strong" : "bg-hairline"
                      }`}
                    />
                  </p>
                  <p className="mt-2 text-sm font-medium text-ink">{station.role}</p>

                  <div aria-hidden className="mt-5">
                    <StationFrame
                      station={station.key}
                      frames={copy.frames}
                      reconstruction={reconstruction}
                    />
                  </div>

                  <p className="mt-5 text-sm leading-relaxed text-muted">{station.body}</p>
                </li>
              )
            })}
          </ol>

          <div className="mt-8 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between lg:gap-12">
            <div className="min-w-0">
              <p className="font-mono text-xs uppercase tracking-widest text-muted">
                {copy.channelsLabel}
              </p>
              <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-2">
                {copy.channels.map((channel) => (
                  <li key={channel} className="flex items-center gap-2 font-mono text-xs text-ink">
                    <span aria-hidden className="size-1 rounded-full bg-hairline-strong" />
                    {channel}
                  </li>
                ))}
              </ul>
            </div>
            <p className="max-w-md font-mono text-xs leading-relaxed text-muted">
              <span className="text-ink">{reconstruction.label}.</span> {copy.note}
            </p>
          </div>
        </div>
      </Reveal>
    </Section>
  )
}

interface StationFrameProps {
  station: EntryPointKey
  frames: EntryPointFramesCopy
  reconstruction: ReconstructionCopy
}

const frame = "overflow-hidden rounded-panel border border-hairline bg-surface text-left"
const chrome =
  "flex items-center gap-2 border-b border-hairline bg-paper px-3 py-2 font-mono text-[10px] uppercase tracking-widest text-muted"
const mono = "font-mono text-[11px] leading-relaxed"

/** One miniature surface per station. Pictures of controls, so `aria-hidden` by the caller. */
function StationFrame({ station, frames, reconstruction }: StationFrameProps) {
  const { artifacts, workbench } = reconstruction
  switch (station) {
    case "desktop": {
      const running = DEMO_TASK.plan.find(
        (step) => artifacts.plan.items[step.key].state === "active"
      )
      const item = running ? artifacts.plan.items[running.key] : null
      return (
        <div className={frame}>
          <div className={chrome}>
            <span className="truncate text-ink normal-case tracking-normal">
              {DEMO_TASK.repository}
            </span>
            <span className="ml-auto truncate normal-case tracking-normal">{DEMO_TASK.branch}</span>
          </div>
          <div className="flex flex-col gap-2 px-3 py-3">
            <p className="font-mono text-[10px] uppercase tracking-widest text-muted">
              {frames.desktop.threadLabel}
            </p>
            <p className="line-clamp-2 text-xs text-ink">{workbench.userTurn}</p>
            <p className={`${mono} flex items-center gap-2 text-muted`}>
              <span className="uppercase tracking-widest">{frames.desktop.stateLabel}</span>
              <span aria-hidden className="size-1.5 rounded-full bg-action" />
              <span className="truncate text-ink">{item?.text}</span>
            </p>
          </div>
        </div>
      )
    }
    case "mobile":
      return (
        <div className="mx-auto w-40 rounded-panel border border-hairline-strong bg-surface p-1.5">
          <div className="rounded-control border border-hairline bg-paper">
            <div className={chrome}>
              <span className="flex items-center gap-1.5 text-approval">
                <Icon name="alert" size={14} />
                <span className="truncate">{frames.mobile.heading}</span>
              </span>
            </div>
            <div className="px-3 py-3">
              <p className={`${mono} text-muted`}>{artifacts.approval.actionLabel}</p>
              <p className={`${mono} text-ink`}>{DEMO_TASK.approval.command}</p>
              <p className={`${mono} mt-1.5 text-muted`}>{artifacts.approval.targetLabel}</p>
              <p className={`${mono} truncate text-ink`}>{DEMO_TASK.approval.target}</p>
              <div className="mt-3 flex gap-1.5">
                <span className="rounded-control border border-approval px-2 py-1 font-mono text-[10px] text-ink">
                  {artifacts.approval.approveLabel}
                </span>
                <span className="rounded-control border border-hairline-strong px-2 py-1 font-mono text-[10px] text-muted">
                  {artifacts.approval.denyLabel}
                </span>
              </div>
            </div>
          </div>
        </div>
      )
    case "im":
      return (
        <div className={frame}>
          <div className={chrome}>
            <span className="flex items-center gap-1.5 text-ink normal-case tracking-normal">
              <span aria-hidden className="size-1.5 rounded-full bg-success" />
              {frames.im.sender}
            </span>
            <span className="ml-auto normal-case tracking-normal">{DEMO_TASK.branch}</span>
          </div>
          <div className="px-3 py-3">
            <p className="text-xs font-medium text-ink">{frames.im.heading}</p>
            <ul className={`${mono} mt-1.5 flex flex-col text-muted`}>
              <li>
                <span className="text-ink">{DEMO_TASK.diff.filesChanged}</span>{" "}
                {frames.im.filesLabel}
                <span className="text-success"> +{DEMO_TASK.diff.added}</span>
                <span className="text-destructive"> -{DEMO_TASK.diff.removed}</span>
              </li>
              <li>
                {frames.im.notesLabel} <span className="text-ink">{DEMO_TASK.artifact.file}</span>
              </li>
            </ul>
            <p className={`${mono} mt-2 border-t border-hairline pt-2 text-muted`}>
              {frames.im.replyHint}
            </p>
          </div>
        </div>
      )
    case "cli":
      return (
        <div className="stage-scope overflow-hidden rounded-panel border border-on-stage-hairline bg-stage px-3 py-3">
          <p className={`${mono} text-muted`}># {frames.cli.comment}</p>
          <p className={`${mono} text-ink`}>
            <span className="text-action">$ </span>
            {CLI_RESUME_COMMAND}
          </p>
          <p className={`${mono} mt-1 truncate text-muted`}>
            {DEMO_TASK.repository} · {DEMO_TASK.branch}
          </p>
          <p className={`${mono} text-ink`}>
            <span className="text-action">$ </span>
            {DEMO_TASK.test.command}
          </p>
        </div>
      )
    case "browser":
      return (
        <div className={frame}>
          <div className={chrome}>
            <span className="flex gap-1">
              <span aria-hidden className="size-1.5 rounded-full bg-hairline-strong" />
              <span aria-hidden className="size-1.5 rounded-full bg-hairline-strong" />
            </span>
            <span className="ml-1 truncate normal-case tracking-normal">
              {frames.browser.heading}
            </span>
          </div>
          <div className="px-3 py-3">
            <p className="truncate text-xs text-ink">{frames.browser.pageTitle}</p>
            <div className="mt-3 flex items-center justify-between gap-2">
              <span className="rounded-control border border-hairline-strong px-2 py-1 font-mono text-[10px] text-ink">
                {frames.browser.captureLabel}
              </span>
              <span className={`${mono} text-muted`}>
                {frames.browser.shortcutLabel} <span className="text-ink">{CAPTURE_SHORTCUT}</span>
              </span>
            </div>
          </div>
        </div>
      )
  }
}
