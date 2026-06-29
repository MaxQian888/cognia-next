import type { Meta, StoryObj } from "@storybook/nextjs"

import { MonacoDiagnosticsBar } from "./monaco-diagnostics-bar"
import type { EditorLike, MonacoLike, RawMarker } from "@/hooks/use-monaco-markers"

// `useMonacoMarkers` is typed against minimal structural interfaces, so a plain
// fake monaco + editor drives the bar without a real Monaco instance.
function fakeEditor(): EditorLike {
  return {
    getModel: () => ({ uri: { toString: () => "inmemory://story/model" } }),
    setPosition: () => {},
    revealLineInCenterIfOutsideViewport: () => {},
    focus: () => {},
    getAction: () => ({ run: () => {} }),
  }
}

function fakeMonaco(markers: RawMarker[]): MonacoLike {
  return {
    editor: {
      getModelMarkers: () => markers,
      onDidChangeMarkers: () => ({ dispose: () => {} }),
    },
  }
}

const PROBLEMS: RawMarker[] = [
  {
    severity: 8,
    message: "Cannot find name 'foo'.",
    startLineNumber: 3,
    startColumn: 5,
    endLineNumber: 3,
    endColumn: 8,
  },
  {
    severity: 4,
    message: "'bar' is declared but never used.",
    startLineNumber: 10,
    startColumn: 7,
    endLineNumber: 10,
    endColumn: 10,
  },
]

// Desktop Monaco diagnostics status bar + expandable Problems list.
const meta = {
  title: "Editor/MonacoDiagnosticsBar",
  component: MonacoDiagnosticsBar,
  args: { editor: fakeEditor() },
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-[560px] border">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof MonacoDiagnosticsBar>

export default meta
type Story = StoryObj<typeof meta>

export const NoProblems: Story = {
  args: { monaco: fakeMonaco([]) },
}

export const WithProblems: Story = {
  args: { monaco: fakeMonaco(PROBLEMS) },
}
