/**
 * The plugin contract's share of `lib/skills/recording/recorder-availability.ts`, which re-exports these.
 */
/**
 * Whether the recorder is available, published by the plugin that owns it.
 *
 * `cognia-skill-recorder` is the permission owner — its manifest declares the
 * three native grants — so disabling it must disable recording everywhere: the
 * Skills toolbar button, the command-palette item, `/record-skill`, and the
 * `skills.record` shortcut.
 *
 * A tiny registry rather than a direct import in each entry point, because the
 * dependency has to run the other way: entry points must not reach into plugin
 * internals, and the plugin must not know which surfaces exist. `activate`
 * publishes, `deactivate` clears, everyone else subscribes.
 *
 * Off-desktop the plugin is `runtimeCompatibility.browser: blocked`, so
 * `activate` never runs and this stays empty — which is correct, but is a
 * *different* reason from "the user turned it off". Callers distinguish the two
 * with `isTauri()` so the copy can say the right thing.
 */

export interface RecorderAvailability {
  available: boolean
  pluginId: string | null
}
