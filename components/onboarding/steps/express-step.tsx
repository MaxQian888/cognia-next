"use client"

import {
  ArrowRightIcon,
  CheckIcon,
  DownloadIcon,
  KeyRoundIcon,
  MessagesSquareIcon,
  MonitorSmartphoneIcon,
  SparklesIcon,
  TerminalIcon,
  type LucideIcon,
} from "lucide-react"
import type { ReactNode } from "react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Spinner } from "@/components/ui/spinner"
import { StepHeading } from "../step-shell"
import { cn } from "@/lib/utils"
import {
  isPlanRunnable,
  type ExpressItemKind,
  type ExpressPlanItem,
} from "@/lib/onboarding/express-plan"

/** How far one plan line has got. Mirrors the scene's tone ladder. */
export type ExpressItemStatus = "queued" | "running" | "done" | "failed"

/** Which half of the recommended step is showing. */
export type ExpressPhase = "plan" | "applying" | "ready"

const KIND_ICONS: Record<ExpressItemKind, LucideIcon> = {
  "migrate-config": DownloadIcon,
  "import-history": MessagesSquareIcon,
  "use-runtime": TerminalIcon,
  "sign-in": KeyRoundIcon,
  pair: MonitorSmartphoneIcon,
  capabilities: SparklesIcon,
}

export interface ExpressStepProps {
  items: readonly ExpressPlanItem[]
  phase: ExpressPhase
  /** Per-line progress while `phase === "applying"`. Keyed by item id. */
  status?: Readonly<Record<string, ExpressItemStatus>>
  /**
   * Live model access — including a credential added by the inline sign-in
   * block on this very screen. `false` blocks the apply button.
   */
  modelAccess: boolean | null
  /** Companion pairing state, consulted only when the plan has a `pair` line. */
  paired?: boolean | null
  /**
   * Ids the user has unchecked. Owned by the flow rather than here, because
   * the narrative panel's scene draws the same selection — keeping it local
   * would mean the picture claiming a line will run after the user dropped it.
   */
  dropped: ReadonlySet<string>
  onToggle: (id: string) => void
  /** Runs the plan against the current selection. */
  onApply: () => void | Promise<void>
  /**
   * The inline minimal sign-in (or pairing) surface, supplied by the flow
   * because it mounts the production `AddAccountDialog`s. Rendered under
   * whichever of the two interactive lines the plan carries.
   */
  signIn?: ReactNode
  /** The terminal step, rendered in place once the plan has been applied. */
  children?: ReactNode
}

/**
 * The recommended path — one screen that says what setup is about to do, does
 * it, and hands over the first task.
 *
 * ## Why one screen and not four
 *
 * The step-by-step path asks four questions in sequence, and on a machine that
 * already has Claude Code installed and signed in, the honest answer to three
 * of them is "yes, obviously". This screen answers them up front and shows its
 * working: every line is derived from a real probe (see `buildExpressPlan`),
 * every line that writes anything can be unchecked, and nothing runs until the
 * user presses one button.
 *
 * ## Three phases, no navigation
 *
 * `plan → applying → ready`. The transitions are in place — the heading and
 * the list stay put while the lines tick over, and the terminal step renders
 * *into* the same screen rather than replacing it. That is what makes this two
 * screens end to end (intro, then this) rather than four, and it is also why
 * the starter cards keep their existing test ids: they are the same component,
 * just hosted here.
 *
 * ## What it does not decide
 *
 * Nothing this screen shows is a second opinion. The migration lines come from
 * `probeVendors()`, the transcript count from the ADR-0062 source walk, the
 * capability list from `resolveCapabilities`, and the sign-in block writes
 * through the same three pointers the step-by-step path writes. If this screen
 * and the sign-in step ever disagreed about what "configured" means, this one
 * would be wrong.
 */
