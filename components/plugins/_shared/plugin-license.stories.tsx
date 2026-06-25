import type { Meta, StoryObj } from "@storybook/nextjs-vite"

import { PluginLicense } from "./plugin-license"

// Shared license display: SPDX badge plus an optional expandable full-text
// LICENSE. Reused by the marketplace detail sheet, installed-plugin overview,
// and GitHub install preview. Stories cover the badge-only path, the
// expandable-text path, a custom (non-SPDX) license, and a long license body.

const SHORT_MIT = `MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files.`

const LONG_LICENSE = Array.from(
  { length: 8 },
  (_, i) =>
    `${i + 1}. Redistribution and use in source and binary forms, with or without modification, are permitted provided that the above copyright notice is retained.`
).join("\n\n")

const meta = {
  title: "Plugins/Shared/PluginLicense",
  component: PluginLicense,
  args: { license: "MIT" },
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-[420px] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PluginLicense>

export default meta
type Story = StoryObj<typeof meta>

// SPDX badge only — no captured text, so no view toggle.
export const BadgeOnly: Story = {}

// SPDX badge plus an expandable full LICENSE body (toggle visible).
export const WithText: Story = {
  args: { license: "Apache-2.0", licenseText: SHORT_MIT },
}

// No SPDX id, only captured text → labelled as a custom license.
export const CustomLicense: Story = {
  args: { license: undefined, licenseText: "All rights reserved.\nProprietary." },
}

// Long body to confirm the ScrollArea clamps the expanded text.
export const LongText: Story = {
  args: { license: "BSD-3-Clause", licenseText: LONG_LICENSE },
}
