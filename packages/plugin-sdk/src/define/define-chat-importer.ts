/**
 * Plugin SDK helper for chat-export importers (the `importers` capability,
 * §A-4).
 *
 * Where {@link defineImporter} contributes a general content importer whose
 * result the plugin handles itself, a chat importer plugs into the host's own
 * conversation-import pipeline: once registered, `detectFormat` sniffs the
 * format and the chat-import dialog offers it exactly like ChatGPT / Claude /
 * Gemini, writing real sessions through the host's merge-guarded persist path.
 *
 * Pure typesafety pass-through. Register the result at activation via
 * `ctx.import.registerChatImporter(...)`; the host namespaces the format as
 * `${pluginId}:${format}` so a plugin can never shadow a built-in.
 *
 * Usage:
 *   const slack = defineChatImporter<SlackExport>({
 *     format: "slack",
 *     label: "Slack",
 *     detect: (d): d is SlackExport =>
 *       !!d && typeof d === "object" && Array.isArray((d as SlackExport).channels),
 *     parse: async (data) =>
 *       data.channels.map((c) => ({ session: toSession(c), messages: toMessages(c) })),
 *   })
 */

import type { PluginChatImporter } from "@/types/plugin/plugin"

export function defineChatImporter<T = unknown>(
  importer: PluginChatImporter<T>
): PluginChatImporter<T> {
  return importer
}
