/**
 * The model-written title a HostState conversation gets after its first turn.
 *
 * A conversation driven through HostState (a paired browser's, or an org
 * member's on their person partition) is run by the Host, not by the device
 * that typed it, so the device's own turn-complete title upgrade
 * (`runUtilityModelTasks`) never runs for it: it kept the first message's
 * 40-character preview for good. The Host now asks the same title pipeline
 * once the first turn completes, and names the conversation in its channel
 * (`host-state-service.ts`), so every device and the sidebar agree.
 *
 * Which model titles it:
 *  * an owner's Host: the utility model its own settings resolve, exactly as
 *    the desktop titles its own chats;
 *  * a person partition: the org's model the conversation runs on, through a
 *    Host ticket minted for the conversation, so the call is charged to the
 *    member's monthly usage like their turns. The partition holds no provider
 *    key of its own.
 *
 * Everything else (the feature switch, the PII gate, smoothing, in-flight
 * dedup) is {@link runTitleTask}'s, unchanged.
 */

import type { AppSettings, ChatSession } from "@cognia/agent-config-types"
import type { UIMessage } from "ai"
import { extractAssistantText, extractPlainText } from "@/lib/chat/message-text"
import {
  isInstantPreviewTitle,
  isTitleInFlight,
  runTitleTask,
} from "@/lib/ai/generation/run-title-task"
import { isPlaceholderTitle } from "@/lib/chat/placeholder-title"
import { getDb } from "@/lib/db"
import { getSettings } from "@/lib/db/settings"
import { personChatCapability } from "@/lib/headless/person-chat"
import type { LlmClient } from "@/lib/twin/distill/llm"

export interface HostStateTitleRequest {
  session: ChatSession
  /** The first user message's text. */
  sourceText: string
  /** The first assistant reply's text. */
  resultText: string
  /** The title the conversation's channel shows now. */
  currentTitle: string
}

/** Generate a title, or null when none should or could be written. */
export type HostStateTitleGenerator = (request: HostStateTitleRequest) => Promise<string | null>

/**
 * The texts to title a conversation from, when its transcript holds exactly
 * one assistant turn (the first just completed) and its title is still the
 * placeholder or the first message's preview. Anything else (a later turn, a
 * title someone chose, nothing to title from) answers null.
 */
export function hostStateTitleSource(
  messages: readonly UIMessage[],
  currentTitle: string
): { sourceText: string; resultText: string } | null {
  if (messages.filter((message) => message.role === "assistant").length !== 1) return null
  const sourceText = extractPlainText(messages.find((message) => message.role === "user"))
  if (!sourceText.trim()) return null
  if (!isPlaceholderTitle(currentTitle) && !isInstantPreviewTitle(currentTitle, sourceText))
    return null
  return {
    sourceText,
    resultText: extractAssistantText(messages.find((message) => message.role === "assistant")),
  }
}

/**
 * A client on the org's model for one conversation, through a Host ticket.
 * Null when the conversation names no model; a refused mint (no org key, an
 * unserved model, a reached cap) throws, and the title pipeline reads that as
 * no title.
 */
export async function personTitleClient(session: ChatSession): Promise<LlmClient | null> {
  const provider = session.providerOverride
  const model = session.model
  if (!provider || !model) return null
  const [{ mintPersonModelTicket }, { createLlmClient }] = await Promise.all([
    import("@/lib/gateway/person-model-ticket"),
    import("@/lib/twin/distill/llm"),
  ])
  const ticket = await mintPersonModelTicket(provider, model, session.id)
  // The ticket gateway speaks OpenAI chat completions, as a member's turns use
  // it (`resolveSendOptions`' `personChat` branch).
  return createLlmClient({
    provider: "openai",
    model,
    apiKey: ticket.secret,
    baseURL: ticket.endpoint,
    apiFlavor: "chat",
  })
}

/** The Host's settings, as the brain reads them elsewhere (`desktop-write-source.ts`). */
async function hostSettings(): Promise<AppSettings | null> {
  const { useSettingsStore } = await import("@/stores/settings")
  return useSettingsStore.getState().settings ?? (await getSettings().catch(() => null))
}

export interface HostStateTitleDeps {
  settings?: () => Promise<AppSettings | null>
  /** Whether this Host serves a person partition (its models are the org's). */
  personPartition?: () => boolean
  personClient?: (session: ChatSession) => Promise<LlmClient | null>
}

/** The Host's {@link HostStateTitleGenerator}. */
export function createHostStateTitleGenerator(
  deps: HostStateTitleDeps = {}
): HostStateTitleGenerator {
  const settingsOf = deps.settings ?? hostSettings
  const personPartition = deps.personPartition ?? (() => personChatCapability().chat !== "none")
  const personClient = deps.personClient ?? personTitleClient
  return async ({ session, sourceText, resultText, currentTitle }) => {
    const settings = await settingsOf()
    const partition = personPartition()
    return runTitleTask({
      session,
      appSettings: settings,
      override: settings?.conversationTitle,
      featureId: "conversation-title",
      sourceText,
      resultText,
      locale: settings?.language,
      currentTitle,
      dedupKey: session.id,
      ...(partition ? { buildClient: () => personClient(session) } : {}),
      // The channel commit is the write, and it checks the title it read.
      persist: () => undefined,
    })
  }
}

/** How long a title another caller is generating is waited for. */
const DEVICE_TITLE_WAIT_MS = 60_000
const DEVICE_TITLE_POLL_MS = 250

/**
 * The model title this process's chat view wrote to the conversation's row,
 * if it titled the conversation itself.
 *
 * On a desktop Host with the conversation open, the chat view's own
 * turn-complete upgrade (`runUtilityModelTasks`) runs too. It shares the
 * pipeline's in-flight dedup, so one of the two asks the model and the other
 * gets null; when the chat view won, its title is only on the `sessions` row,
 * and every other device would keep the preview. So the Host waits for that
 * call to finish and takes its title, rather than asking the model again.
 */
export async function deviceWrittenTitle(
  sessionId: string,
  sourceText: string,
  channelTitle: string,
  deps: { wait?: (ms: number) => Promise<void>; waitMs?: number } = {}
): Promise<string | null> {
  const wait =
    deps.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  for (
    let waited = 0;
    isTitleInFlight(sessionId) && waited < (deps.waitMs ?? DEVICE_TITLE_WAIT_MS);
    waited += DEVICE_TITLE_POLL_MS
  ) {
    await wait(DEVICE_TITLE_POLL_MS)
  }
  const row = await getDb().sessions.get(sessionId)
  const title = row?.title?.trim()
  if (!row || row.titleAuto === false || !title || title === channelTitle) return null
  if (isPlaceholderTitle(title) || isInstantPreviewTitle(title, sourceText)) return null
  return title
}
