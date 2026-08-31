/**
 * The one read of `AppSettings.terminal.sshHosts`.
 *
 * Every call site used to spell this path itself, and three of them spelled it
 * `settings.terminalSettings`, a key `AppSettings` has never declared. A wrong
 * path is not an error, it is an empty list: the device console and the command
 * palette listed no saved host at all, and every test that stubbed the store
 * stubbed the wrong shape alongside the code, so nothing went red.
 *
 * So the path is written once, here, in the two shapes callers actually need: a
 * selector for components subscribing to the store, and a snapshot reader for
 * the call sites outside React.
 */

import type { AppSettings } from "@cognia/agent-config-types"

import { useSettingsStore } from "@/stores/settings"

import type { SshHostProfile } from "./ssh-profiles"

/**
 * One frozen answer for "nothing saved", so a caller that needs an array rather
 * than `undefined` gets a stable reference instead of a fresh `[]` per read.
 */
const NO_SSH_HOSTS: readonly SshHostProfile[] = Object.freeze([])

/**
 * Store selector, for `useSettingsStore(selectSavedSshHosts)`.
 *
 * Returns the stored array by reference and deliberately does NOT fall back to
 * `[]`: a selector that allocates returns a new value on every store write, and
 * `useSyncExternalStore` re-renders the subscriber each time. Callers that want
 * a list apply `?? []` at the point of use, where it is memoised or harmless.
 */
export function selectSavedSshHosts(state: {
  settings: AppSettings | null
}): readonly SshHostProfile[] | undefined {
  return state.settings?.terminal?.sshHosts
}

/**
 * The saved hosts as of now, for callers that cannot subscribe.
 *
 * Empty, never a throw, before settings load: `settings` is `AppSettings |
 * null` and stays null until `load()` resolves.
 */
export function readSavedSshHosts(): readonly SshHostProfile[] {
  return selectSavedSshHosts(useSettingsStore.getState()) ?? NO_SSH_HOSTS
}
