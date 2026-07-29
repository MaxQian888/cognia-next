import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { SettingsPanelNav, type SettingsNavGroup } from "./settings-panel-nav"

let reduce = false
jest.mock("@/components/chat/motion/motion-reveal", () => ({
  useFlowMotion: () => ({ reduce }),
}))

type Id = "overview" | "logs"
type GroupId = "serviceGroup" | "observabilityGroup"

const Icon = ({ className }: { className?: string }) => <svg className={className} />

const GROUPS: readonly SettingsNavGroup<Id, GroupId>[] = [
  { id: "serviceGroup", items: [{ id: "overview", icon: Icon }] },
  { id: "observabilityGroup", items: [{ id: "logs", icon: Icon }] },
]

const LABELS = {
  title: "Gateway sections",
  group: (groupId: GroupId) => `group:${groupId}`,
  item: (id: Id) => ({ label: `label:${id}`, description: `desc:${id}` }),
}

function renderNav(over: Partial<Parameters<typeof SettingsPanelNav<Id, GroupId>>[0]> = {}) {
  const onSelect = jest.fn()
  render(
    <SettingsPanelNav<Id, GroupId>
      groups={GROUPS}
      activeId="overview"
      onSelect={onSelect}
      labels={LABELS}
      idPrefix="gateway"
      {...over}
    />
  )
  return { onSelect }
}

beforeEach(() => {
  reduce = false
})

describe("SettingsPanelNav", () => {
  it("renders each group header and its items from the supplied labels", () => {
    renderNav()

    expect(screen.getByTestId("gateway-nav-group-serviceGroup")).toHaveTextContent(
      "group:serviceGroup"
    )
    expect(screen.getByTestId("gateway-nav-item-overview")).toHaveTextContent("label:overview")
    expect(screen.getByTestId("gateway-nav-item-overview")).toHaveTextContent("desc:overview")
  })

  it("is a list driving a detail pane, not a tablist", () => {
    renderNav()

    expect(screen.getByRole("list", { name: "Gateway sections" })).toBeInTheDocument()
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument()
  })

  it("marks the active row and selects another", async () => {
    const user = userEvent.setup()
    const { onSelect } = renderNav()

    expect(screen.getByTestId("gateway-nav-item-overview")).toHaveAttribute("aria-current", "true")
    await user.click(screen.getByTestId("gateway-nav-item-logs"))

    expect(onSelect).toHaveBeenCalledWith("logs")
  })

  it("scopes its testids and layout pill to the id prefix", () => {
    // Two navs share this component; a shared `layoutId` would make the
    // selection pill jump between the Gateway and Bridge sections.
    renderNav({ idPrefix: "bridge" })

    expect(screen.getByTestId("bridge-nav-item-overview")).toBeInTheDocument()
    expect(screen.queryByTestId("gateway-nav-item-overview")).not.toBeInTheDocument()
  })

  it("renders badges only where supplied, each with a name", () => {
    renderNav({
      badges: { logs: { text: "!", variant: "destructive", ariaLabel: "No usable API key" } },
    })

    expect(screen.getByTestId("gateway-nav-badge-logs")).toHaveTextContent("!")
    // The glyph alone announces as "exclamation mark"; the label is what says
    // what it means.
    expect(screen.getByLabelText("No usable API key")).toBeInTheDocument()
    expect(screen.queryByTestId("gateway-nav-badge-overview")).not.toBeInTheDocument()
  })

  it("paints the active row's own background when motion is reduced", () => {
    // Under `reduce` the shared-layout pill is dropped entirely (only one
    // element may ever carry a given layoutId), so the row must not rely on it.
    reduce = true
    renderNav()

    expect(screen.getByTestId("gateway-nav-item-overview").className).toContain("bg-accent")
  })

  it("defers the highlight to the sliding pill when motion is allowed", () => {
    renderNav()

    expect(screen.getByTestId("gateway-nav-item-overview").className).not.toContain("bg-accent ")
  })
})
