/**
 * Where "Pair a device" leads from the device console.
 *
 * Pairing a phone is a native flow on the desktop, where Settings → Companion
 * renders the QR. Everywhere else it is a route of its own, and that route is
 * the surface contract's remedy for a standalone console, so the header
 * action, the empty-fleet card and the standalone alert cannot disagree about
 * where pairing lives. The phone shell used to spell `/pair` out by hand,
 * which is how two copies of one decision start to drift.
 */

import { isTauri } from "@/lib/platform/detect"
import { standaloneDevicesRequiresHost } from "@/lib/runtime/surface-contract"

export const DESKTOP_PAIR_HREF = "/settings?section=companion"

export function devicePairHref(): string {
  return isTauri() ? DESKTOP_PAIR_HREF : standaloneDevicesRequiresHost.remedy
}
