import { render, screen } from "@testing-library/react"

import { ProviderIcon } from "./provider-icon"
import {
  registerPluginSubscriptionProvider,
  unregisterSubscriptionProvidersByPlugin,
} from "@/lib/subscription/core/provider-registry"

describe("ProviderIcon", () => {
  it("uses a subscription plugin's declared brand without deriving it from its namespace", () => {
    const id = registerPluginSubscriptionProvider(
      {
        id: "plan",
        name: "Kimi Code",
        billingMode: "subscription",
        brandId: "kimi",
        baseUrl: "https://api.kimi.com/coding/v1",
        protocol: "openai",
        models: ["kimi-for-coding"],
      },
      "brand-test"
    )
    try {
      render(<ProviderIcon providerId={id} label="Kimi Code" decorative={false} />)
      expect(screen.getByRole("img", { name: "Kimi Code" })).toHaveAttribute(
        "src",
        "/icons/lobe/kimi-color.svg"
      )
    } finally {
      unregisterSubscriptionProvidersByPlugin("brand-test")
    }
  })
  it("renders a branded provider asset when one is available", () => {
    render(<ProviderIcon providerId="openai" label="OpenAI" decorative={false} />)

    expect(screen.getByRole("img", { name: "OpenAI" })).toHaveAttribute(
      "src",
      "/icons/lobe/openai.svg"
    )
  })

  it("keeps the monogram fallback for custom providers", () => {
    render(<ProviderIcon providerId="private-gateway" decorative={false} />)

    expect(screen.getByRole("img", { name: "private-gateway" })).toHaveTextContent("P")
  })
})
