"use client"

/**
 * Shared UI motion tokens — re-export shim.
 *
 * The definitions moved to `@cognia/plugin-ui/motion-tokens` so that plugin UI
 * animates with the exact curves the host uses. The move had to go in this
 * direction: `packages/plugin-ui` is built standalone and may not contain a
 * single `@/` import, so it cannot reach back for the tokens — the app has to
 * be the one that points outward.
 *
 * Everything the 85 modules importing `@/lib/ui/motion` (and the `@/lib/ui`
 * barrel) rely on is re-exported verbatim, so no call site changed. Keep the
 * `"use client"` directive: the two hooks below are client-only, and a server
 * component that pulls in the tokens would otherwise fail at build time.
 */

export {
  MOBILE_EASE,
  MOBILE_DURATION,
  MOBILE_SPRING,
  STAGGER_CHILD,
  STAGGER_CONTAINER,
  STAGGER_INTERVAL,
  mobileTransition,
  useReducedMotionTransition,
  useReducedMotionVariants,
  type MobileDurationKey,
} from "@cognia/plugin-ui/motion-tokens"
