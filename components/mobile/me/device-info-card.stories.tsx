import type { Meta, StoryObj } from "@storybook/nextjs"

import { DeviceInfoCard, type DeviceInfoCardProps } from "./device-info-card"

// `DeviceInfoCard` reads app/device/permission info through injectable loaders
// (the production loaders call Capacitor plugins that no-op in the Storybook
// browser). The stories feed realistic loader results to exercise the rich
// hardware + permission rows without a device. Action seams (request / open
// settings / verify) keep their defaults — they fire only on tap, not render.
const meta = {
  title: "Mobile/Me/DeviceInfoCard",
  component: DeviceInfoCard,
  parameters: { layout: "fullscreen" },
  args: {
    appInfoLoader: async () => ({ version: "1.4.2", build: "320" }),
  },
  decorators: [
    (Story) => (
      <div className="mx-auto h-[760px] w-[390px] overflow-y-auto border p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<DeviceInfoCardProps>

export default meta
type Story = StoryObj<typeof meta>

export const FullDevice: Story = {
  args: {
    deviceInfoLoader: async () => ({
      platform: "ios",
      model: "iPhone 15 Pro",
      manufacturer: "Apple",
      operatingSystem: "iOS",
      osVersion: "17.4",
      webViewVersion: "17.4",
      isVirtual: false,
      memUsed: 512 * 1024 * 1024,
      realDiskFree: 24 * 1024 * 1024 * 1024,
      realDiskTotal: 128 * 1024 * 1024 * 1024,
      batteryLevel: 0.82,
      isCharging: true,
      languageCode: "en",
    }),
    permissionsLoader: async () => ({
      biometric: "available",
      biometryType: "Face ID",
      localNotifications: "granted",
    }),
  },
}

export const PromptForNotifications: Story = {
  args: {
    deviceInfoLoader: async () => ({
      platform: "android",
      model: "Pixel 8",
      manufacturer: "Google",
      operatingSystem: "Android",
      osVersion: "14",
    }),
    permissionsLoader: async () => ({
      biometric: "unavailable",
      localNotifications: "prompt",
    }),
  },
}

export const Unsupported: Story = {
  args: {
    deviceInfoLoader: async () => null,
    permissionsLoader: async () => ({ biometric: "unsupported", localNotifications: "unsupported" }),
  },
}
