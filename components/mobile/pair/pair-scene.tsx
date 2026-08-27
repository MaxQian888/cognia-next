"use client"

/**
 * The picture on the left of `/pair`: this client, the Host, and the state of
 * the link between them.
 *
 * # Why a scene at all
 *
 * `/pair` is the one screen where the user cannot see the thing they are
 * troubleshooting. Every failure on it — "nothing is listening", "something
 * answered but refused this browser", "the invitation is spent" — is a fact
 * about a link they have no window onto, which is why the old page could only
 * describe them in paragraphs. Drawn, the same facts are one glance: whether
 * the far end exists, whether the line reaches it, and whether a credential is
 * riding on it.
 *
 * # Shared vocabulary
 *
 * The parts come from `components/onboarding/scenes/scene-primitives` — same
 * core glyph, same hairline weight, same brand strokes, same entrance. A user
 * who just walked through first-run should recognise this as the next frame of
 * the same picture, not a different product's diagram. What differs is the
 * composition: onboarding draws one machine with chips inside it, and pairing
 * needs *two* endpoints with a line between them, so the machine frame is
 * redrawn around the core as the Host rather than around the whole canvas.
 *
 * # The colour rule, and why shape carries the state too
 *
 * `--brand-action` measures 1.69:1 on a light substrate and `--brand-approval`
 * 2.15:1 (ADR-0092 V2 §8), so neither may be the only thing distinguishing two
 * states. Every state here is therefore also a *shape*: a dashed line for an
 * open-but-unused route, a barrier bar for a refusal, a break with a cross for
 * a failure, a key badge for a credential in flight, a tick for a settled one.
 * The scene stays readable in greyscale and to a colour-blind user.
 */

import { useTranslations } from "next-intl"

import {
  CORE,
  CoreNode,
  HAIRLINE,
  SceneCanvas,
  TONE_STROKE,
  useSceneEntrance,
} from "@/components/onboarding/scenes/scene-primitives"

/**
 * What the picture is showing.
 *
 * The first four are facts about the *Host* — produced by the loopback probe
 * on web, and by the LAN scan on mobile. The last four are facts about the
 * *invitation*. They share one axis because they are mutually exclusive in
 * practice: once an invitation is in play, whether the probe found something
 * has stopped being the interesting question.
 */
export type PairSceneState =
  /** Looking for a Host; nothing has answered yet. */
  | "searching"
  /** Nothing answered. */
  | "absent"
  /** A Host answered and refused this origin — the line reaches a wall. */
  | "blocked"
  /** A Host answered and will talk to us, but no credential exists yet. */
  | "reachable"
  /** An invitation is decoded and waiting for the button. */
  | "armed"
  /** Redeeming the invitation. */
  | "pairing"
  /** Paired. */
  | "paired"
  /** The attempt failed. */
  | "failed"

/**
 * The subset of {@link PairSceneState} that is a fact about the *Host* rather
 * than about an invitation. Discovery surfaces report in this vocabulary and
 * the coordinator folds it into the full scene state.
 */
export type PairHostState = Extract<
  PairSceneState,
  "searching" | "absent" | "blocked" | "reachable"
>

export interface PairSceneProps {
  state: PairSceneState
  /** Which client to draw on the left. */
  client?: "web" | "mobile"
  className?: string
}

/** The client tile's centre. Fixed, so the eye keeps it between states. */
const CLIENT = { cx: 80, cy: CORE.y } as const
const WEB_TILE = { w: 76, h: 58 } as const
const MOBILE_TILE = { w: 46, h: 76 } as const

/** The Host's window frame, centred on the core. */
const HOST_FRAME = { x: 186, y: 74, w: 92, h: 108 } as const

/** How far short of the Host a blocked link stops. */
const BARRIER_INSET = 14

/**
 * The link is drawn slightly heavier than the hairline everything else uses.
 * It is the only mark in the scene that carries state, and at the panel's
 * rendered width a 1.25px dashed rule disappears — leaving two boxes that read
 * as unrelated rather than as two ends of one connection.
 */
const LINK_WEIGHT = 1.6

