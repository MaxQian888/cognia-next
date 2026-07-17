/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import { KeyRoundIcon, LogOutIcon } from "lucide-react"

import { MeRow } from "./me-row"

describe("<MeRow />", () => {
  it("renders an anchor when href is provided", () => {
    render(<MeRow icon={KeyRoundIcon} label="订阅" href="/me/subscription" testid="row-sub" />)
    const link = screen.getByRole("link")
    expect(link).toHaveAttribute("href", "/me/subscription")
    expect(screen.getByText("订阅")).toBeInTheDocument()
  })

  it("uses a companion illustration instead of the Lucide fallback when supplied", () => {
    const { container } = render(
      <MeRow
        icon={KeyRoundIcon}
        spotIcon="secure-backup"
        label="Backup"
        href="/me/backup"
      />
    )

    expect(screen.getByTestId("mobile-spot-icon-secure-backup")).toHaveAttribute(
      "src",
      "/icons/cognia-mobile-spots/png/secure-backup.png"
    )
    expect(container.querySelector("svg.lucide-key-round")).toBeNull()
  })

  it("renders a button + invokes onClick when only onClick is provided", () => {
    const onClick = jest.fn()
    render(<MeRow icon={LogOutIcon} label="Sign out" onClick={onClick} />)
    const button = screen.getByRole("button", { name: "Sign out" })
    fireEvent.click(button)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it("renders neither a link nor a button when value-only (status row)", () => {
    render(<MeRow icon={KeyRoundIcon} label="版本" value="v0.1.0" />)
    expect(screen.queryByRole("link")).toBeNull()
    expect(screen.queryByRole("button")).toBeNull()
    expect(screen.getByText("v0.1.0")).toBeInTheDocument()
  })

  it("renders a chevron for interactive rows and omits it for value-only rows", () => {
    const { container, rerender } = render(<MeRow label="Action" onClick={() => undefined} />)
    expect(container.querySelector("svg.lucide-chevron-right")).not.toBeNull()
    rerender(<MeRow label="Status" value="ok" />)
    expect(container.querySelector("svg.lucide-chevron-right")).toBeNull()
  })

  it("applies destructive styling when destructive is true", () => {
    const { container } = render(<MeRow label="Delete" onClick={() => undefined} destructive />)
    expect(container.querySelector('[data-slot="item-title"]')?.className).toMatch(
      /text-destructive/
    )
  })

  it("renders an inert div when disabled, even if href or onClick are provided", () => {
    render(
      <MeRow
        label="Pending"
        href="/me/somewhere"
        onClick={() => undefined}
        disabled
        testid="disabled-row"
      />
    )
    expect(screen.queryByRole("link")).toBeNull()
    expect(screen.queryByRole("button")).toBeNull()
    expect(screen.getByTestId("disabled-row")).toHaveAttribute("aria-disabled", "true")
  })

  it("renders the supplied description under the label", () => {
    render(<MeRow label="同步" description="Last synced 3 minutes ago" href="/me/sync" />)
    expect(screen.getByText("Last synced 3 minutes ago")).toBeInTheDocument()
  })

  it("uses ariaLabel override when supplied for the interactive variants", () => {
    render(
      <MeRow
        label="Refresh"
        ariaLabel="Re-sync conversations from desktop"
        onClick={() => undefined}
      />
    )
    expect(
      screen.getByRole("button", { name: "Re-sync conversations from desktop" })
    ).toBeInTheDocument()
  })

  it("renders the value slot before the chevron in interactive rows", () => {
    render(<MeRow icon={KeyRoundIcon} label="语言" value="中文" href="/me/preferences" />)
    expect(screen.getByText("中文")).toBeInTheDocument()
    expect(screen.getByRole("link")).toHaveAttribute("href", "/me/preferences")
  })
})
