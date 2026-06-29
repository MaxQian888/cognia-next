import type { Meta, StoryObj } from "@storybook/nextjs"

import { A2UIBreadcrumb, type A2UIBreadcrumbComponent } from "./a2ui-breadcrumb"
import { makeA2UIProps } from "@/lib/storybook/fixtures/a2ui"

const breadcrumb = (over: Partial<A2UIBreadcrumbComponent> = {}): A2UIBreadcrumbComponent => ({
  id: "breadcrumb",
  component: "Breadcrumb",
  items: [
    { label: "Home", href: "/" },
    { label: "Projects", href: "/projects" },
    { label: "Cognia", current: true },
  ],
  ...over,
})

const meta = {
  title: "A2UI/Navigation/Breadcrumb",
  component: A2UIBreadcrumb,
  parameters: { layout: "padded" },
} satisfies Meta<typeof A2UIBreadcrumb>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = { args: makeA2UIProps(breadcrumb()) }

export const TwoLevels: Story = {
  args: makeA2UIProps(
    breadcrumb({
      items: [
        { label: "Workspace", href: "/" },
        { label: "Settings", current: true },
      ],
    })
  ),
}

export const WithEllipsis: Story = {
  args: makeA2UIProps(
    breadcrumb({
      items: [
        { label: "Home", href: "/" },
        { label: "…", ellipsis: true },
        { label: "Reports", href: "/reports" },
        { label: "Q2 2026", current: true },
      ],
    })
  ),
}
