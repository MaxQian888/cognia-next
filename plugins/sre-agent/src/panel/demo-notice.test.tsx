/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import type { SreRuntime } from "../runtime"
import { en, registerSreBundle, unregisterSreBundle } from "../i18n.test-helpers"
import { DemoNotice } from "./demo-notice"

beforeEach(() => registerSreBundle())
afterEach(() => unregisterSreBundle())

const runtime = (demo: boolean) =>
  ({
    provider: () => ({ id: "x", kind: demo ? "fixture" : "remote", demo, coverage: null }),
  }) as Partial<SreRuntime> as SreRuntime

describe("DemoNotice", () => {
  it("states that the evidence is the bundled demo corpus", () => {
    render(<DemoNotice runtime={runtime(true)} />)
    const note = screen.getByRole("note")
    expect(note).toHaveTextContent(en("demo.badge"))
    expect(note).toHaveTextContent(en("demo.notice"))
  })

  it("renders nothing for a live backend", () => {
    const { container } = render(<DemoNotice runtime={runtime(false)} />)
    expect(container).toBeEmptyDOMElement()
  })
})
