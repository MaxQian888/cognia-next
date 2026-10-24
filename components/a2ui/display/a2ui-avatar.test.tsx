import React from "react"
import { render, screen } from "@testing-library/react"
import { A2UIAvatar, type A2UIAvatarComponent } from "./a2ui-avatar"
import type { A2UIComponentProps } from "@/types/a2ui/schema"

jest.mock("../a2ui-context", () => ({
  useA2UIContext: () => ({
    surfaceId: "test",
    dataModel: {},
    catalog: undefined,
    emitAction: jest.fn(),
    setDataValue: jest.fn(),
    renderChild: jest.fn(),
  }),
  useA2UIData: () => ({
    resolveString: (v: unknown) => (typeof v === "string" ? v : ""),
    resolveNumber: (v: unknown) => (typeof v === "number" ? v : 0),
    resolveBoolean: (v: unknown) => (typeof v === "boolean" ? v : false),
    resolveArray: <T,>(v: unknown, d: T[] = []) => (Array.isArray(v) ? v : d),
  }),
}))

// Radix only mounts the <img> once it has loaded, which never happens in
// jsdom; this stand-in shows which source the avatar would load.
jest.mock("@/components/ui/avatar", () => ({
  ...jest.requireActual("@/components/ui/avatar"),
  AvatarImage: ({ src }: { src: string }) => <img data-testid="avatar-image" src={src} alt="" />,
}))

describe("A2UIAvatar", () => {
  const cp = (c: A2UIAvatarComponent): A2UIComponentProps<A2UIAvatarComponent> => ({
    component: c,
    surfaceId: "t",
    dataModel: {},
    onAction: jest.fn(),
    onDataChange: jest.fn(),
    renderChild: jest.fn(),
  })

  it("renders with fallback text", () => {
    render(<A2UIAvatar {...cp({ id: "a1", component: "Avatar", fallback: "MQ" })} />)
    expect(screen.getByText("MQ")).toBeInTheDocument()
  })

  it("renders default fallback when none provided", () => {
    render(<A2UIAvatar {...cp({ id: "a2", component: "Avatar" })} />)
    expect(screen.getByText("?")).toBeInTheDocument()
  })

  it("renders large size variant", () => {
    const { container } = render(
      <A2UIAvatar {...cp({ id: "a3", component: "Avatar", size: "lg" })} />
    )
    const avatar = container.querySelector('[data-slot="a2ui-avatar"]')
    expect(avatar).toBeInTheDocument()
    expect(avatar).toHaveAttribute("data-size", "lg")
  })

  it("loads web sources and never a rejected one", () => {
    const { rerender } = render(
      <A2UIAvatar {...cp({ id: "a4", component: "Avatar", src: "https://example.com/me.png" })} />
    )
    expect(screen.getByTestId("avatar-image")).toHaveAttribute("src", "https://example.com/me.png")
    rerender(<A2UIAvatar {...cp({ id: "a4", component: "Avatar", src: "javascript:alert(1)" })} />)
    expect(screen.queryByTestId("avatar-image")).not.toBeInTheDocument()
  })
})
