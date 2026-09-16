/**
 * @jest-environment jsdom
 */

import { useState } from "react"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import {
  normalizeRouterFusionSettings,
  type RouterFusionSettings,
} from "@cognia/router-fusion/settings/settings"
import {
  actionConfigHash,
  actionExtensionFor,
  builtinAction,
} from "@cognia/router-fusion/settings/action-catalog"

import { RouterFusionActionCatalog } from "./router-fusion-action-catalog"

const mockToast = { success: jest.fn(), error: jest.fn() }
jest.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => mockToast.success(...args),
    error: (...args: unknown[]) => mockToast.error(...args),
  },
}))

type Patch =
  Partial<RouterFusionSettings> | ((current: RouterFusionSettings) => Partial<RouterFusionSettings>)

/** The saved settings; `persist` does what the section does: normalize, apply, normalize again. */
const store = { saved: normalizeRouterFusionSettings(undefined) }

function Harness({ aliases = [] }: { aliases?: string[] }) {
  const [settings, setSettings] = useState(store.saved)
  const persist = (patch: Patch) => {
    const changes = typeof patch === "function" ? patch(store.saved) : patch
    const next = normalizeRouterFusionSettings({ ...store.saved, ...changes })
    store.saved = next
    setSettings(next)
  }
  return <RouterFusionActionCatalog settings={settings} aliases={aliases} persist={persist} />
}

async function choose(user: ReturnType<typeof userEvent.setup>, label: string, option: string) {
  await user.click(screen.getByRole("combobox", { name: label }))
  await user.click(await screen.findByRole("option", { name: option }))
}

beforeEach(() => {
  jest.clearAllMocks()
  store.saved = normalizeRouterFusionSettings(undefined)
})

