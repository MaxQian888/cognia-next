import type { Meta, StoryObj } from "@storybook/nextjs"

import { ImportSummary } from "./import-summary"
import type { ImportSummary as Summary } from "@/lib/data/types"

// Pure prop — post-import receipt with per-table tallies and the optional
// localStorage + MCP-sync reports.
const summary = (over: Partial<Summary>): Summary =>
  ({
    added: {},
    overwritten: {},
    skipped: {},
    builtInsSkipped: {},
    ...over,
  }) as unknown as Summary

const meta = {
  title: "Data/ImportSummary",
  component: ImportSummary,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-[28rem]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ImportSummary>

export default meta
type Story = StoryObj<typeof meta>

export const Basic: Story = {
  args: {
    summary: summary({
      added: { characters: 2, skills: 1, sessions: 3 },
      overwritten: { settings: 1 },
      skipped: { messages: 5 },
      builtInsSkipped: { characters: 4 },
    }),
  },
}

export const WithReports: Story = {
  args: {
    summary: summary({
      added: { sessions: 3, messages: 42 },
      localStorage: {
        written: ["theme", "locale"],
        skipped: ["telemetry"],
        errors: [{ key: "huge-blob", error: "quota exceeded" }],
        restoredFromPreSnap: [],
      },
      syncResults: [
        { agentId: "claude", ok: true, count: 12 },
        { agentId: "codex", ok: false, reason: "transport offline" },
      ],
    } as unknown as Summary),
  },
}
