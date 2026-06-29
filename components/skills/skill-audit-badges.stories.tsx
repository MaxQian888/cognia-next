import type { Meta, StoryObj } from "@storybook/nextjs"

import { SkillAuditBadges } from "./skill-audit-badges"
import { makeAudit } from "@/lib/storybook/fixtures/skills"

// Pure props-only — per-provider security badges for a skills.sh item. Full
// mode renders one pill per provider; compact mode collapses to a worst-risk
// dot and renders nothing while loading/undefined.
const meta = {
  title: "Skills/SkillAuditBadges",
  component: SkillAuditBadges,
  parameters: { layout: "padded" },
} satisfies Meta<typeof SkillAuditBadges>

export default meta
type Story = StoryObj<typeof meta>

export const Full: Story = {
  args: { audit: makeAudit() },
}

export const HighRisk: Story = {
  args: {
    audit: makeAudit({
      worstRisk: "critical",
      providers: [
        { provider: "Socket", risk: "critical", score: 12, summary: "Malicious install script." },
        { provider: "Snyk", risk: "high", score: 30, summary: "Known RCE advisory." },
      ],
    }),
  },
}

export const Loading: Story = {
  args: { audit: "loading" },
}

export const NoData: Story = {
  args: { audit: null },
}

export const CompactDot: Story = {
  args: { audit: makeAudit({ worstRisk: "high" }), compact: true },
}