describe("RouterFusionActionCatalog", () => {
  it("lists the built-in actions with their mode, and labels delegate as a later release", () => {
    render(<Harness />)
    for (const id of [
      "direct_baseline",
      "direct_economy",
      "cascade_schema",
      "cascade_code",
      "panel_review",
    ]) {
      const row = screen.getByTestId(`router-fusion-action-${id}`)
      expect(row).not.toHaveAttribute("data-dormant")
      expect(row).toHaveTextContent("Built-in")
    }
    const delegate = screen.getByTestId("router-fusion-action-delegate_code")
    expect(delegate).toHaveAttribute("data-dormant", "true")
    expect(delegate).toHaveTextContent("Later release")
    expect(delegate).toHaveTextContent("Delegate runs need a sandbox and acceptance checks")
    expect(within(delegate).getByRole("switch")).toBeDisabled()
    expect(within(delegate).getByRole("switch")).not.toBeChecked()
    expect(screen.getByRole("button", { name: "Edit delegate_code" })).toBeDisabled()
    expect(screen.getByTestId("router-fusion-action-panel_review")).toHaveTextContent(
      "Panel member A: fast · Panel member B: balanced · Judge: powerful · Synthesizer: powerful"
    )
  })

  it("disables an action and enables it again without leaving an override behind", async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByRole("switch", { name: "Enable cascade_schema" }))
    expect(store.saved.actionOverrides).toEqual({ cascade_schema: { enabled: false } })
    expect(screen.getByTestId("router-fusion-action-cascade_schema")).toHaveTextContent("Edited")
    await user.click(screen.getByRole("switch", { name: "Enable cascade_schema" }))
    expect(store.saved.actionOverrides).toEqual({})
  })

  it("changes a role's alias, and every change shows a new configuration hash", async () => {
    const user = userEvent.setup()
    render(<Harness aliases={["code-tier"]} />)
    await user.click(screen.getByRole("button", { name: "Edit cascade_schema" }))
    const hash = screen.getByTestId("router-fusion-action-hash-cascade_schema").textContent
    const base = builtinAction("cascade_schema")!
    expect(hash).toBe(
      `Config hash ${actionConfigHash(base, actionExtensionFor(base, normalizeRouterFusionSettings(undefined))).slice(0, 12)}`
    )
    await choose(user, "Strong draft", "code-tier")
    expect(store.saved.actionOverrides).toEqual({
      cascade_schema: { roles: { strong: "code-tier" } },
    })
    expect(screen.getByTestId("router-fusion-action-hash-cascade_schema").textContent).not.toBe(
      hash
    )

    // Back to what the built-in names: the override is gone, and so is the new hash.
    await choose(user, "Strong draft", "powerful")
    expect(store.saved.actionOverrides).toEqual({})
    expect(screen.getByTestId("router-fusion-action-hash-cascade_schema").textContent).toBe(hash)
  })

  it("offers only the checks a mode can run, and labels a dormant one", async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByRole("button", { name: "Edit cascade_code" }))
    expect(screen.getByTestId("router-fusion-action-check-dormant-cascade_code")).toHaveTextContent(
      "Not chosen yet"
    )
    expect(screen.queryByTestId("router-fusion-action-check-dormant-cascade_schema")).toBeNull()
    const editor = screen.getByTestId("router-fusion-action-editor-cascade_code")
    expect(editor).toHaveTextContent("Needs a runtime verifier")
    await user.click(within(editor).getByRole("combobox", { name: "Verified by" }))
    expect(await screen.findByRole("option", { name: "Code tests" })).toHaveAttribute(
      "aria-disabled",
      "true"
    )
    await user.click(screen.getByRole("option", { name: "Model review" }))
    expect(store.saved.actionOverrides).toEqual({
      cascade_code: { verifier_profile: "text_review" },
    })
    expect(editor).toHaveTextContent("A reviewer model checks the answer against the request.")
    // With a check it can run, the router may choose it again.
    expect(screen.queryByTestId("router-fusion-action-check-dormant-cascade_code")).toBeNull()
  })

  it("sets and clears an action's own run cap", async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByRole("button", { name: "Edit panel_review" }))
    const cap = screen.getByLabelText("Run cap (USD)")
    expect(cap).toHaveAttribute("placeholder", "2.00")
    expect(screen.getByTestId("router-fusion-action-editor-panel_review")).toHaveTextContent(
      "Leave empty to use the Panel cap of $2.00."
    )
    await user.type(cap, "4.5")
    await user.tab()
    expect(store.saved.actionOverrides).toEqual({ panel_review: { runCapUsd: "4.5" } })
    await user.clear(screen.getByLabelText("Run cap (USD)"))
    await user.tab()
    expect(store.saved.actionOverrides).toEqual({})
  })

  it("refuses a panel of three without a third member, then accepts it once the role is set", async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByRole("button", { name: "Edit panel_review" }))
    await choose(user, "Panel size", "3")
    expect(mockToast.error).toHaveBeenCalledWith(
      "This change was not saved. A panel of three needs the Panel member C role."
    )
    expect(store.saved.actionOverrides).toEqual({})

    await choose(user, "Panel member C", "powerful")
    expect(store.saved.actionOverrides).toEqual({
      panel_review: { roles: { panel_c: "powerful" } },
    })
    await choose(user, "Panel size", "3")
    expect(store.saved.actionOverrides).toEqual({
      panel_review: { roles: { panel_c: "powerful" }, limits: { panel_size: 3 } },
    })
    // The third member cannot be dropped while the panel needs it.
    await choose(user, "Panel member C", "Not used")
    expect(mockToast.error).toHaveBeenCalledTimes(2)
    expect(store.saved.actionOverrides.panel_review?.roles).toEqual({ panel_c: "powerful" })
  })

  it("turns a panel's web evidence off", async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByRole("button", { name: "Edit panel_review" }))
    const web = screen.getByRole("switch", { name: "Web evidence" })
    expect(web).toBeChecked()
    await user.click(web)
    expect(store.saved.actionOverrides).toEqual({ panel_review: { webToolsEnabled: false } })
    await user.click(screen.getByRole("button", { name: "Reset to built-in" }))
    expect(store.saved.actionOverrides).toEqual({})
  })

  it("adds an action of the user's own, refusing an id that is invalid or taken", async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const id = screen.getByLabelText("Action id")
    const add = screen.getByRole("button", { name: "Add" })
    expect(add).toBeDisabled()
    await user.type(id, "Bad Id")
    expect(screen.getByTestId("router-fusion-action-add")).toHaveTextContent(
      "Use 3–48 lowercase letters, digits or underscores, starting with a letter."
    )
    expect(add).toBeDisabled()
    await user.clear(id)
    await user.type(id, "panel_review")
    expect(screen.getByTestId("router-fusion-action-add")).toHaveTextContent(
      "An action with this id already exists."
    )

    await user.clear(id)
    await user.type(id, "my_panel")
    await choose(user, "Mode", "Panel")
    await user.click(add)
    expect(mockToast.success).toHaveBeenCalledWith("Action my_panel added.")
    expect(store.saved.customActions).toEqual([
      expect.objectContaining({
        id: "my_panel",
        mode: "panel",
        verifier_profile: "evidence_review",
        enabled: true,
      }),
    ])
    expect(screen.getByLabelText("Action id")).toHaveValue("")
    const row = screen.getByTestId("router-fusion-action-my_panel")
    expect(row).toHaveTextContent("Custom")

    await user.click(screen.getByRole("button", { name: "Edit my_panel" }))
    await user.click(screen.getByRole("button", { name: "Delete" }))
    expect(store.saved.customActions).toEqual([])
    expect(screen.queryByTestId("router-fusion-action-my_panel")).toBeNull()
  })

  it("does not offer delegate for an action of the user's own", async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByRole("combobox", { name: "Mode" }))
    expect(await screen.findByRole("option", { name: "Delegate" })).toHaveAttribute(
      "aria-disabled",
      "true"
    )
  })
})
