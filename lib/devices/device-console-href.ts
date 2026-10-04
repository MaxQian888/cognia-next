/**
 * Links into the `/devices` console, built in one place.
 *
 * `?device=` was spelled inline by every caller, which was fine while a link
 * only ever selected a row. The terminal now links to a saved SSH host's Files
 * card ("Browse files" on a live SSH tab), and a link that selects the row but
 * leaves the reader at the top of a six-card dashboard is a link to the wrong
 * place. So the section travels with it, and `DeviceDetail` scrolls to it once.
 */

/** `?device=` — the row to select. Same value `useDeviceSelection` reads. */
export const DEVICE_PARAM = "device"

/** `?deviceSection=` — the card to scroll to once the row is open. */
export const DEVICE_SECTION_PARAM = "deviceSection"

export function deviceConsoleHref(ref?: string | null, section?: string | null): string {
  if (!ref) return "/devices"
  const params = new URLSearchParams({ [DEVICE_PARAM]: ref })
  if (section) params.set(DEVICE_SECTION_PARAM, section)
  return `/devices?${params.toString()}`
}
