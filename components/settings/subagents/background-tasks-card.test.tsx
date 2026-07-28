/**
 * @jest-environment jsdom
 */

import { useState } from "react"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { AppSettings } from "@cognia/agent-config-types"

import {
  BACKGROUND_DEFAULTS,
  BackgroundTasksCard,
  backgroundValuesFromSettings,
  backgroundValuesToSettings,
  denyLinesToRules,
  rulesToDenyLines,
  type BackgroundPolicyValues,
} from "./background-tasks-card"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

function Controlled({ initial = BACKGROUND_DEFAULTS }: { initial?: BackgroundPolicyValues }) {
  const [value, setValue] = useState(initial)
  return (
    <BackgroundTasksCard
      value={value}
      onChange={(partial) => setValue((v) => ({ ...v, ...partial }))}
    />
  )
}

describe("deny-list serialization", () => {
  it("round-trips globs through the editor text", () => {
    const text = "template:*\nacme:reviewer"
    expect(rulesToDenyLines(denyLinesToRules(text))).toBe(text)
  })

  it("drops blank lines and surrounding whitespace", () => {
    expect(denyLinesToRules("  a  \n\n\n  b ")).toEqual({ a: "deny", b: "deny" })
  })

  it("treats an empty editor as 'no rules' rather than an empty ruleset", () => {
    expect(denyLinesToRules("   \n  ")).toBeUndefined()
    expect(rulesToDenyLines(undefined)).toBe("")
  })

  it("ignores non-deny verdicts when reading back", () => {
    expect(rulesToDenyLines({ a: "deny", b: "allow" })).toBe("a")
  })
})

describe("backgroundValuesFromSettings", () => {
  it("defaults to surfacing asks when nothing is stored", () => {
    expect(backgroundValuesFromSettings(undefined)).toEqual(BACKGROUND_DEFAULTS)
  })

  it("reads the auto-deny mode back as an unchecked switch", () => {
    const values = backgroundValuesFromSettings({
      agentPermissions: { subagentAsks: "auto-deny" },
    } as AppSettings)
    expect(values.surfaceAsks).toBe(false)
  })
})

describe("backgroundValuesToSettings", () => {
  it("preserves sibling agentPermissions keys it does not own", () => {
    const out = backgroundValuesToSettings(BACKGROUND_DEFAULTS, {
      subagentAsks: "auto-deny",
      defaultMode: "acceptEdits",
    } as AppSettings["agentPermissions"])
    expect(out.agentPermissions).toMatchObject({ defaultMode: "acceptEdits" })
    expect(out.agentPermissions?.subagentAsks).toBe("surface")
  })

  it("clears the rules branch when the editor is emptied", () => {
    const out = backgroundValuesToSettings({ ...BACKGROUND_DEFAULTS, denyGlobs: "" }, {
      subagentRules: { "template:*": "deny" },
    } as AppSettings["agentPermissions"])
    expect(out.agentPermissions?.subagentRules).toBeUndefined()
  })

  it("maps the switch to the two stored modes", () => {
    expect(
      backgroundValuesToSettings({ ...BACKGROUND_DEFAULTS, surfaceAsks: false }, undefined)
        .agentPermissions?.subagentAsks
    ).toBe("auto-deny")
  })
})

describe("BackgroundTasksCard", () => {
  it("keeps the finder deep-link anchor", () => {
    const { container } = render(<Controlled />)
    expect(
      container.querySelector('[data-setting-id="subagent-background-tasks"]')
    ).toBeInTheDocument()
  })

  it("reports edits upward instead of holding its own state", async () => {
    const onChange = jest.fn()
    render(<BackgroundTasksCard value={BACKGROUND_DEFAULTS} onChange={onChange} />)
    await userEvent.click(screen.getByRole("switch", { name: "autoResume" }))
    expect(onChange).toHaveBeenCalledWith({ autoResume: true })
  })

  it("gates the attempt cap behind the auto-resume switch", async () => {
    render(<Controlled />)
    expect(screen.getByLabelText("maxAttempts")).toBeDisabled()
    await userEvent.click(screen.getByRole("switch", { name: "autoResume" }))
    expect(screen.getByLabelText("maxAttempts")).toBeEnabled()
  })

  it("edits the deny-list as free text", async () => {
    render(<Controlled />)
    const box = screen.getByLabelText("denyList")
    await userEvent.type(box, "template:*")
    expect(box).toHaveValue("template:*")
  })
})
