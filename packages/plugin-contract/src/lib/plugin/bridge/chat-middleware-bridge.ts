/**
 * The plugin contract's share of `lib/plugin/bridge/chat-middleware-bridge.ts`, which re-exports these.
 */

export interface RegisterChatMiddlewaresOptions {
  importer: (entry: string) => Promise<Record<string, unknown>>
}
