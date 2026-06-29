import type { Meta, StoryObj } from "@storybook/nextjs"

import { SkillSecurityScanner } from "./skill-security-scanner"
import { makeSkill } from "@/lib/storybook/fixtures/skills"

// Tauri-branching + Dexie. In the Storybook (web) runtime `isTauri()` is false,
// so the scanner shows its desktop-only hint and never invokes the native scan
// IPC. `useLiveQuery` over an empty resources table resolves harmlessly.
const meta = {
  title: "Skills/SkillSecurityScanner",
  component: SkillSecurityScanner,
  parameters: { layout: "padded" },
  args: { skill: makeSkill() },
  decorators: [
    (Story) => (
      <div className="max-w-md">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SkillSecurityScanner>

export default meta
type Story = StoryObj<typeof meta>

// Web runtime → desktop-only hint (scan button disabled).
export const WebFallback: Story = {}
