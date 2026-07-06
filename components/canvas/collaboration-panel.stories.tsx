import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { CollaborationPanel } from "./collaboration-panel"
import type { CanvasCollaborationSessionState, Participant } from "@/types/canvas/collaboration"

// CollaborationPanel renders a trigger button (with a participant-count badge)
// that opens a Sheet for starting / joining a real-time session. It accepts an
// external `collaborationState`, which the stories use to portray connection
// states without driving the live transport. The internal collaborative-session
// hook is render-safe (it never auto-connects).
function participant(over: Partial<Participant> = {}): Participant {
  return {
    id: "p1",
    name: "Ada Lovelace",
    color: "#7c3aed",
    lastActive: new Date(Date.UTC(2026, 5, 20, 12, 0, 0)),
    isOnline: true,
    ...over,
  }
}

const meta = {
  title: "Canvas/CollaborationPanel",
  component: CollaborationPanel,
  parameters: { layout: "centered" },
  args: {
    documentId: "doc-1",
    documentContent: "# Shared document\n\nEdited together in real time.",
    onReconnect: fn(),
    onContinueLocally: fn(),
    onEndSession: fn(),
  },
} satisfies Meta<typeof CollaborationPanel>

export default meta
type Story = StoryObj<typeof meta>

// No session yet — the trigger has no badge; the Sheet offers start / join.
export const Disconnected: Story = {}

// A connected session with two participants → trigger shows the count badge,
// and the Sheet (on open) shows live controls + the participant list.
export const ActiveSession: Story = {
  args: {
    collaborationState: {
      sessionId: "sess-abc12345",
      documentId: "doc-1",
      connectionState: "connected",
      recoveryState: "live",
      participants: [
        participant(),
        participant({ id: "p2", name: "Grace Hopper", color: "#0ea5e9" }),
      ],
      remoteCursors: [],
    } satisfies CanvasCollaborationSessionState,
  },
}

// A degraded session that lost its transport → reconnect / continue-locally.
export const Reconnecting: Story = {
  args: {
    collaborationState: {
      sessionId: "sess-abc12345",
      documentId: "doc-1",
      connectionState: "reconnecting",
      recoveryState: "degraded-local",
      recoveryReason: "Lost connection to the signaling server.",
      participants: [participant({ isOnline: false })],
      remoteCursors: [],
    } satisfies CanvasCollaborationSessionState,
  },
}
