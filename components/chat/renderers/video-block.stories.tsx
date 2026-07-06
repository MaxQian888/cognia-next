import type { Meta, StoryObj } from "@storybook/nextjs"

import { VideoBlock } from "./video-block"

const POSTER =
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='640' height='360'>
       <rect width='100%' height='100%' fill='#0f172a'/>
       <text x='50%' y='50%' fill='#94a3b8' font-size='28' text-anchor='middle' dy='.3em'>Poster frame</text>
     </svg>`
  )

const meta = {
  title: "Chat/Renderers/VideoBlock",
  component: VideoBlock,
  args: { src: "https://example.com/clip.mp4", poster: POSTER },
  parameters: { layout: "padded" },
} satisfies Meta<typeof VideoBlock>

export default meta
type Story = StoryObj<typeof meta>

// Native <video> element with a poster and the hover control overlay.
export const NativeVideo: Story = {}

export const WithCaption: Story = {
  args: { title: "Demo recording — workflow editor" },
}

// A YouTube URL is detected and rendered as an embedded iframe.
export const YouTubeEmbed: Story = {
  args: {
    src: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    title: "Embedded YouTube clip",
  },
}

// A Vimeo URL → Vimeo player iframe.
export const VimeoEmbed: Story = {
  args: { src: "https://vimeo.com/76979871", title: "Embedded Vimeo clip" },
}
