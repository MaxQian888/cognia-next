// Public surface for `@/lib/ui`. Avatar helpers (deterministic colors,
// initials, glyphs) are shared across the guild rail, member list, message
// renderer, and character/team pickers; `captureScreenshot` is the
// composer's screen-capture helper. Consumers may also deep-import
// (`@/lib/ui/avatar`) — this barrel exists for discoverability.

export {
  avatarColor,
  avatarGlyph,
  deterministicColor,
  initials,
  type AvatarSubject,
} from "./avatar"
export { captureScreenshot } from "./screenshot"
export {
  MOBILE_EASE,
  MOBILE_DURATION,
  STAGGER_CHILD,
  STAGGER_CONTAINER,
  STAGGER_INTERVAL,
  mobileTransition,
  useReducedMotionTransition,
  useReducedMotionVariants,
  type MobileDurationKey,
} from "./motion"
