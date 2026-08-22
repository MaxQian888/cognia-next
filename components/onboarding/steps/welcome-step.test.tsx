/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { WelcomeStep } from "./welcome-step"

const noop = () => {}

describe("WelcomeStep", () => {
  it("puts the recommended path on the primary button", () => {
    const onStart = jest.fn()
    render(<WelcomeStep shell="tauri" onStart={onStart} onCustomise={noop} />)
    fireEvent.click(screen.getByTestId("onboarding-welcome-cta"))
    expect(onStart).toHaveBeenCalled()
    expect(screen.queryByTestId("onboarding-mode-standalone")).toBeNull()
  })

  it("offers the step-by-step path as a link, not a matched card", () => {
    // Recommended and custom are not two equal options; drawing them as a pair
    // would add a decision to the screen whose job is to remove decisions.
    const onCustomise = jest.fn()
    render(<WelcomeStep shell="tauri" onStart={noop} onCustomise={onCustomise} />)
    const link = screen.getByTestId("onboarding-welcome-customise")
    fireEvent.click(link)
    expect(onCustomise).toHaveBeenCalled()
    expect(link.className).not.toContain("rounded-xl")
  })

  it("hides the skip affordance unless the host offers one", () => {
    render(<WelcomeStep shell="tauri" onStart={noop} onCustomise={noop} />)
    expect(screen.queryByTestId("onboarding-welcome-skip")).toBeNull()
  })

  it("offers the skip path when the host supplies it", async () => {
    const onSkipExisting = jest.fn().mockResolvedValue(undefined)
    render(
      <WelcomeStep
        shell="tauri"
        onStart={noop}
        onCustomise={noop}
        onSkipExisting={onSkipExisting}
      />
    )
    fireEvent.click(screen.getByTestId("onboarding-welcome-skip"))
    await waitFor(() => expect(onSkipExisting).toHaveBeenCalled())
  })

  it("carries the mobile runtime-mode fork absorbed from the old /welcome route", async () => {
    const onPickMode = jest.fn().mockResolvedValue(undefined)
    render(
      <WelcomeStep
        shell="mobile-standalone"
        onStart={noop}
        onCustomise={noop}
        onPickMode={onPickMode}
      />
    )
    fireEvent.click(screen.getByTestId("onboarding-mode-paired"))
    await waitFor(() => expect(onPickMode).toHaveBeenCalledWith("paired"))
  })

  it("commits the standalone choice", async () => {
    const onPickMode = jest.fn().mockResolvedValue(undefined)
    render(
      <WelcomeStep
        shell="mobile-paired"
        onStart={noop}
        onCustomise={noop}
        onPickMode={onPickMode}
      />
    )
    fireEvent.click(screen.getByTestId("onboarding-mode-standalone"))
    await waitFor(() => expect(onPickMode).toHaveBeenCalledWith("standalone"))
  })

  it("blocks both paths on a phone until it has committed a runtime mode", () => {
    // The mode is what decides the sequence, so starting without one would
    // build a plan for a shell the user has not chosen.
    render(
      <WelcomeStep
        shell="mobile-standalone"
        onStart={noop}
        onCustomise={noop}
        onPickMode={jest.fn()}
      />
    )
    expect(screen.getByTestId("onboarding-welcome-cta")).toBeDisabled()
    expect(screen.getByTestId("onboarding-welcome-customise")).toBeDisabled()
  })

  it("releases both paths once the phone has picked a mode", () => {
    render(
      <WelcomeStep
        shell="mobile-standalone"
        onStart={noop}
        onCustomise={noop}
        onPickMode={jest.fn()}
        mode="standalone"
      />
    )
    expect(screen.getByTestId("onboarding-welcome-cta")).toBeEnabled()
  })

  it("leaves the desktop CTA enabled — it has no runtime mode to commit", () => {
    render(<WelcomeStep shell="tauri" onStart={noop} onCustomise={noop} />)
    expect(screen.getByTestId("onboarding-welcome-cta")).toBeEnabled()
  })

  it("keeps both paths available on mobile when no fork handler is wired", () => {
    render(<WelcomeStep shell="mobile-standalone" onStart={noop} onCustomise={noop} />)
    expect(screen.getByTestId("onboarding-welcome-cta")).toBeEnabled()
    expect(screen.queryByTestId("onboarding-mode-standalone")).toBeNull()
  })
})
