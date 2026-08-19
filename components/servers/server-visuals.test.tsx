/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"

import {
  formatBytes,
  HealthDot,
  HealthLabel,
  isRunningOperationState,
  OperationStateBadge,
  SERVER_HEALTHS,
  shortenDigest,
} from "./server-visuals"

describe("formatBytes", () => {
  it("steps through binary units and keeps one decimal above bytes", () => {
    expect(formatBytes(0)).toBe("0 B")
    expect(formatBytes(1023)).toBe("1023 B")
    expect(formatBytes(1024)).toBe("1.0 KiB")
    expect(formatBytes(1024 ** 2 * 1.5)).toBe("1.5 MiB")
    expect(formatBytes(1024 ** 4 * 3)).toBe("3.0 TiB")
  })

  it("stops at the largest unit instead of inventing one", () => {
    // A petabyte recovery point is not plausible, but silently rendering it as
    // an undefined unit would be a worse answer than an oversized TiB.
    expect(formatBytes(1024 ** 5)).toBe("1024.0 TiB")
  })

  it("refuses to format a value that is not a size", () => {
    expect(formatBytes(Number.NaN)).toBe("—")
    expect(formatBytes(-1)).toBe("—")
  })
})

describe("shortenDigest", () => {
  it("keeps the head and the tail so two digests stay distinguishable", () => {
    // `sha256:` digests are identical for their first dozen characters, so a
    // plain head truncation renders every release the same.
    const first = `sha256:${"a".repeat(60)}bbbbbb`
    const second = `sha256:${"a".repeat(60)}cccccc`
    expect(shortenDigest(first)).not.toBe(shortenDigest(second))
    expect(shortenDigest(first)).toBe("sha256:aaaaaaa…bbbbbb")
  })

  it("leaves a short value alone and reports an absent one", () => {
    expect(shortenDigest("v1.2.3")).toBe("v1.2.3")
    expect(shortenDigest(null)).toBeNull()
    expect(shortenDigest(undefined)).toBeNull()
  })
})

describe("isRunningOperationState", () => {
  it("treats every pre-terminal state as running", () => {
    for (const state of ["queued", "validating", "preparing", "executing", "verifying"] as const) {
      expect(isRunningOperationState(state)).toBe(true)
    }
    for (const state of [
      "succeeded",
      "failed",
      "rolled_back",
      "rollback_failed",
      "cancelled",
    ] as const) {
      expect(isRunningOperationState(state)).toBe(false)
    }
  })
})

describe("HealthLabel", () => {
  it("labels every health state the controller can report", () => {
    render(
      <>
        {SERVER_HEALTHS.map((health) => (
          <HealthLabel key={health} health={health} />
        ))}
      </>
    )
    expect(screen.getByText("Healthy")).toBeInTheDocument()
    expect(screen.getByText("Degraded")).toBeInTheDocument()
    expect(screen.getByText("Unavailable")).toBeInTheDocument()
    expect(screen.getByText("Unknown")).toBeInTheDocument()
  })
})

describe("HealthDot", () => {
  it("is decorative — the label beside it carries the meaning", () => {
    const { container } = render(<HealthDot health="healthy" />)
    expect(container.firstElementChild).toHaveAttribute("aria-hidden", "true")
  })
})

describe("OperationStateBadge", () => {
  it("spins only while the operation is still moving", () => {
    const { container: running } = render(<OperationStateBadge state="executing" />)
    expect(running.querySelector(".animate-spin")).not.toBeNull()

    const { container: finished } = render(<OperationStateBadge state="succeeded" />)
    expect(finished.querySelector(".animate-spin")).toBeNull()
    expect(screen.getByText("Succeeded")).toBeInTheDocument()
  })
})
