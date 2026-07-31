import type { Meta, StoryObj } from "@storybook/nextjs-vite"

import { ImageBlock } from "./image-block"

// Inline SVG data URI so the story needs no network.
const SAMPLE_SRC =
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='320' height='180'>
       <rect width='100%' height='100%' fill='#4f46e5'/>
       <text x='50%' y='50%' fill='white' font-size='24' text-anchor='middle' dy='.3em'>Sample image</text>
     </svg>`
  )

const meta = {
  title: "Chat/Renderers/ImageBlock",
  component: ImageBlock,
  args: { src: SAMPLE_SRC, alt: "A sample image" },
  parameters: { layout: "padded" },
} satisfies Meta<typeof ImageBlock>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const WithCaption: Story = {
  args: { title: "Figure 1 — the rendered diagram" },
}

// A bad src trips the error/fallback state.
export const BrokenImage: Story = {
  args: { src: "https://invalid.example/does-not-exist.png", alt: "Missing diagram" },
}
