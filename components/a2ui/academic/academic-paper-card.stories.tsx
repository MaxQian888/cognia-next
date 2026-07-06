import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { AcademicPaperCard } from "./academic-paper-card"
import { makePaper } from "@/lib/storybook/fixtures/a2ui"

const meta = {
  title: "A2UI/Academic/PaperCard",
  component: AcademicPaperCard,
  parameters: { layout: "centered" },
  args: {
    paper: makePaper(),
    onViewDetails: fn(),
    onAddToLibrary: fn(),
    onOpenPdf: fn(),
    onAnalyze: fn(),
  },
  decorators: [
    (Story) => (
      <div className="w-[420px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof AcademicPaperCard>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const Compact: Story = { args: { compact: true } }

export const InLibrary: Story = { args: { isInLibrary: true, onAddToLibrary: undefined } }

export const NoPdf: Story = {
  args: { paper: makePaper({ pdfUrl: undefined, urls: [], isOpenAccess: false }) },
}
