import { fireEvent, render, screen } from "@testing-library/react"

import type { GitRef } from "@/types/git"

import { GitRefSelect } from "./git-ref-select"

const refs: GitRef[] = [
  { name: "main", kind: "branch", targetHash: "aaa" },
  { name: "origin/main", kind: "remoteBranch", targetHash: "bbb" },
  { name: "v1.0.0", kind: "tag", targetHash: "ccc" },
]

describe("GitRefSelect", () => {
  it("renders a controlled repository ref", () => {
    render(
      <GitRefSelect
        refs={refs}
        value="main"
        onValueChange={jest.fn()}
        placeholder="Pick a ref"
        ariaLabel="Repository ref"
        testId="repository-ref"
      />
    )

    expect(screen.getByTestId("repository-ref")).toHaveTextContent("main")
  })

  it("selects a repository ref without performing a checkout", () => {
    const onValueChange = jest.fn()
    render(
      <GitRefSelect
        refs={refs}
        value={null}
        onValueChange={onValueChange}
        placeholder="Pick a ref"
        ariaLabel="Repository ref"
        testId="repository-ref"
      />
    )

    fireEvent.click(screen.getByTestId("repository-ref"))
    fireEvent.click(screen.getByTestId("repository-ref-origin/main"))

    expect(onValueChange).toHaveBeenCalledWith("origin/main")
  })
})
