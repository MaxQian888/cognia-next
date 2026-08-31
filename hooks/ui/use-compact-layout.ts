"use client"

import { useIsMobile } from "./use-mobile"

/**
 * Should this surface render its **compact (phone-shaped) layout**?
 *
 * True when the viewport is below `md` **or** the shell is a native Capacitor
 * app. Identical arithmetic to {@link useIsMobile}. What differs is the
 * question it answers, and that distinction is the whole point of the module.
 *
 * The repo had exactly one predicate for two different questions and picked
 * the wrong one about a dozen times:
 *
 *  - **"Am I laid out narrow?"** is a *presentation* question. A 375px-wide
 *    browser window is narrow whether or not Capacitor is present, so the
 *    answer must include the viewport. Routes that asked
 *    `usePlatform() === "mobile"` here handed a 375px browser the full desktop
 *    three-pane workspace, with `GuildRail` hidden below `md` and therefore no
 *    navigation at all.
 *  - **"Am I a native mobile runtime?"** is a *capability* question: safe-area
 *    insets, the keyboard reserve, the consent sheet, the launch redirect,
 *    Capacitor plugins. Those must stay on `usePlatform() === "mobile"`. A
 *    narrow desktop window has no notch, no soft keyboard and no native
 *    consent surface, and mounting them there is a behaviour change rather
 *    than a layout change.
 *
 * So: use this hook for anything that only decides *what a surface looks
 * like*, and `usePlatform()` for anything that touches the native shell.
 *
 * A named alias rather than a bare re-export, so the call site states its
 * intent and so the two audiences can diverge later (a tablet tier, say)
 * without another sweep.
 */
export function useCompactLayout(): boolean {
  return useIsMobile()
}
