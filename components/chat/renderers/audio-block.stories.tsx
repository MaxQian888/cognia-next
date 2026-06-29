import type { Meta, StoryObj } from "@storybook/nextjs"

import { AudioBlock } from "./audio-block"

// Tiny silent WAV data URI so the player has a real <audio> source without
// hitting the network. Metadata is short; controls render immediately.
const SILENT_WAV =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA="

const COVER =
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64'>
       <rect width='100%' height='100%' fill='#7c3aed'/>
       <text x='50%' y='52%' fill='white' font-size='28' text-anchor='middle' dy='.3em'>♪</text>
     </svg>`
  )

const meta = {
  title: "Chat/Renderers/AudioBlock",
  component: AudioBlock,
  args: { src: SILENT_WAV },
  parameters: { layout: "padded" },
} satisfies Meta<typeof AudioBlock>

export default meta
type Story = StoryObj<typeof meta>

// Bare player — no metadata, placeholder note icon for the cover.
export const Default: Story = {}

// Full track metadata + custom cover art.
export const WithMetadata: Story = {
  args: {
    title: "Nocturne in E-flat major",
    artist: "Frédéric Chopin",
    album: "Op. 9 No. 2",
    cover: COVER,
  },
}

// Download affordance hidden (e.g. ephemeral / DRM source).
export const NoDownload: Story = {
  args: { title: "Voice memo", showDownload: false },
}

// A bad src trips the dashed "failed to load" fallback.
export const FailedToLoad: Story = {
  args: { src: "https://invalid.example/missing.mp3", title: "Unavailable clip" },
}
