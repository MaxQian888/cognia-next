import type { Meta, StoryObj } from "@storybook/nextjs-vite"

import { MessageImageGallery } from "./message-image-gallery"

function sampleImage(label: string, color: string): string {
  return `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="420" viewBox="0 0 640 420">
      <rect width="640" height="420" rx="32" fill="${color}"/>
      <circle cx="520" cy="92" r="54" fill="white" fill-opacity=".22"/>
      <path d="M0 330L180 180l126 105 92-74 242 209H0Z" fill="white" fill-opacity=".18"/>
      <text x="40" y="72" fill="white" font-family="system-ui" font-size="32" font-weight="650">${label}</text>
    </svg>`
  )}`
}

const items = [
  { id: "one", src: sampleImage("Product overview", "#4f46e5"), alt: "Product overview" },
  { id: "two", src: sampleImage("Dashboard", "#0f766e"), alt: "Dashboard" },
  { id: "three", src: sampleImage("Mobile flow", "#b45309"), alt: "Mobile flow" },
  { id: "four", src: sampleImage("Analytics", "#be123c"), alt: "Analytics" },
]

const meta = {
  title: "Chat/Renderers/MessageImageGallery",
  component: MessageImageGallery,
  args: { items },
  parameters: { layout: "padded" },
} satisfies Meta<typeof MessageImageGallery>

export default meta
type Story = StoryObj<typeof meta>

export const Gallery: Story = {}

export const SingleImage: Story = {
  args: { items: items.slice(0, 1) },
}
