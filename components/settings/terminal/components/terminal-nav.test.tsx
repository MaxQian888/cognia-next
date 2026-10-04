import { fireEvent, render, screen } from "@testing-library/react"

import { TERMINAL_NAV_GROUPS } from "../nav-config"
import { TerminalNav } from "./terminal-nav"

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
jest.mock("@/components/settings/common/settings-panel-nav", () => ({
  SettingsPanelNav: ({
    groups,
    labels,
    onSelect,
    badges,
  }: {
    groups: { id: string; items: { id: string }[] }[]
    labels: { title: string; group: (g: string) => string; item: (i: string) => { label: string } }
    onSelect: (id: string) => void
    badges?: Record<string, { text: string }>
  }) => (
    <nav aria-label={labels.title}>
      {groups.map((group) => (
        <section key={group.id} aria-label={labels.group(group.id)}>
          {group.items.map((item) => (
            <button key={item.id} type="button" onClick={() => onSelect(item.id)}>
              {labels.item(item.id).label}
              {badges?.[item.id] ? ` (${badges[item.id].text})` : ""}
            </button>
          ))}
        </section>
      ))}
    </nav>
  ),
}))

it("binds every panel to the settings.terminal.nav namespace", () => {
  const onSelect = jest.fn()
  render(<TerminalNav groups={TERMINAL_NAV_GROUPS} activeId="appearance" onSelect={onSelect} />)
  expect(screen.getByRole("navigation", { name: "title" })).toBeInTheDocument()
  expect(screen.getByRole("region", { name: "groups.connectGroup" })).toBeInTheDocument()
  fireEvent.click(screen.getByText("items.ssh.label"))
  expect(onSelect).toHaveBeenCalledWith("ssh")
  expect(screen.getAllByRole("button")).toHaveLength(10)
})

it("passes badges through to the rail", () => {
  render(
    <TerminalNav
      groups={TERMINAL_NAV_GROUPS}
      activeId="ssh"
      onSelect={jest.fn()}
      badges={{ ssh: { text: "3", ariaLabel: "3 saved" } }}
    />
  )
  expect(screen.getByText("items.ssh.label (3)")).toBeInTheDocument()
})