/** States in which the Host is a real, answering thing. */
const HOST_LIVE: ReadonlySet<PairSceneState> = new Set<PairSceneState>([
  "reachable",
  "armed",
  "pairing",
  "paired",
])

/** States in which a credential is riding on the link. */
const CARRIES_KEY: ReadonlySet<PairSceneState> = new Set<PairSceneState>(["armed", "pairing"])

function linkStroke(state: PairSceneState): string {
  switch (state) {
    case "paired":
    case "pairing":
    case "armed":
    case "reachable":
      return TONE_STROKE.active
    case "blocked":
      return TONE_STROKE.pending
    case "failed":
      return "var(--color-destructive)"
    default:
      return "var(--color-border)"
  }
}

export function PairScene({ state, client = "web", className }: PairSceneProps) {
  const t = useTranslations("mobile.pair.scene")
  const { enter, draw, flow, reduce } = useSceneEntrance()

  const tile = client === "web" ? WEB_TILE : MOBILE_TILE
  const tileX = CLIENT.cx - tile.w / 2
  const tileY = CLIENT.cy - tile.h / 2
  const linkStart = tileX + tile.w
  const linkEnd = HOST_FRAME.x
  const barrierX = linkEnd - BARRIER_INSET
  const midX = (linkStart + linkEnd) / 2

  const hostLive = HOST_LIVE.has(state)
  const stroke = linkStroke(state)
  // A dashed line cannot also draw itself on — the dash pattern and the draw
  // pattern are the same property — so a settled link draws once and an
  // unsettled one keeps flowing. Same trade as the onboarding connectors.
  const settled = state === "paired" || state === "failed"
  const linkMotion = settled ? draw(2) : flow()

  return (
    <SceneCanvas label={t(state)} className={className} data-testid="pair-scene">
      {/* ---- the client ---- */}
      <g {...enter(0)} data-testid="pair-scene-client" data-client={client}>
        <rect
          x={tileX}
          y={tileY}
          width={tile.w}
          height={tile.h}
          rx={client === "web" ? 10 : 12}
          fill="var(--color-background)"
          stroke="var(--color-border)"
          strokeWidth={HAIRLINE}
        />
        {client === "web" ? (
          <>
            {/* A title bar and three dots: enough to read as a browser without
                drawing a browser anybody is meant to inspect. */}
            <line
              x1={tileX}
              y1={tileY + 16}
              x2={tileX + tile.w}
              y2={tileY + 16}
              stroke="var(--color-border)"
              strokeWidth={HAIRLINE}
            />
            {[10, 18, 26].map((dx) => (
              <circle
                key={dx}
                cx={tileX + dx}
                cy={tileY + 8}
                r={2}
                fill="var(--color-border)"
              />
            ))}
          </>
        ) : (
          // The phone's speaker slot, for the same reason.
          <rect
            x={CLIENT.cx - 8}
            y={tileY + 7}
            width={16}
            height={3}
            rx={1.5}
            fill="var(--color-border)"
          />
        )}
        {/* Two content bars, so the tile is not an empty box. */}
        {[0, 1].map((row) => (
          <rect
            key={row}
            x={tileX + 10}
            y={CLIENT.cy - (client === "web" ? 2 : 6) + row * 9}
            width={row === 0 ? tile.w - 20 : Math.round((tile.w - 20) * 0.6)}
            height={3.5}
            rx={1.75}
            fill="var(--color-muted-foreground)"
            opacity={row === 0 ? 0.55 : 0.3}
          />
        ))}
      </g>

      {/* ---- the Host's frame ---- */}
      <g {...enter(1)} data-testid="pair-scene-host" data-live={hostLive}>
        <rect
          x={HOST_FRAME.x}
          y={HOST_FRAME.y}
          width={HOST_FRAME.w}
          height={HOST_FRAME.h}
          rx={14}
          fill="var(--color-background)"
          stroke={hostLive ? TONE_STROKE.active : "var(--color-border)"}
          strokeWidth={HAIRLINE}
          // Nothing answered: the far end is a hypothesis, so draw it as one.
          strokeDasharray={state === "absent" || state === "searching" ? "4 4" : undefined}
          opacity={state === "absent" ? 0.55 : 1}
        />
        <line
          x1={HOST_FRAME.x}
          y1={HOST_FRAME.y + 22}
          x2={HOST_FRAME.x + HOST_FRAME.w}
          y2={HOST_FRAME.y + 22}
          stroke="var(--color-border)"
          strokeWidth={HAIRLINE}
        />
        {[14, 24, 34].map((dx) => (
          <circle
            key={dx}
            cx={HOST_FRAME.x + dx}
            cy={HOST_FRAME.y + 11}
            r={2.5}
            fill="var(--color-border)"
          />
        ))}
      </g>

      <CoreNode active={hostLive} index={2} />

      {/* ---- the link ---- */}
      <path
        {...linkMotion}
        pathLength={settled ? 1 : undefined}
        d={`M${linkStart} ${CLIENT.cy} H${state === "blocked" ? barrierX : linkEnd}`}
        fill="none"
        stroke={stroke}
        strokeWidth={LINK_WEIGHT}
        strokeLinecap="round"
        // Solid only once the link means something settled. "Open but unused"
        // and "still looking" are both dashed — a route, not a connection.
        strokeDasharray={settled || state === "blocked" ? undefined : "3 5"}
        opacity={state === "absent" ? 0.65 : 0.9}
        data-testid="pair-scene-link"
        data-state={state}
      />

      {/* A Host answered and refused us: the line arrives and stops at a wall. */}
      {state === "blocked" && (
        <line
          {...enter(3)}
          x1={barrierX}
          y1={CLIENT.cy - 14}
          x2={barrierX}
          y2={CLIENT.cy + 14}
          stroke={TONE_STROKE.pending}
          strokeWidth={2.5}
          strokeLinecap="round"
          data-testid="pair-scene-barrier"
        />
      )}

      {/* The attempt failed: a break in the line rather than a red line, which
          on its own would be indistinguishable from a working one. */}
      {state === "failed" && (
        <g {...enter(3)} data-testid="pair-scene-break">
          <circle
            cx={midX}
            cy={CLIENT.cy}
            r={9}
            fill="var(--color-background)"
            stroke="var(--color-destructive)"
            strokeWidth={HAIRLINE}
          />
          <path
            d={`M${midX - 3.5} ${CLIENT.cy - 3.5} l7 7 M${midX + 3.5} ${CLIENT.cy - 3.5} l-7 7`}
            stroke="var(--color-destructive)"
            strokeWidth={1.75}
            strokeLinecap="round"
          />
        </g>
      )}

      {/* A credential is on the wire. Drawn as a key so "armed" and "connected"
          cannot be told apart by colour alone. */}
      {CARRIES_KEY.has(state) && (
        <g
          {...enter(3)}
          data-testid="pair-scene-key"
          className={
            state === "pairing" && !reduce ? "onboarding-breathe" : undefined
          }
        >
          <circle
            cx={midX}
            cy={CLIENT.cy}
            r={9}
            fill="var(--color-brand-wash)"
            stroke={TONE_STROKE.active}
            strokeWidth={HAIRLINE}
          />
          <circle
            cx={midX - 1.5}
            cy={CLIENT.cy}
            r={2.75}
            fill="none"
            stroke={TONE_STROKE.active}
            strokeWidth={HAIRLINE}
          />
          <path
            d={`M${midX + 1.25} ${CLIENT.cy} h4.5 m-2 0 v2.5`}
            stroke={TONE_STROKE.active}
            strokeWidth={HAIRLINE}
            strokeLinecap="round"
          />
        </g>
      )}

      {/* Settled. A tick, for the same reason the key is a key. */}
      {state === "paired" && (
        <g {...enter(3)} data-testid="pair-scene-check">
          <circle
            cx={midX}
            cy={CLIENT.cy}
            r={9}
            fill="var(--color-brand-wash)"
            stroke={TONE_STROKE.active}
            strokeWidth={HAIRLINE}
          />
          <path
            d={`M${midX - 4} ${CLIENT.cy} l3 3 l5.5 -6`}
            fill="none"
            stroke={TONE_STROKE.active}
            strokeWidth={1.75}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </g>
      )}
    </SceneCanvas>
  )
}
