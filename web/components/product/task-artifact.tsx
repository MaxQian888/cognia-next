import { DiffView } from "@web/components/product/diff-view"
import { DEMO_TASK } from "@web/content/demo-task"
import type { PlanItemState, ReconstructionCopy, TaskArtifactsCopy } from "@web/content/types"

export type TaskArtifactKind = keyof TaskArtifactsCopy

interface TaskArtifactProps {
  kind: TaskArtifactKind
  copy: ReconstructionCopy
}

/* -------------------------------------------------------------------------- */
/* Shared marks and rows                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Every state carries a glyph *and* its own words (spec §8). The glyph is
 * `aria-hidden`; the words are what a screen reader and a monochrome print get.
 */
function StateMark({ glyph, className }: { glyph: string; className: string }) {
  return (
    <span aria-hidden className={`w-3 shrink-0 text-center text-xs ${className}`}>
      {glyph}
    </span>
  )
}

const PLAN_MARK: Record<PlanItemState, { glyph: string; className: string }> = {
  done: { glyph: "✓", className: "text-success" },
  active: { glyph: "◆", className: "text-action" },
  todo: { glyph: "·", className: "text-on-stage-muted" },
}

const TEST_MARK = {
  pass: { glyph: "✓", className: "text-success" },
  fail: { glyph: "✗", className: "text-destructive" },
  queued: { glyph: "·", className: "text-on-stage-muted" },
} as const

/** A `label: value` row in the mono register used for paths and identities. */
function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t border-on-stage-hairline py-2.5 first:border-t-0 first:pt-0">
      <dt className="font-mono text-[10px] uppercase tracking-widest text-on-stage-muted">
        {label}
      </dt>
      <dd className="font-mono text-xs break-all text-on-stage">{value}</dd>
    </div>
  )
}

function ArtifactHeading({ children }: { children: string }) {
  return (
    <p className="font-mono text-[10px] uppercase tracking-widest text-on-stage-muted">
      {children}
    </p>
  )
}

/* -------------------------------------------------------------------------- */
/* The six interfaces                                                          */
/* -------------------------------------------------------------------------- */

