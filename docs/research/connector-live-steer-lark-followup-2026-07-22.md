# Connector live steering and Feishu follow-up bubbles

Retrieved: 2026-07-22

Scope: primary-source verification for Cognia's installed Claude Agent SDK sidecar and Feishu/Lark follow-up bubbles. Product documentation and the installed package/source are treated as authoritative; architectural conclusions are explicitly marked as inferences.

## Executive conclusions

1. **The Anthropic sidecar is capable of accepting additional user messages while its query is alive.** The installed `@anthropic-ai/claude-agent-sdk` is `0.3.183` (bundled Claude Code `2.1.183`), `query()` accepts an `AsyncIterable<SDKUserMessage>`, and Cognia already supplies such an iterable. The missing capability is a safe, acknowledged `steer` route from connector runtime → renderer IPC → Rust host → sidecar session, not a missing SDK primitive. See the official [streaming-input guide](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode), [TypeScript reference](https://platform.claude.com/docs/en/agent-sdk/typescript), and the exact installed artifact distributed as [`claude-agent-sdk-0.3.183.tgz`](https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/-/claude-agent-sdk-0.3.183.tgz).
2. **The guaranteed semantic is an additional message delivered to the live streaming session, not arbitrary mutation of an already-issued model request.** Anthropic documents queued messages that are processed sequentially and `interrupt()` as a separate control. The installed type adds `priority?: "now" | "next" | "later"`, but that field is not yet described in the public TypeScript reference. Cognia may feature-detect and use it, but must not claim current-token interruption or make correctness depend on the undocumented priority interpretation.
3. **Feishu has a stable server API for follow-up bubbles.** It is `POST /open-apis/im/v1/messages/:message_id/push_follow_up`. However, the official contract is strictly bot↔user **P2P only**. It cannot enhance group topics. Cognia can enable it for direct chats and must keep topic/group `followUpBubbles` unavailable with an explicit scope reason. See [添加跟随气泡](https://open.feishu.cn/document/im-v1/message/push_follow_up.md) and the official [Messaging API index](https://open.feishu.cn/llms-docs/zh-CN/llms-messaging.txt).

## 1. Claude Agent SDK and Cognia sidecar

### 1.1 Verified SDK contract

The installed dependency is exactly `@anthropic-ai/claude-agent-sdk@0.3.183`; its package metadata identifies bundled `claudeCodeVersion: 2.1.183`. This is pinned in `sidecar/package.json:24` and confirmed by the published [npm artifact](https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/-/claude-agent-sdk-0.3.183.tgz).

The public TypeScript contract is:

```ts
function query({
  prompt,
  options,
}: {
  prompt: string | AsyncIterable<SDKUserMessage>
  options?: Options
}): Query
```

`Query` extends `AsyncGenerator<SDKMessage, void>` and exposes streaming-mode controls including `interrupt()`, `setPermissionMode()`, `setModel()`, `streamInput()`, `stopTask()`, and `close()`. Anthropic documents `interrupt()` as streaming-input-only, `streamInput()` as the multi-turn input mechanism, and `close()` as forceful query/process cleanup. Source: [Agent SDK TypeScript reference](https://platform.claude.com/docs/en/agent-sdk/typescript).

Anthropic recommends streaming input for a long-lived interactive process. Its documented benefits include queued messages processed sequentially, real-time output, images, interruption, tools, and persistent context. A TypeScript example passes an async generator yielding a second user message after a delay. Source: [Streaming Input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode).

The installed `SDKUserMessage` additionally contains:

```ts
type SDKUserMessage = {
  type: "user"
  message: MessageParam
  parent_tool_use_id: string | null
  priority?: "now" | "next" | "later"
  shouldQuery?: boolean
  timestamp?: string
  // ...identity/replay fields
}
```

This exact shape is verified in the published `0.3.183` package artifact. The public web reference currently documents the base message fields but not `priority`, `shouldQuery`, or `timestamp`; therefore those three fields should be treated as **version-pinned package API**, not a cross-version guarantee. Source: [`0.3.183` npm artifact](https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/-/claude-agent-sdk-0.3.183.tgz) and [public SDKUserMessage reference](https://platform.claude.com/docs/en/agent-sdk/typescript#sdkusermessage).

### 1.2 Error, cancellation, and input-lifecycle facts

- `interrupt()` stops the current query execution and returns control; it is available only in streaming-input mode. It is distinct from sending another user message. Source: [Query methods](https://platform.claude.com/docs/en/agent-sdk/typescript#query-object).
- `close()` forcefully ends the query, terminates the underlying process, and cleans pending requests/transports. No further messages should be expected afterward. Source: [Query methods](https://platform.claude.com/docs/en/agent-sdk/typescript#query-object).
- If a TypeScript message generator throws, Anthropic warns that the surfaced error may be the generic `Claude Code process aborted by user` rather than the generator's original exception. Input-queue failures therefore need their own local acknowledgement/error channel. Source: [Streaming Input implementation notes](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode#implementation-example).
- Single-message mode explicitly lacks dynamic message queueing and real-time interruption; Cognia must keep using an async iterable for live steering. Source: [Single Message Input limitations](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode#single-message-input).

### 1.3 Verified Cognia implementation state

Cognia is already on the correct SDK input mode:

- `sidecar/dispatch/anthropic.mjs:556` calls `query({ prompt: inputStream.iterable, options })`.
- `sidecar/dispatch/anthropic.mjs:580-623` exposes `session.pushUserMessage()` and pushes `SDKUserMessage` objects into that iterable.
- `sidecar/dispatch/input-stream.mjs:7-50` implements the live async queue.
- `sidecar/claude-host.mjs:252-280` routes ordinary `send` messages, but `restartReason()` deliberately classifies any still-registered Anthropic session as `"stale single-turn session"` and restarts it. Therefore a second ordinary send cannot be used as live steering.
- The sidecar JSON-line protocol has `send`, `interrupt`, controls, approvals, and close, but no dedicated `steer` command or correlated acceptance response.
- The input queue's `push()` silently returns when closed (`sidecar/dispatch/input-stream.mjs:14-20`). Without changing that contract, a host could falsely acknowledge a steer that was dropped after a query race.

The sidecar downgrade is consequently a **wiring and acknowledgement gap**, not an SDK capability gap.

### 1.4 Required production design (inference from verified contracts)

The following design is an inference, but each step is required to preserve Cognia's durable-dispatch guarantees:

1. Add a separate sidecar protocol command, for example `{ type: "steer", requestId, sessionId, content, priority, sourceMessageId }`. It must never reuse `handleSend()`, because that path is intentionally allowed to restart stale sessions.
2. Validate that the mapped session still owns an open Anthropic streaming input. Change `inputStream.push()` to return an explicit accepted/closed result; do not silently drop.
3. Push an `SDKUserMessage` to the existing iterable. For the pinned SDK, `priority: "now"` may be attempted for operator-selected steer mode, but capability metadata should identify this as version-pinned. The portable guarantee remains “accepted into the active streaming session at the earliest SDK safe boundary.”
4. Emit a correlated `steer_response` carrying `accepted | unavailable | closed | incompatible_phase | error`. The connector inbound job becomes live-steered only after `accepted`; every other result leaves the durable job pending for safe-boundary replay.
5. Preserve the active execution's existing `turnRef.id`. Updating it to the steering inbound job's turn ID would cause `run-and-capture.ts` to discard subsequent events from the active run as cross-turn leftovers.
6. Run the same prompt admission/security transformations required for a normal send (notably `UserPromptSubmit` hooks and attachment normalization) before the sidecar push. The first sender's authority must not be inherited by a later participant.
7. Do not invoke `interrupt()` merely to simulate steering. Interrupt-then-send is a distinct destructive policy: it can abort an in-flight model/tool phase and should only back an explicit “interrupt and redirect” control, never normal `ActiveRunDispatchMode = "steer"`.
8. If the provider is on Cognia's AI SDK dispatcher rather than the Anthropic dispatcher, advertise live steer only after that runner supplies an equivalent accepted-input acknowledgement. Cross-provider presentation may degrade, but a false-positive steer acknowledgement may not.

Recommended capability wording:

| Capability                      |     Anthropic sidecar `0.3.183` | Portable guarantee                                          |
| ------------------------------- | ------------------------------: | ----------------------------------------------------------- |
| live streaming input            |                       supported | Additional user message accepted while query is alive       |
| safe-boundary steering          | supported after protocol wiring | Message is processed at the SDK's next safe boundary        |
| mutate current model generation |                  not documented | Do not advertise                                            |
| force interrupt and redirect    | supported via separate controls | Explicit destructive operator action only                   |
| durable fallback                |                        required | Persist and replay when live acceptance is not acknowledged |

## 2. Feishu/Lark follow-up bubbles

### 2.1 Exact OpenAPI

Official API: [添加跟随气泡](https://open.feishu.cn/document/im-v1/message/push_follow_up.md)

```http
POST https://open.feishu.cn/open-apis/im/v1/messages/:message_id/push_follow_up
Authorization: Bearer <tenant_access_token>
Content-Type: application/json; charset=utf-8
```

Either permission is sufficient:

- `im:message` — get/send direct and group messages
- `im:message:send_as_bot` — send as the application

Request body:

```json
{
  "follow_ups": [
    {
      "content": "View status",
      "i18n_contents": [
        { "language": "zh_cn", "content": "查看状态" },
        { "language": "en_us", "content": "View status" }
      ]
    }
  ]
}
```

The official Node SDK exposes the same API as `client.im.message.pushFollowUp(...)` and emits the same POST endpoint. Source: [larksuite/node-sdk pinned source](https://github.com/larksuite/node-sdk/blob/8b3e0df3af9401c263dc96026e1c7f17460a21cc/code-gen/projects/im.ts#L3716-L3768).

### 2.2 Hard availability limits

All of the following are explicit official constraints:

- Feishu desktop/mobile client version must be at least `7.20` for the visual effect.
- The target must be a message in the current bot-user **P2P chat**. Group chats and group topics are rejected.
- The target message must have been sent by the bot, be the latest message in the conversation, and be no older than 600 seconds.
- A request contains 1-3 bubbles. Each default or translated content string is 1-200 characters. Up to 50 localized entries are accepted from the documented language enum.
- Clicking a bubble converts it into a normal user-sent message. A click or arrival of a new message makes the bubble disappear.
- Rate limit: 1,000/minute and 50/second.

Source for every constraint: [添加跟随气泡](https://open.feishu.cn/document/im-v1/message/push_follow_up.md).

The API's documented errors make the boundary machine-readable:

|     Code | Meaning                          |
| -------: | -------------------------------- |
| `230002` | message older than 600 seconds   |
| `230003` | not a P2P bot-user chat          |
| `230004` | message invisible to this bot    |
| `230005` | user invisible to this bot       |
| `230006` | target is not the latest message |
| `230007` | invalid bubble content           |
| `230008` | follow-up bubble already exists  |

The request schema documents no UUID or other idempotency field. This means remote idempotency is not guaranteed by the public contract; a retry that receives `230008` can be reconciled as “already present” only when it targets the same persisted message and desired content. Source: [API request and error schema](https://open.feishu.cn/document/im-v1/message/push_follow_up.md).

### 2.3 Product integration boundary (inference)

Follow-up bubbles should be supported as a **scope-conditional presentation capability**:

```ts
followUpBubbles: {
  direct: "supported",
  group: "unsupported",
  topic: "unsupported",
  constraints: {
    latestBotMessageOnly: true,
    maxAgeSeconds: 600,
    maxItems: 3,
    ephemeral: true
  }
}
```

A single global boolean is inaccurate. Direct chats can offer temporary `Stop`, `View status`, and pending-approval prompts. Group topics must continue using durable CardKit buttons because the server returns `230003` there.

Bubble clicks arrive as ordinary inbound user messages, not privileged callback events. Therefore Cognia should:

1. match content only against controls currently registered for that direct conversation/message;
2. authenticate and authorize the real sender exactly like a typed command;
3. expire the local control registration after 600 seconds, on a newer message, or after first use;
4. never infer approval authority merely because the text matches a bubble label;
5. fall back to normal messages/card controls if `230002`, `230003`, or `230006` is returned.

The official contract does not expose a distinct follow-up-click event marker or a durable control identifier; consequently content matching must be scoped to the persisted target message and live registration window. This is an inference from the documented behavior that a click becomes a normal user-sent message. Source: [follow-up behavior note](https://open.feishu.cn/document/im-v1/message/push_follow_up.md).

## 3. Capability correction

The previous degradations should be rewritten as follows:

- **Sidecar steering:** `supported` for the pinned Anthropic streaming-input sidecar after a correlated steer protocol is wired; semantics are safe-boundary live input, with durable replay on non-acceptance. “Mutates the current model request” remains unsupported/unverified.
- **Feishu follow-up bubbles:** `supported` only for direct bot-user chats satisfying latest-message/600-second/client constraints; `unsupported` for group and topic scopes by the platform's explicit contract. CardKit remains the durable topic control surface.

This preserves the non-degradable guarantees: no accepted inbound message is lost, no false steer acknowledgement is emitted, topic isolation is unchanged, and every control action is authorized using the actual sender identity.
