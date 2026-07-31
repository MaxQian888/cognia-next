import type { Meta, StoryObj } from "@storybook/nextjs"
import type { ReactNode } from "react"
import type { UIMessage } from "ai"
import { fn } from "storybook/test"

import { ChatPane } from "./chat-view"
import { DataAdapterProvider } from "@/lib/data-hooks/context"
import type { DataAdapter } from "@/lib/data-hooks/types"
import { useChatStore } from "@/stores/chat"
import type { ChatSession } from "@cognia/agent-config-types"

// ── The whole chat page in Storybook ───────────────────────────────────────
// `ChatPane` (header + message list + composer) is fully props-driven, so it
// renders in the real Storybook browser without the sidecar — unlike
// `DesktopChatWorkspace`, which calls `useClaudeChat()` (Tauri listeners) at
// mount. Storybook runs on the webpack framework (see .storybook/main.ts), so
// the heavy chat graph resolves exactly like the real app — no per-dep stubbing.
//
// Each story SEEDS the real chat-store with a different conversation/state via
// `seed()` so the variants exercise distinct render paths (streaming, tool
// calls, reasoning, markdown, error). `DataAdapterProvider` supplies a mock
// adapter (real one is mounted in app/layout.tsx). `showHeader` is off: the
// header's context-usage indicator calls the sidecar over IPC at mount.

const SID = "demo-session"

const demoSession: ChatSession = {
  id: SID,
  title: "Demo Conversation",
  characterId: "claude",
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
} as ChatSession

type ChatStatus = "idle" | "streaming" | "awaiting_approval" | "error"

// Message fixture builders — `as unknown as UIMessage[]` keeps the stories free
// of the ai SDK's exact part-union ceremony while staying shape-accurate.
const user = (id: string, text: string) => ({
  id,
  role: "user" as const,
  parts: [{ type: "text", text, state: "done" }],
})
const assistant = (id: string, text: string, extraParts: unknown[] = []) => ({
  id,
  role: "assistant" as const,
  parts: [...extraParts, { type: "text", text, state: "done" }],
})
const msgs = (...m: unknown[]): UIMessage[] => m as unknown as UIMessage[]

// Seed the real store with a full, isolated session state for one story.
function seed(messages: UIMessage[], opts: { status?: ChatStatus; error?: string } = {}) {
  const s = useChatStore.getState()
  s.closeSession(SID)
  s.setActiveSession(SID)
  s.replaceSessionMessages(SID, messages)
  if (opts.error) s.setSessionError(SID, opts.error)
  else if (opts.status && opts.status !== "idle") s.setSessionStatus(SID, opts.status)
}

const mockAdapter: DataAdapter = {
  useCharacters: () => [],
  useCharacter: () => undefined,
  useSkillsByIds: () => [],
  usePresets: () => [],
  clearMessages: async () => {},
  updateSession: async () => {},
  recordPresetUsage: async () => {},
  trustWorkspace: async () => {},
}

const withChatPage = (Story: () => ReactNode) => (
  <DataAdapterProvider adapter={mockAdapter}>
    <div className="h-screen w-full">
      <Story />
    </div>
  </DataAdapterProvider>
)

const CONVERSATION = msgs(
  user("u1", "帮我写一个简单的 React 计数器组件。"),
  assistant(
    "a1",
    "当然可以。下面是一个用 useState 实现的最小计数器：\n\n```tsx\nfunction Counter() {\n  const [n, setN] = useState(0)\n  return <button onClick={() => setN(n + 1)}>{n}</button>\n}\n```"
  )
)

const meta = {
  title: "Chat/ChatPane",
  component: ChatPane,
  parameters: { layout: "fullscreen" },
  decorators: [withChatPage],
  args: {
    activeSession: demoSession,
    sessionId: SID,
    onSend: fn(),
    onStop: fn(),
    onRegenerate: fn(),
    onEditResend: fn(),
    onCreate: fn(),
    onUseSample: fn(),
    onOpenSettings: fn(),
    showHeader: false,
  },
  beforeEach: () => seed(CONVERSATION),
} satisfies Meta<typeof ChatPane>

export default meta
type Story = StoryObj<typeof meta>

/** A live conversation: user + assistant bubbles above the real composer. */
export const Conversation: Story = {}

/** Fresh session with no messages — the welcome / empty state. */
export const EmptyState: Story = {
  args: { activeSession: null },
  beforeEach: () => seed(msgs()),
}

// The "just sent, no tokens yet" state: status streaming + the last message is
// the user's, so `shouldShowThinking` (message-list.tsx:390) renders the
// prominent ChatThinkingIndicator (animated dots) — the clearest streaming cue.
export const Thinking: Story = {
  beforeEach: () => seed(msgs(user("u1", "帮我把这段代码重构得更易读。")), { status: "streaming" }),
}

