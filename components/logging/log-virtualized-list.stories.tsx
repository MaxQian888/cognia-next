import type { Meta, StoryObj } from "@storybook/nextjs"
import { useRef } from "react"
import { useTranslations } from "next-intl"
import { fn } from "storybook/test"

import { VirtualizedLogList, type VirtualizedLogListProps } from "./log-virtualized-list"
import { makeLogStream } from "@/lib/storybook/fixtures/logging"

// `VirtualizedLogList` needs scroll/container refs and a bound `t`; a harness
// supplies all three (refs via `useRef`, `t` via `useTranslations`) so stories
// only set the data/state props. The TanStack virtualizer measures `scrollRef`,
// so a fixed-height container is required for rows to appear.
type HarnessProps = Omit<VirtualizedLogListProps, "t" | "scrollRef" | "containerRef">

function VirtualizedLogListHarness(props: HarnessProps) {
  const t = useTranslations("logging")
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  return (
    <div className="flex h-[560px] w-full flex-col border rounded-md">
      <VirtualizedLogList {...props} t={t} scrollRef={scrollRef} containerRef={containerRef} />
    </div>
  )
}

const meta = {
  title: "Logging/VirtualizedLogList",
  component: VirtualizedLogListHarness,
  parameters: { layout: "fullscreen" },
  args: {
    isLoading: false,
    error: null,
    filteredLogs: makeLogStream(60),
    groupByTraceId: false,
    groupedLogs: new Map(),
    expandedIds: new Set<string>(),
    toggleExpanded: fn(),
    searchQuery: "",
    useRegex: false,
    bookmarkedIds: new Set<string>(),
    toggleBookmark: fn(),
    handleSelectLog: fn(),
    handleFocusTrace: fn(),
    handleFocusSession: fn(),
    onRetry: fn(),
  },
} satisfies Meta<typeof VirtualizedLogListHarness>

export default meta
type Story = StoryObj<typeof meta>

export const Populated: Story = {}

export const Loading: Story = {
  args: { isLoading: true, filteredLogs: [] },
}

export const ErrorState: Story = {
  args: { error: new Error("IndexedDB transaction aborted (QuotaExceededError)") },
}

export const Empty: Story = {
  args: {
    filteredLogs: [],
    emptyStateContext: {
      activeFilterLabels: ["level: error", "module: network:lark"],
      onClearFilters: fn(),
      onOpenPresets: fn(),
    },
  },
}
