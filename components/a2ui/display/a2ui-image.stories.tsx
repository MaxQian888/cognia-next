import type { Meta, StoryObj, Decorator } from "@storybook/nextjs"

import { A2UIImage } from "./a2ui-image"
import { A2UIProvider } from "@/components/a2ui/a2ui-context"
import type { A2UIImageComponent } from "@/types/a2ui/schema"
import { makeA2UIProps } from "@/lib/storybook/fixtures/a2ui"

// Inline SVG data URI so next/image renders unoptimized without remote-domain config.
const SAMPLE_SRC =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200">' +
      '<rect width="100%" height="100%" fill="#6366f1"/>' +
      '<text x="50%" y="50%" fill="white" font-size="22" text-anchor="middle" ' +
      'dominant-baseline="middle" font-family="sans-serif">A2UI Image</text></svg>'
  )

const image = (over: Partial<A2UIImageComponent> = {}): A2UIImageComponent => ({
  id: "image",
  component: "Image",
  src: SAMPLE_SRC,
  alt: "Sample illustration",
  width: 320,
  height: 200,
  ...over,
})

const withA2UI: Decorator = (Story) => (
  <A2UIProvider surfaceId="story-surface" renderComponent={() => null}>
    <Story />
  </A2UIProvider>
)

const meta = {
  title: "A2UI/Display/Image",
  component: A2UIImage,
  decorators: [withA2UI],
  parameters: { layout: "centered" },
} satisfies Meta<typeof A2UIImage>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = { args: makeA2UIProps(image()) }

export const Contain: Story = {
  args: makeA2UIProps(image({ objectFit: "contain", width: 240, height: 240 })),
}

export const FixedSquare: Story = {
  args: makeA2UIProps(image({ width: 200, height: 200 })),
}

export const WithAspectRatio: Story = {
  args: makeA2UIProps(image({ width: 320, height: undefined, aspectRatio: "16 / 9" })),
}

export const MissingSourcePlaceholder: Story = {
  args: makeA2UIProps(image({ src: "" })),
}

export const FallbackSource: Story = {
  args: makeA2UIProps(
    image({
      src: "",
      fallback:
        "data:image/svg+xml;utf8," +
        encodeURIComponent(
          '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200">' +
            '<rect width="100%" height="100%" fill="#94a3b8"/>' +
            '<text x="50%" y="50%" fill="white" font-size="20" text-anchor="middle" ' +
            'dominant-baseline="middle" font-family="sans-serif">Fallback</text></svg>'
        ),
    })
  ),
}
