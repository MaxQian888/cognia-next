import { fireEvent, render, screen } from "@testing-library/react"

import { CONNECTIVITY_NAV_GROUPS } from "../nav-config"
import { ConnectivityNav } from "./connectivity-nav"

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
jest.mock("@/components/settings/common/settings-panel-nav", () => ({
  SettingsPanelNav: ({
    groups,
    labels,
    onSelect,
  }: {
    groups: { id: string; items: { id: string }[] }[]
    labels: { title: string; group: (g: string) => string; item: (i: string) => { label: string } }
    onSelect: (id: string) => void
  }) => (
    <nav aria-label={labels.title}>
      {groups.map((group) => (
        <section key={group.id} aria-label={labels.group(group.id)}>
          {group.items.map((item) => (
            <button key={item.id} type="button" onClick={() => onSelect(item.id)}>
              {labels.item(item.id).label}
            </button>
          ))}
        </section>
      ))}
    </nav>
  ),
}))

it("binds every topic to the settings.connectivity.nav namespace", () => {
  const onSelect = jest.fn()
  render(
    <ConnectivityNav groups={CONNECTIVITY_NAV_GROUPS} activeId="overview" onSelect={onSelect} />
  )
  expect(screen.getByRole("navigation", { name: "title" })).toBeInTheDocument()
  fireEvent.click(screen.getByText("items.sync.label"))
  expect(onSelect).toHaveBeenCalledWith("sync")
  expect(screen.getAllByRole("button")).toHaveLength(7)
})
