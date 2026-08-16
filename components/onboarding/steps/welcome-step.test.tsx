/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { WelcomeStep } from "./welcome-step"

describe("WelcomeStep", () => {
  it("shows the plain CTA on the desktop", () => {
    const onNext = jest.fn()
    render(<WelcomeStep shell="tauri" onNext={onNext} />)
    fireEvent.click(screen.getByTestId("onboarding-welcome-cta"))
    expect(onNext).toHaveBeenCalled()
    expect(screen.queryByTestId("onboarding-mode-standalone")).toBeNull()
  })

  it("hides the skip affordance unless the host offers one", () => {
    render(<WelcomeStep shell="tauri" onNext={jest.fn()} />)
    expect(screen.queryByTestId("onboarding-welcome-skip")).toBeNull()
  })

  it("offers the skip path when the host supplies it", async () => {
    const onSkipExisting = jest.fn().mockResolvedValue(undefined)
    render(<WelcomeStep shell="tauri" onNext={jest.fn()} onSkipExisting={onSkipExisting} />)
    fireEvent.click(screen.getByTestId("onboarding-welcome-skip"))
    await waitFor(() => expect(onSkipExisting).toHaveBeenCalled())
  })

  it("carries the mobile runtime-mode fork absorbed from the old /welcome route", async () => {
    const onPickMode = jest.fn().mockResolvedValue(undefined)
    render(<WelcomeStep shell="mobile-standalone" onNext={jest.fn()} onPickMode={onPickMode} />)
    // The plain CTA is replaced by the fork — the choice it makes is what
    // decides which steps come next.
    expect(screen.queryByTestId("onboarding-welcome-cta")).toBeNull()
    fireEvent.click(screen.getByTestId("onboarding-mode-paired"))
    await waitFor(() => expect(onPickMode).toHaveBeenCalledWith("paired"))
  })

  it("commits the standalone choice", async () => {
    const onPickMode = jest.fn().mockResolvedValue(undefined)
    render(<WelcomeStep shell="mobile-paired" onNext={jest.fn()} onPickMode={onPickMode} />)
    fireEvent.click(screen.getByTestId("onboarding-mode-standalone"))
    await waitFor(() => expect(onPickMode).toHaveBeenCalledWith("standalone"))
  })

  it("falls back to the plain CTA on mobile when no fork handler is wired", () => {
    render(<WelcomeStep shell="mobile-standalone" onNext={jest.fn()} />)
    expect(screen.getByTestId("onboarding-welcome-cta")).toBeInTheDocument()
  })
})
