/**
 * Bot control-plane types.
 *
 * The manifest-facing declaration (`PluginBotDef` and friends) lives with the
 * other plugin contribution shapes in `types/plugin/plugin-bot.ts`. What is
 * here is the runtime contract: the event a Bot reacts to, and what its
 * handler is handed.
 */

export * from "./event"
export * from "./run"
