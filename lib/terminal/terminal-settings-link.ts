/**
 * Deep links into Settings → Terminal, written once.
 *
 * Four surfaces send the user to edit an SSH host: the device console's Edit
 * button, the dock's "credential required" toast, the port-forward panel, and
 * the tab menu of a live SSH tab. Every one of them used to push the bare
 * `/settings?section=terminal`, which opened a 1300-line card scrolled to its
 * font picker, with the host the user came to fix somewhere below the fold and
 * nothing pointing at it. The section now has panels and the SSH panel can
 * open a named host, so the link carries both and is built here so no caller
 * spells the parameters itself.
 */

/** `?terminalPanel=` — which Terminal settings panel is open. */
export const TERMINAL_PANEL_PARAM = "terminalPanel"

/** `?sshHost=` — the saved SSH host the SSH panel should open and scroll to. */
export const SSH_HOST_PARAM = "sshHost"

/** `?sshHost=new` starts a new host instead of opening a saved one. */
export const NEW_SSH_HOST_LINK = "new"

/**
 * Every panel id the Terminal section knows. Owned here, not by the settings
 * component, because callers outside settings build links to them and a typo
 * in a string literal would fall back to the default panel without a sound.
 */
export const TERMINAL_PANEL_IDS = [
  "appearance",
  "shell",
  "behavior",
  "productivity",
  "ai",
  "host",
  "agents",
  "profiles",
  "ssh",
  "project",
] as const

export type TerminalPanelId = (typeof TERMINAL_PANEL_IDS)[number]

export function terminalSettingsHref(panel?: TerminalPanelId): string {
  const params = new URLSearchParams({ section: "terminal" })
  if (panel) params.set(TERMINAL_PANEL_PARAM, panel)
  return `/settings?${params.toString()}`
}

/** The SSH panel with a new, empty host open: "Add SSH host" from elsewhere. */
export function newSshHostSettingsHref(): string {
  return sshHostSettingsHref(NEW_SSH_HOST_LINK)
}

/** The SSH panel, opened on one host when `hostId` is given. */
export function sshHostSettingsHref(hostId?: string | null): string {
  const params = new URLSearchParams({ section: "terminal", [TERMINAL_PANEL_PARAM]: "ssh" })
  if (hostId) params.set(SSH_HOST_PARAM, hostId)
  return `/settings?${params.toString()}`
}
