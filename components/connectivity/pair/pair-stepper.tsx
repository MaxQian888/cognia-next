"use client"

import { useTranslations } from "next-intl"

import { GuideStepper } from "@/components/guide/guide-stepper"

export type PairStep = "discover" | "pair" | "paired"

const ORDER: readonly PairStep[] = ["discover", "pair", "paired"] as const

export interface PairStepperProps {
  current: PairStep
  /** Subset of steps to render (defaults to all three). The web pair flow
   *  has no LAN discovery step, so it passes `["pair", "paired"]`. */
  steps?: readonly PairStep[]
  className?: string
}

/**
 * Where you are in pairing — the shared `GuideStepper`, the same row the
 * first-run flow draws (ADR-0193), fed with the pairing steps.
 *
 * Read-only: pairing moves forward on its own (a scan, a registration), and
 * the step bodies own their Back.
 */
export function PairStepper({ current, steps = ORDER, className }: PairStepperProps) {
  const t = useTranslations("mobile.pair.step")
  return (
    <GuideStepper
      items={steps.map((step) => ({ id: step, label: t(step) }))}
      current={current}
      ariaLabel={t("ariaLabel")}
      testId="pair-stepper"
      itemTestIdPrefix="pair-stepper-item"
      className={className}
    />
  )
}
