/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"

import enPair from "@/i18n/messages/en/mobile/pair.json"
import zhPair from "@/i18n/messages/zh-CN/mobile/pair.json"

import { PairScene, type PairSceneState } from "./pair-scene"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => `scene.${key}`,
}))
jest.mock("@/components/chat/motion/motion-reveal", () => ({
  useFlowMotion: () => ({ reduce: false, durationScale: 1 }),
}))

const STATES: readonly PairSceneState[] = [
  "searching",
  "absent",
  "blocked",
  "reachable",
  "armed",
  "pairing",
  "paired",
  "failed",
] as const

it.each(STATES)("renders every state as a distinct link (%s)", (state) => {
  render(<PairScene state={state} />)
  expect(screen.getByTestId("pair-scene-link")).toHaveAttribute("data-state", state)
})

it("lights the Host only once something has actually answered", () => {
  const { rerender } = render(<PairScene state="absent" />)
  expect(screen.getByTestId("pair-scene-host")).toHaveAttribute("data-live", "false")

  rerender(<PairScene state="reachable" />)
  expect(screen.getByTestId("pair-scene-host")).toHaveAttribute("data-live", "true")
})

it("separates a refusal, a break and a settled link by shape, not only by colour", () => {
  // `--brand-action` measures 1.69:1 on a light substrate, so no state here
  // may be distinguishable by hue alone.
  const { rerender } = render(<PairScene state="blocked" />)
  expect(screen.getByTestId("pair-scene-barrier")).toBeInTheDocument()
  expect(screen.queryByTestId("pair-scene-break")).not.toBeInTheDocument()

  rerender(<PairScene state="failed" />)
  expect(screen.getByTestId("pair-scene-break")).toBeInTheDocument()
  expect(screen.queryByTestId("pair-scene-barrier")).not.toBeInTheDocument()

  rerender(<PairScene state="paired" />)
  expect(screen.getByTestId("pair-scene-check")).toBeInTheDocument()
  expect(screen.queryByTestId("pair-scene-key")).not.toBeInTheDocument()
})

it("draws a key exactly while a credential is riding on the link", () => {
  const { rerender } = render(<PairScene state="reachable" />)
  expect(screen.queryByTestId("pair-scene-key")).not.toBeInTheDocument()

  rerender(<PairScene state="armed" />)
  expect(screen.getByTestId("pair-scene-key")).toBeInTheDocument()

  rerender(<PairScene state="pairing" />)
  expect(screen.getByTestId("pair-scene-key")).toBeInTheDocument()
})

it("draws the client the caller is actually on", () => {
  const { rerender } = render(<PairScene state="armed" />)
  expect(screen.getByTestId("pair-scene-client")).toHaveAttribute("data-client", "web")

  rerender(<PairScene state="armed" client="mobile" />)
  expect(screen.getByTestId("pair-scene-client")).toHaveAttribute("data-client", "mobile")
})

// `lint:i18n` cannot see `t(`narration.${state}`)`, so the catalogue is pinned
// here instead: a state added without copy would otherwise render its own key.
it.each(STATES)("has scene + narration copy in both locales for %s", (state) => {
  for (const catalogue of [enPair, zhPair] as Array<Record<string, Record<string, string>>>) {
    expect(catalogue.scene[state]).toBeTruthy()
    expect(catalogue.narration[state]).toBeTruthy()
  }
})
