/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"

import en from "@/i18n/messages/en.json"

const replace = jest.fn()
let pathname = "/settings"
let search = "section=automation"

jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: jest.fn() }),
  usePathname: () => pathname,
  useSearchParams: () => new URLSearchParams(search),
}))

// The engine only runs under Tauri. Off it the Overview tab renders its
// unavailable notice, which keeps this suite about the shell: the tab strip
// and where selecting a tab navigates.
jest.mock("@/lib/tauri", () => ({
  isTauri: () => false,
  transport: { call: jest.fn().mockResolvedValue(null), subscribe: jest.fn(() => () => {}) },
}))

jest.mock("@/lib/automation/audit", () => ({ listAuditRows: jest.fn().mockResolvedValue([]) }))

import { AutomationSection } from "@/components/settings/automation/automation-section"

function renderSection() {
  return render(
    <NextIntlClientProvider locale="en" messages={en as Record<string, unknown>}>
      <AutomationSection />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  replace.mockClear()
  pathname = "/settings"
  search = "section=automation"
})

describe("AutomationSection", () => {
  it("renders every tab through the shared strip", () => {
    renderSection()
    for (const id of [
      "overview",
      "permissions",
      "accessRules",
      "audit",
      "inspector",
      "sandboxes",
    ]) {
      expect(screen.getByTestId(`panel-tab-${id}`)).toBeInTheDocument()
    }
  })

  /**
   * Six triggers at their natural width overflow a phone viewport. The strip
   * has to let each one shrink instead, because this section also mounts
   * outside the settings shell where nothing else contains them.
   */
  it("lets every trigger shrink rather than overflow a narrow viewport", () => {
    renderSection()
    expect(screen.getByRole("tablist").className).toContain("max-w-full")
    for (const tab of screen.getAllByRole("tab")) {
      expect(tab.className).toContain("min-w-0")
      expect(tab.className).toContain("flex-initial")
      expect(tab.querySelector("span")?.className).toContain("truncate")
    }
  })

  it("keeps the tab selection on the settings route", async () => {
    renderSection()
    await userEvent.click(screen.getByTestId("panel-tab-audit"))
    expect(replace).toHaveBeenCalledWith("/settings?section=automation&autoTab=audit", {
      scroll: false,
    })
  })

  /**
   * `?autoTab=whitelist` is what links and bookmarks carry from before the
   * whitelist and the sandbox automation policy merged into Access rules.
   */
  it("still resolves the pre-merge whitelist tab id", () => {
    search = "section=automation&autoTab=whitelist"
    renderSection()
    expect(screen.getByTestId("panel-tab-accessRules")).toHaveAttribute("data-state", "active")
  })

  it("explains the missing engine through the shared notice, not a build command", () => {
    renderSection()
    const notice = screen.getByTestId("automation-unavailable")
    expect(notice).toHaveTextContent(en.automation.unavailable.title)
    expect(notice.textContent ?? "").not.toMatch(/pnpm|tauri dev|tauri build/i)
  })

  /**
   * The regression this guards: `setTab` used to write `/settings` verbatim, so
   * the first tap on the mobile Computer Use page navigated the user off it and
   * into desktop settings.
   */
  it("keeps the tab selection on whatever other route mounted it", async () => {
    pathname = "/me/computer-use"
    search = ""
    renderSection()
    await userEvent.click(screen.getByTestId("panel-tab-accessRules"))
    expect(replace).toHaveBeenCalledWith("/me/computer-use?autoTab=accessRules", { scroll: false })
    expect(replace).not.toHaveBeenCalledWith(
      expect.stringContaining("/settings"),
      expect.anything()
    )
  })
})