function ContextArtifact({ copy }: { copy: TaskArtifactsCopy["context"] }) {
  return (
    <div className="flex flex-col gap-6">
      <dl>
        <MetaRow label={copy.repositoryLabel} value={DEMO_TASK.repository} />
        <MetaRow label={copy.branchLabel} value={DEMO_TASK.branch} />
      </dl>

      <div>
        <ArtifactHeading>{copy.filesLabel}</ArtifactHeading>
        <ul className="mt-3 flex flex-col gap-px bg-on-stage-hairline">
          {DEMO_TASK.files.map((file) => (
            <li key={file.key} className="bg-graphite py-2.5">
              <p className="font-mono text-xs break-all text-on-stage">{file.path}</p>
              <p className="mt-1 text-sm leading-relaxed text-on-stage-muted">
                {copy.fileNotes[file.key]}
              </p>
            </li>
          ))}
        </ul>
      </div>

      <div>
        <ArtifactHeading>{copy.instructionsLabel}</ArtifactHeading>
        <ul className="mt-3 flex flex-col gap-2">
          {copy.instructions.map((line) => (
            <li key={line} className="flex gap-3 text-sm leading-relaxed text-on-stage-muted">
              <span aria-hidden className="text-on-stage-hairline">
                —
              </span>
              <span>{line}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

function PlanArtifact({ copy }: { copy: TaskArtifactsCopy["plan"] }) {
  return (
    <div>
      <ArtifactHeading>{copy.heading}</ArtifactHeading>
      <ol className="mt-4 flex flex-col">
        {DEMO_TASK.plan.map((entry) => {
          const item = copy.items[entry.key]
          const mark = PLAN_MARK[item.state]
          return (
            <li
              key={entry.key}
              className="flex items-start gap-3 border-t border-on-stage-hairline py-3 first:border-t-0 first:pt-0"
            >
              <StateMark glyph={mark.glyph} className={`mt-0.5 ${mark.className}`} />
              <div className="min-w-0 flex-1">
                <p className="text-sm leading-relaxed text-on-stage">{item.text}</p>
                <p className="mt-1.5 font-mono text-[10px] uppercase tracking-widest text-on-stage-muted">
                  {copy.stateLabels[item.state]} · {copy.toolLabel} {entry.tool}
                </p>
              </div>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

function DiffArtifact({ copy }: { copy: TaskArtifactsCopy["diff"] }) {
  const { diff } = DEMO_TASK
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-baseline gap-x-5 gap-y-2">
        <ArtifactHeading>{copy.heading}</ArtifactHeading>
        <p className="font-mono text-[10px] uppercase tracking-widest text-success">
          +{diff.added} {copy.addedLabel}
        </p>
        <p className="font-mono text-[10px] uppercase tracking-widest text-destructive">
          −{diff.removed} {copy.removedLabel}
        </p>
        <p className="font-mono text-[10px] uppercase tracking-widest text-on-stage-muted">
          {diff.filesChanged} {copy.filesChangedLabel}
        </p>
      </div>

      <DiffView
        path={diff.path}
        hunk={diff.hunk}
        lines={diff.lines}
        label={copy.heading}
        className="-mx-6 border-y border-on-stage-hairline md:mx-0 md:rounded-panel md:border"
      />

      <p className="text-sm leading-relaxed text-on-stage-muted">{copy.note}</p>
    </div>
  )
}

function ApprovalArtifact({ copy }: { copy: TaskArtifactsCopy["approval"] }) {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-2">
        <StateMark glyph="!" className="text-approval" />
        <ArtifactHeading>{copy.heading}</ArtifactHeading>
      </div>

      <dl className="rounded-panel border border-approval/40 p-4">
        <MetaRow label={copy.actionLabel} value={DEMO_TASK.approval.command} />
        <MetaRow label={copy.targetLabel} value={DEMO_TASK.approval.target} />
      </dl>

      <div>
        <ArtifactHeading>{copy.scopeLabel}</ArtifactHeading>
        <ul className="mt-3 flex flex-col gap-2">
          {copy.scope.map((line) => (
            <li key={line} className="flex gap-3 text-sm leading-relaxed text-on-stage-muted">
              <span aria-hidden className="text-approval">
                ·
              </span>
              <span>{line}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* Depicted controls, not controls. A `<button>` here would be focusable
       * and do nothing, which is a worse answer than saying plainly that the
       * real checkpoint is in the application. */}
      <div className="flex flex-wrap items-center gap-3">
        <span className="rounded-control border border-approval/60 px-3 py-1.5 font-mono text-xs text-approval">
          {copy.approveLabel}
        </span>
        <span className="rounded-control border border-on-stage-hairline px-3 py-1.5 font-mono text-xs text-on-stage-muted">
          {copy.denyLabel}
        </span>
      </div>
      <p className="font-mono text-[10px] leading-relaxed text-on-stage-muted">{copy.inertNote}</p>
    </div>
  )
}

function TestArtifact({ copy }: { copy: TaskArtifactsCopy["test"] }) {
  return (
    <div className="flex flex-col gap-5">
      <ArtifactHeading>{copy.heading}</ArtifactHeading>

      <p className="flex gap-2 font-mono text-xs break-all text-on-stage">
        <span aria-hidden className="text-action">
          $
        </span>
        <span>{DEMO_TASK.test.command}</span>
      </p>

      <ul aria-label={copy.heading} className="flex flex-col">
        {DEMO_TASK.test.lines.map((line) => {
          const mark = TEST_MARK[line.state]
          return (
            <li
              key={line.key}
              className="flex items-start gap-3 border-t border-on-stage-hairline py-2.5 first:border-t-0 first:pt-0"
            >
              <StateMark glyph={mark.glyph} className={`mt-0.5 ${mark.className}`} />
              <div className="min-w-0 flex-1">
                <p className="font-mono text-xs break-words text-on-stage">{line.name}</p>
                <p className="mt-1 font-mono text-[10px] uppercase tracking-widest text-on-stage-muted">
                  {copy.stateLabels[line.state]} · {copy.lineNotes[line.key]}
                </p>
              </div>
            </li>
          )
        })}
      </ul>

      <p className="border-t border-on-stage-hairline pt-4 text-sm leading-relaxed text-on-stage-muted">
        {copy.summary}
      </p>
    </div>
  )
}

function ArtifactArtifact({ copy }: { copy: TaskArtifactsCopy["artifact"] }) {
  return (
    <div className="flex flex-col gap-5">
      <ArtifactHeading>{copy.heading}</ArtifactHeading>

      <dl>
        <MetaRow label={copy.fileLabel} value={DEMO_TASK.artifact.file} />
        <MetaRow label={copy.versionLabel} value={DEMO_TASK.artifact.version} />
      </dl>

      <div className="flex flex-col gap-5 rounded-panel border border-on-stage-hairline p-4">
        {copy.sections.map((section) => (
          <section key={section.title}>
            <h4 className="font-mono text-[10px] uppercase tracking-widest text-on-stage">
              {section.title}
            </h4>
            <ul className="mt-2.5 flex flex-col gap-2">
              {section.items.map((item) => (
                <li key={item} className="flex gap-3 text-sm leading-relaxed text-on-stage-muted">
                  <span aria-hidden className="text-on-stage-hairline">
                    —
                  </span>
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */

/**
 * One of the signature task's six interfaces, rebuilt in DOM (ADR-0092 §8).
 *
 * These are the surfaces spec §4.2 names — repository context, plan, diff,
 * permission checkpoint, check output, artifact — and they are reconstructions
 * rather than captures on purpose: they have to be translatable, readable by a
 * screen reader, and legible at a phone width, and a bitmap is none of those.
 */
export function TaskArtifact({ kind, copy }: TaskArtifactProps) {
  const artifacts = copy.artifacts

  switch (kind) {
    case "context":
      return <ContextArtifact copy={artifacts.context} />
    case "plan":
      return <PlanArtifact copy={artifacts.plan} />
    case "diff":
      return <DiffArtifact copy={artifacts.diff} />
    case "approval":
      return <ApprovalArtifact copy={artifacts.approval} />
    case "test":
      return <TestArtifact copy={artifacts.test} />
    case "artifact":
      return <ArtifactArtifact copy={artifacts.artifact} />
  }
}
