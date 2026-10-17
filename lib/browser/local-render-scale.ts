/**
 * The pixel density Cognia's own Chromium renders at (ADR-0201).
 *
 * The pane streams Chromium's screencast, which captures the compositor
 * surface — and headless Chromium's surface density is fixed at launch
 * (`--force-device-scale-factor`). Emulating a device scale factor over CDP
 * only changes what the page reports as `devicePixelRatio`; the captured
 * frames stay at the launch density. So the session is launched at the
 * densest display the window can be on, not just the one it is on now:
 * dragging the window to a Retina screen must not leave the page blurry, and
 * relaunching Chromium then would lose every tab's state.
 *
 * Bounded at 1–4, the runtime's accepted range. A display plugged in later
 * that is denser than every display at launch renders at the launch density
 * until the shared session next starts (it closes when idle); the page still
 * reports the right `devicePixelRatio`.
 */

import { availableMonitors } from "@tauri-apps/api/window"

export const MIN_RENDER_SCALE = 1
export const MAX_RENDER_SCALE = 4

/** Every connected display's scale factor. */
export type ListDisplayScales = () => Promise<number[]>

const listMonitorScales: ListDisplayScales = async () =>
  (await availableMonitors()).map((monitor) => monitor.scaleFactor)

export async function resolveLocalRenderScale(
  listScales: ListDisplayScales = listMonitorScales
): Promise<number> {
  const scales = [typeof window === "undefined" ? 1 : window.devicePixelRatio]
  try {
    scales.push(...(await listScales()))
  } catch {
    // No display list (a host without the window API): the current density.
  }
  const valid = scales.filter((scale) => Number.isFinite(scale) && scale > 0)
  return Math.min(MAX_RENDER_SCALE, Math.max(MIN_RENDER_SCALE, ...valid))
}
