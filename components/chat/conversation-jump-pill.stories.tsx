import type { Meta, StoryObj } from "@storybook/nextjs"

import { ConversationJumpPill, resolveJumpPillMode } from "./conversation-jump-pill"

/**
 * The single floating offer at the foot of the message pane, morphing between
 * three states rather than stacking three buttons.
 *
 * In the app it renders OUTSIDE the scroll container. That is the whole point:
 * as an `absolute bottom-4` child of the scroll container it was positioned
 * against the unscrolled box and scrolled away with the messages — invisible
 * exactly when it exists, since it only appears once you have scrolled up.
 * Here it is centred so the three states can be compared.
 */
const meta = {
  title: "Chat/ConversationJumpPill",
  component: ConversationJumpPill,
  parameters: { layout: "centered" },
  args: {
    mode: "toBottom",
    onReturn: () => {},
    onToBottom: () => {},
  },
} satisfies Meta<typeof ConversationJumpPill>

export default meta
type Story = StoryObj<typeof meta>

/** Scrolled up, nothing new arrived — the plain "go to the newest turn" offer. */
export const ToBottom: Story = {}

/** Replies landed while the user was reading further up. */
export const NewMessages: Story = {
  args: { mode: "newMessages", newMessageCount: 3 },
}

/** Plural boundary — the label is an ICU `{count}` message, not concatenation. */
export const NewMessagesSingular: Story = {
  args: { mode: "newMessages", newMessageCount: 1 },
}

/**
 * Offered for 8s after a jump. It outranks the other two — including being at
 * the bottom — because it is the only one that expires, and it answers
 * something the user deliberately asked for seconds ago.
 */
export const Return: Story = {
  args: { mode: "return" },
}

/** At the bottom with nothing to return to: the pill is absent, not disabled. */
export const Hidden: Story = {
  args: { mode: null },
}

/**
 * The precedence rule itself, rendered as a table. `resolveJumpPillMode` is a
 * pure function split out of the component precisely so this decision can be
 * read (and tested) without a DOM.
 */
export const ModePrecedence: Story = {
  render: () => {
    const cases = [
      { atBottom: true, canReturn: false, newMessageCount: 0 },
      { atBottom: true, canReturn: true, newMessageCount: 0 },
      { atBottom: false, canReturn: false, newMessageCount: 0 },
      { atBottom: false, canReturn: false, newMessageCount: 4 },
      { atBottom: false, canReturn: true, newMessageCount: 4 },
    ]
    return (
      <table className="text-sm [&_td]:px-3 [&_td]:py-2 [&_th]:px-3 [&_th]:py-2 [&_th]:text-left">
        <thead className="text-muted-foreground">
          <tr>
            <th>atBottom</th>
            <th>canReturn</th>
            <th>new</th>
            <th>→ mode</th>
          </tr>
        </thead>
        <tbody>
          {cases.map((c, i) => (
            <tr key={i} className="border-t border-border">
              <td>{String(c.atBottom)}</td>
              <td>{String(c.canReturn)}</td>
              <td>{c.newMessageCount}</td>
              <td className="font-mono">{String(resolveJumpPillMode(c))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    )
  },
}
