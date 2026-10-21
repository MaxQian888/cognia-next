/**
 * The plugin contract's share of `lib/plugin/api/chat-api.ts`, which re-exports these.
 */
import type { ChatMiddleware } from "../../../types/plugin/plugin-chat-middleware"
import type { PluginLinkMatcherRegistrationDef } from "../../../types/plugin/plugin-link-matcher"

/**
 * What a plugin stages as chat context.
 *
 * `kind` and `pluginId` are absent on purpose: the host stamps both, so a
 * plugin cannot stage a selection attributed to another plugin or forge one of
 * the host's own kinds.
 */
export interface PluginChatSelectionInput {
  /** Chip label and prompt heading subject. */
  title: string
  /** The text itself — what the assistant actually sees. */
  snapshot: string
  /** The user's note on it, if the plugin collected one. */
  comment?: string
  /** What the plugin calls this thing, e.g. `"wiki page"`. English. */
  sourceLabel: string
  /** The plugin's own address for the selection, echoed back on jump-to-source. */
  ref?: string
  /** Workspace lines the excerpt came from. */
  citations?: Array<{ path: string; startLine?: number; endLine?: number }>
}

export interface PluginComposerIntentOptions {
  /** Composer to address. Defaults to the active session. */
  sessionId?: string
  /**
   * Send immediately instead of leaving the text for the user to edit.
   *
   * Opt-in, and it stays opt-in: a plugin that stages a prompt is suggesting a
   * turn, and turning that into "the app just messaged the model on your
   * behalf" is a different act the author has to ask for.
   */
  autoSend?: boolean
}

export interface PluginChatAPI {
  /** Replace matching inline chat links. Requires extension:ui; auto-disposed on disable. */
  registerLinkMatcher(def: PluginLinkMatcherRegistrationDef): () => void

  /**
   * Register a middleware. Returns a disposer the plugin can call to
   * unregister explicitly (the host also unregisters automatically on
   * plugin disable). The optional `id` argument lets the plugin pin a
   * stable id for telemetry and the circuit-breaker key — when omitted a
   * random id is generated.
   */
  use(
    fn: ChatMiddleware,
    options?: { id?: string; priority?: number; timeoutMs?: number }
  ): () => void

  /**
   * Stage a selection as context for the user's next message.
   *
   * The composer already renders one chip per staged ref, folds them into the
   * outgoing prompt and clears them after send — this puts a plugin's own
   * surfaces on that same pipeline instead of asking every plugin to paste
   * text into the composer and hope the formatting survives.
   *
   * Requires `session:write`.
   */
  addContextSelection(selection: PluginChatSelectionInput): void

  /**
   * Append text to a composer's draft, leaving the caret after it.
   *
   * Additive, never destructive: whatever the user had typed stays. Requires
   * `session:write`.
   */
  appendToComposer(text: string, options?: { sessionId?: string }): void

  /**
   * Stage a prompt for a composer to pick up, optionally sending it.
   *
   * Returns the candidate id the composer consumes, so a plugin that stages
   * twice can tell which one was taken. Requires `session:write`.
   */
  stageIntent(prompt: string, options?: PluginComposerIntentOptions): string

  /**
   * Append a system message carrying a custom part into a transcript.
   *
   * This is the other half of `defineMessageRenderer`. A plugin can register a
   * renderer for a part type it invents, but until now nothing could put a
   * message carrying that part into the conversation — so the renderer only
   * ever drew if the HOST happened to emit the part, which for a
   * plugin-invented type it never does. The OCR plugin worked around it by
   * writing to the chat store directly.
   *
   * The part is passed through untouched; the host owns only the envelope
   * (id, `system` role, ordering). Returns the message id, or `null` when
   * there is no session to append to. Requires `session:write`.
   */
  appendMessagePart(part: unknown, options?: { sessionId?: string }): string | null
}
