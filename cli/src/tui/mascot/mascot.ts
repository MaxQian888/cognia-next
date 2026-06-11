/**
 * Pure logic for the terminal mascot — the little creature that lives above the
 * footer and reacts to the agent's state. All the art + mood selection lives
 * here as pure data/functions so it is fully unit-tested; the {@link
 * ../components/Mascot} component is a thin animated wrapper (it owns only the
 * interval ticker, which is never asserted, mirroring the footer's spinner).
 *
 * "clawd" is the signature Cognia mascot; `cat` and `robot` are alternates the
 * user can pick with `/mascot style <name>`.
 */
import type { MascotStyle } from "../../config/schema"
import type { TurnStatus } from "../state/types"

/** Reactive moods, every one reachable from live state (see {@link selectMascotMood}). */
export const MASCOT_MOODS = ["idle", "thinking", "working", "stopping"] as const
export type MascotMood = (typeof MASCOT_MOODS)[number]

export interface MascotInputs {
  /** The current chat turn's status. */
  turnStatus: TurnStatus
  /** Whether the streaming turn has emitted reasoning so far. */
  hasThinking: boolean
  /** Whether a background runtime (goal/workflow/loop) is running. */
  activityRunning: boolean
}

/**
 * Derive the mascot's mood from the live TUI state. Ordering matters: an abort
 * wins over everything (the pet is "stopping"), then a reasoning turn reads as
 * "thinking", any other in-flight work as "working", and otherwise it rests.
 */
export function selectMascotMood({
  turnStatus,
  hasThinking,
  activityRunning,
}: MascotInputs): MascotMood {
  if (turnStatus === "aborting") return "stopping"
  if (turnStatus === "streaming") return hasThinking ? "thinking" : "working"
  if (activityRunning) return "working"
  return "idle"
}

export interface MascotView {
  /** A single line of creature art for the given tick. */
  creature: string
  /** A short playful status word (rotates by tick while animated). */
  word: string
  /** Ink color for the creature + word (shared footer palette, keyed by mood). */
  color: string
  /** Whether this mood animates — drives whether the component runs a ticker. */
  animated: boolean
}

// ── Art ───────────────────────────────────────────────────────────────────────
// One line per frame; animated moods cycle frames by tick. Kept to widely-
// supported kaomoji so it renders across terminals.

type MoodFrames = Record<MascotMood, string[]>

const ART: Record<MascotStyle, MoodFrames> = {
  clawd: {
    idle: ["ʕ-ᴥ-ʔ"],
    thinking: ["ʕ•ᴥ•ʔ", "ʕ◔ᴥ◔ʔ", "ʕ•ᴥ•ʔ", "ʕ◕ᴥ◕ʔ"],
    working: ["ʕ•ᴥ•ʔﾉ", "ʕノ•ᴥ•ʔ", "ʕ•ᴥ•ʔﾉ", "ʕノ•ᴥ•ʔ"],
    stopping: ["ʕ×ᴥ×ʔ"],
  },
  cat: {
    idle: ["(= ˘ ﻌ ˘ =)"],
    thinking: ["(= ◕ ﻌ ◕ =)", "(= ◔ ﻌ ◔ =)"],
    working: ["(=ↀωↀ=)✧", "(=ↀωↀ=) ", "(=ↀωↀ=)✦", "(=ↀωↀ=) "],
    stopping: ["(= x ﻌ x =)"],
  },
  robot: {
    idle: ["[ ◉_◉ ]"],
    thinking: ["[ ◉_◉ ]", "[ ◉~◉ ]", "[ ◔_◔ ]", "[ ◉~◉ ]"],
    working: ["{ ◉_◉ }▮▯▯", "{ ◉_◉ }▯▮▯", "{ ◉_◉ }▯▯▮", "{ ◉_◉ }▯▮▯"],
    stopping: ["[ x_x ]"],
  },
}

/** Playful gerunds, rotated by tick — the "what is it doing" word. */
const WORDS: Record<MascotMood, string[]> = {
  idle: ["zzz"],
  thinking: ["pondering", "noodling", "cogitating", "musing", "ruminating"],
  working: ["working", "brewing", "conjuring", "tinkering", "crafting", "summoning"],
  stopping: ["stopping"],
}

/** Shared footer palette, keyed by mood (matches the spinner/activity colors). */
const COLOR: Record<MascotMood, string> = {
  idle: "gray",
  thinking: "magenta",
  working: "yellow",
  stopping: "red",
}

const ANIMATED: Record<MascotMood, boolean> = {
  idle: false,
  thinking: true,
  working: true,
  stopping: false,
}

/** Non-negative modulo so a wrapped/negative tick never indexes out of range. */
function wrap(tick: number, length: number): number {
  return ((tick % length) + length) % length
}

/** Resolve the creature + word for a style/mood at a given animation tick. */
export function mascotView(style: MascotStyle, mood: MascotMood, tick: number): MascotView {
  const frames = ART[style][mood]
  const words = WORDS[mood]
  return {
    creature: frames[wrap(tick, frames.length)],
    word: words[wrap(tick, words.length)],
    color: COLOR[mood],
    animated: ANIMATED[mood],
  }
}