// Tokens arriving: the last assistant message is mid-stream. Static frame shows
// the streaming caret (a 2px `animate-pulse` line after the partial text — by
// design subtle, since real streaming is the text GROWING over time). The `play`
// function below animates that growth live so the effect is actually visible,
// then settles the turn to idle.
const STREAM_FULL =
  "闭包是指函数能够记住并访问它被创建时所在的词法作用域，即使函数在其作用域之外被调用。"
const streamFrame = (text: string, streaming: boolean) =>
  msgs(
    user("u1", "用一句话解释什么是闭包。"),
    streaming
      ? { id: "a1", role: "assistant", parts: [{ type: "text", text, state: "streaming" }] }
      : assistant("a1", text)
  )

export const Streaming: Story = {
  beforeEach: () => seed(streamFrame(STREAM_FULL.slice(0, 18), true), { status: "streaming" }),
  // Animate token-by-token growth (visible streaming), then finalize the turn.
  play: async () => {
    for (let i = 19; i <= STREAM_FULL.length; i += 1) {
      seed(streamFrame(STREAM_FULL.slice(0, i), true), { status: "streaming" })
      await new Promise((r) => setTimeout(r, 55))
    }
    seed(streamFrame(STREAM_FULL, false), { status: "idle" })
  },
}

/** A longer back-and-forth — density, scrollback, and alternating bubbles. */
export const MultiTurnThread: Story = {
  beforeEach: () =>
    seed(
      msgs(
        user("u1", "Next.js 的 static export 有什么限制？"),
        assistant(
          "a1",
          "主要限制是：没有运行时服务器，所以 `app/api/` 路由、ISR、和服务端中间件都不可用。"
        ),
        user("u2", "那需要后端能力怎么办？"),
        assistant(
          "a2",
          "在 Tauri 的 Rust 侧（axum）实现，或走 Capacitor 原生插件——前端保持纯静态。"
        ),
        user("u3", "明白了，谢谢！"),
        assistant("a3", "不客气 🙌 还有别的问题随时问。")
      )
    ),
}

/** Rich markdown rendering: headings, lists, table, inline + block code, quote. */
export const RichMarkdown: Story = {
  beforeEach: () =>
    seed(
      msgs(
        user("u1", "给我一份 Promise vs async/await 的对照速查。"),
        assistant(
          "a1",
          [
            "## Promise vs async/await",
            "",
            "两者底层一致，**async/await 只是语法糖**。",
            "",
            "| 维度 | Promise | async/await |",
            "| --- | --- | --- |",
            "| 可读性 | 链式 `.then()` | 同步风格 |",
            "| 错误处理 | `.catch()` | `try/catch` |",
            "",
            "要点：",
            "1. `await` 只能用在 `async` 函数里",
            "2. 用 `Promise.all` 并发，别串行 `await`",
            "",
            "> 提示：`for...of` + `await` 是串行，循环里慎用。",
            "",
            "```ts",
            "const [a, b] = await Promise.all([fetchA(), fetchB()])",
            "```",
          ].join("\n")
        )
      )
    ),
}

/** Assistant turn with a visible reasoning (thinking) part before the answer. */
export const WithReasoning: Story = {
  beforeEach: () =>
    seed(
      msgs(
        user("u1", "127 和 131 都是质数吗？"),
        assistant("a1", "是的，127 和 131 都是质数。", [
          {
            type: "reasoning",
            text: "127：不被 2/3/5/7/11 整除，且 11² =121 < 127 < 144=12² → 质数。\n131：同理检查到 √131≈11.4 → 质数。",
            state: "done",
          },
        ])
      )
    ),
}

/** Assistant turn that invokes a tool — renders the Tool call card. */
export const WithToolCall: Story = {
  beforeEach: () =>
    seed(
      msgs(
        user("u1", "看一下 app/page.tsx 写了什么。"),
        assistant("a1", "这是 `app/page.tsx` 的内容——它按平台分发到桌面或移动外壳：", [
          {
            type: "tool-Read",
            toolCallId: "call_read_1",
            state: "output-available",
            input: { file_path: "app/page.tsx" },
            output:
              "export default function Home() {\n  return isMobile() ? <AppShellMobile /> : <DesktopChatWorkspace />\n}",
          },
        ])
      )
    ),
}

/** Turn ended in an error — the error surface + retry affordance. */
export const ErrorState: Story = {
  beforeEach: () =>
    seed(msgs(user("u1", "再帮我跑一次。"), assistant("a1", "正在处理…")), {
      error: "Rate limit exceeded (429). Please retry in a moment.",
    }),
}
