import type { Meta, StoryObj } from "@storybook/nextjs"

import { ComposerChipOverlay } from "./composer-chip-overlay"
import { Textarea } from "@/components/ui/textarea"
import { TEXTAREA_TYPOGRAPHY } from "./composer-chip-overlay"
import { parseSegments } from "@/lib/slash-commands/parse-segments"
import { cn } from "@/lib/utils"

// Visual harness that stacks the overlay UNDER a real shadcn <Textarea> exactly
// the way the composer does (globals.css forces the textarea to 16px via the
// iOS-zoom guard; the overlay must match or the pills drift). Each story shows a
// value where misalignment would be obvious — the pill must sit precisely under
// the textarea glyphs.

const known = new Set(["reset", "model", "review", "git/commit"])
const isKnown = (n: string) => known.has(n)

function Harness({ value }: { value: string }) {
  const segments = parseSegments(value, isKnown, { mentions: true })
  return (
    <div className="relative w-96 rounded-md border bg-background p-0">
      <ComposerChipOverlay value={value} segments={segments} />
      <Textarea
        readOnly
        value={value}
        className={cn(
          "relative z-[1] block min-h-6 w-full resize-none border-0 bg-transparent shadow-none outline-none ring-0 focus-visible:ring-0",
          TEXTAREA_TYPOGRAPHY
        )}
        rows={1}
      />
    </div>
  )
}

const meta = {
  title: "Chat/Composer/ChipOverlay",
  component: Harness,
  parameters: { layout: "padded" },
} satisfies Meta<typeof Harness>

export default meta
type Story = StoryObj<typeof meta>

export const CommandWithSlashArgs: Story = { args: { value: "/reset ////////" } }
export const CommandWithArgs: Story = { args: { value: "/model opus and a longer tail" } }
export const MentionInText: Story = { args: { value: "ping @lib/db then continue typing" } }
export const MultiLine: Story = { args: { value: "/review auth flow\n/model opus" } }
