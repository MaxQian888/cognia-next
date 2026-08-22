"use client"

/**
 * Express — the plan, and then the plan happening.
 *
 * Deliberately the same anatomy as {@link ScanScene}: the chips the scan lit
 * up are the lines this plan proposes to act on, so redrawing them somewhere
 * else would break the one thread the flow has. What changes is the tone
 * ladder — a plan line moves `idle → pending → active` as it is selected, run,
 * and finished — and that ladder is the recommended mode's only progress
 * indicator, since a stepper reading "1 of 1" would be noise.
 *
 * Deselecting a line greys it *and* dashes it, so the state survives without
 * colour. That matters more here than anywhere else in the flow: these are the
 * lines that write data to the user's machine, and "is this one going to run"
 * must not be a hue judgement.
 */

import { useTranslations } from "next-intl"

import {
  Connector,
  CoreNode,
  CountBadge,
  MachineFrame,
  SceneCanvas,
  SlotChip,
  type SceneTone,
} from "./scene-primitives"

/** Lifecycle of one plan line, as the scene needs to draw it. */
export type ExpressSceneItemState = "skipped" | "queued" | "running" | "done"

export interface ExpressSceneItem {
  id: string
  state: ExpressSceneItemState
}

export interface ExpressSceneProps {
  items: readonly ExpressSceneItem[]
  /** Rendered in the badge under the core once the run finishes. */
  doneLabel?: string
}

const TONE: Record<ExpressSceneItemState, SceneTone> = {
  skipped: "idle",
  // Armed, not inert. Drawing a selected line the same grey as a dropped one
  // made a full plan look like an empty one.
  queued: "ready",
  running: "pending",
  done: "active",
}

/** Slots the column reserves, so a two-line plan is not vertically lonely. */
const MIN_ROWS = 3

export function ExpressScene({ items, doneLabel }: ExpressSceneProps) {
  const t = useTranslations("onboarding")
  const total = Math.max(items.length, MIN_ROWS)
  const anyDone = items.some((item) => item.state === "done")

  return (
    <SceneCanvas label={t("scene.express")} data-testid="onboarding-scene-express">
      <MachineFrame />

      {items.map((item, index) => (
        <SlotChip
          // Keyed on the state as well as the id, so a line that lands remounts
          // and replays its pop instead of silently swapping colour. Paired
          // with `entranceIndex: 0` below, that pop is immediate — a chip
          // reacting to an event should not wait out a stagger meant for the
          // first paint.
          key={`${item.id}-${item.state}`}
          index={index}
          total={total}
          entranceIndex={item.state === "queued" || item.state === "skipped" ? undefined : 0}
          tone={TONE[item.state]}
          // Only a dropped line is dashed. A queued one is solid — it is going
          // to happen; it just has not yet.
          dashed={item.state === "skipped"}
          done={item.state === "done"}
          fill={0.65 + ((index * 5) % 5) / 10}
          data-testid={`onboarding-scene-item-${item.id}`}
        />
      ))}

      {/* Padding rows, so a short plan keeps the composition the scan scene
          established rather than collapsing to a stub. */}
      {Array.from({ length: Math.max(0, total - items.length) }, (_, offset) => (
        <SlotChip
          key={`pad-${offset}`}
          index={items.length + offset}
          total={total}
          tone="idle"
          dashed
          fill={0.5}
          data-testid={`onboarding-scene-item-pad-${offset}`}
        />
      ))}

      {items.map((item, index) =>
        item.state === "running" || item.state === "done" ? (
          <Connector
            key={item.id}
            index={index}
            total={total}
            tone={item.state === "done" ? "active" : "pending"}
            dashed={item.state === "running"}
            data-testid={`onboarding-scene-link-${item.id}`}
          />
        ) : null
      )}

      <CoreNode active={anyDone} index={1} />

      {doneLabel && <CountBadge value={doneLabel} data-testid="onboarding-scene-done-count" />}
    </SceneCanvas>
  )
}