export function ExpressStep({
  items,
  phase,
  status = {},
  modelAccess,
  paired,
  dropped,
  onToggle,
  onApply,
  signIn,
  children,
}: ExpressStepProps) {
  const t = useTranslations("onboarding")
  const runnable = isPlanRunnable({ items, modelAccess, paired })
  const blockedReason = items.some((item) => item.kind === "pair")
    ? "pair"
    : items.some((item) => item.kind === "sign-in")
      ? "sign-in"
      : null

  if (phase === "ready") {
    return (
      <div className="flex flex-col gap-6" data-testid="onboarding-express-ready">
        {children}
      </div>
    )
  }

  const applying = phase === "applying"

  return (
    <div className="flex flex-col gap-6" data-testid="onboarding-express">
      <StepHeading
        title={applying ? t("express.applyingTitle") : planTitle(t, items)}
        description={applying ? t("express.applyingDescription") : planDescription(t, items)}
      />

      <ul className="flex flex-col gap-2" data-testid="onboarding-express-list">
        {items.map((item) => {
          const Icon = KIND_ICONS[item.kind]
          const state = status[item.id]
          const isDropped = !item.required && dropped.has(item.id)
          return (
            <li key={item.id}>
              <div
                className={cn(
                  "flex items-start gap-3 rounded-xl border bg-card px-4 py-3 transition-colors",
                  isDropped && "opacity-55",
                  state === "done" && "border-brand-action/45",
                  state === "running" && "border-brand-approval/50"
                )}
                data-testid={`onboarding-express-item-${item.id}`}
                data-dropped={isDropped}
                data-status={state ?? "queued"}
              >
                {item.required || applying ? (
                  <StatusMark state={state} Icon={Icon} />
                ) : (
                  <Checkbox
                    id={`express-${item.id}`}
                    checked={!isDropped}
                    onCheckedChange={() => onToggle(item.id)}
                    disabled={applying}
                    className="mt-0.5"
                    data-testid={`onboarding-express-toggle-${item.id}`}
                  />
                )}

                <label
                  htmlFor={item.required || applying ? undefined : `express-${item.id}`}
                  className={cn(
                    "flex min-w-0 flex-1 flex-col gap-0.5",
                    !item.required && !applying && "cursor-pointer"
                  )}
                >
                  <span className="flex items-center gap-2 text-sm font-medium">
                    {!item.required && !applying && (
                      <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                    )}
                    {itemTitle(t, item)}
                  </span>
                  <span className="text-xs leading-relaxed text-muted-foreground">
                    {itemDescription(t, item)}
                  </span>
                </label>
              </div>

              {/* The one line that cannot be automated: OAuth, a device code
                  and a pasted key all need the user. It sits under its own
                  plan line rather than on a screen of its own, so the
                  recommended path stays one screen even on a fresh machine. */}
              {(item.kind === "sign-in" || item.kind === "pair") && signIn && !applying && (
                <div className="mt-2 ml-3 border-l-2 border-brand-action/30 pl-4">{signIn}</div>
              )}
            </li>
          )
        })}
      </ul>

      {!applying && (
        <div className="flex flex-col gap-2">
          <Button
            size="lg"
            className="self-start"
            disabled={!runnable}
            onClick={() => void onApply()}
            data-testid="onboarding-express-apply"
          >
            {t("express.apply")}
            <ArrowRightIcon className="size-4" />
          </Button>
          {blockedReason && !runnable && (
            <p className="text-xs text-muted-foreground" data-testid="onboarding-express-blocked">
              {blockedReason === "pair" ? t("express.needsPairing") : t("express.needsModel")}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

/** The per-line marker while the plan runs, and the icon before it starts. */
function StatusMark({ state, Icon }: { state?: ExpressItemStatus; Icon: LucideIcon }) {
  if (state === "running") {
    return <Spinner className="mt-0.5 size-4 shrink-0 text-brand-approval" />
  }
  if (state === "done") {
    return (
      <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-brand-action/20">
        <CheckIcon className="size-3 text-foreground" aria-hidden />
      </span>
    )
  }
  return <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
}

type Translate = ReturnType<typeof useTranslations<"onboarding">>

/**
 * The heading and its subtitle both change with what was found, because "here
 * is what we will bring over — uncheck anything you would rather skip" is two
 * lies on a machine with nothing to bring and nothing uncheckable.
 */
function hasImportableWork(items: readonly ExpressPlanItem[]): boolean {
  return items.some((item) => item.kind === "migrate-config" || item.kind === "import-history")
}

function planTitle(t: Translate, items: readonly ExpressPlanItem[]): string {
  return hasImportableWork(items) ? t("express.title") : t("express.freshTitle")
}

function planDescription(t: Translate, items: readonly ExpressPlanItem[]): string {
  return hasImportableWork(items) ? t("express.description") : t("express.freshDescription")
}

function itemTitle(t: Translate, item: ExpressPlanItem): string {
  switch (item.kind) {
    case "migrate-config":
      return t("express.item.migrate.title", { vendor: item.label ?? item.vendor ?? "" })
    case "import-history":
      return t("express.item.history.title", { count: item.count ?? 0 })
    case "use-runtime":
      return t("express.item.runtime.title", { runtime: item.label ?? "" })
    case "sign-in":
      return t("express.item.signIn.title")
    case "pair":
      return t("express.item.pair.title")
    case "capabilities":
      return t("express.item.capabilities.title")
  }
}

function itemDescription(t: Translate, item: ExpressPlanItem): string {
  switch (item.kind) {
    case "migrate-config":
      return t("express.item.migrate.description")
    case "import-history":
      return t("express.item.history.description")
    case "use-runtime":
      return t("express.item.runtime.description")
    case "sign-in":
      return t("express.item.signIn.description")
    case "pair":
      return t("express.item.pair.description")
    case "capabilities":
      // Named rather than counted: "3 capabilities" is a number the user
      // cannot check, and the whole point of the terminal step is that they can.
      return (item.capabilities ?? []).map((cap) => t(`express.capability.${cap}`)).join(" · ")
  }
}
