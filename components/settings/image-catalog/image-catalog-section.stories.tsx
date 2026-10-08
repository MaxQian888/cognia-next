import type { Meta, StoryObj } from "@storybook/nextjs"

import type { ImageCatalogActions, ImageCatalogState } from "@/hooks/sandbox/use-image-catalog"
import type { CatalogEntryRecord } from "@/lib/project-environment/environment-client"

import { ImageCatalogView } from "./image-catalog-section"

/*
 * The page is reachable only on a host that runs the sandbox pool, so these
 * stories are where its layout can be looked at without one: a populated
 * catalog, a deployment with the pool switched off, and the narrow pane.
 */

const DIGEST = `sha256:${"a".repeat(64)}`

function entry(overrides: Partial<CatalogEntryRecord> = {}): CatalogEntryRecord {
  return {
    id: "node-22",
    scope: "tenant",
    label: "Node 22",
    description: "The team's Node toolchain with pnpm preinstalled.",
    image: { registry: "ghcr.io", repository: "acme/dev", digest: DIGEST, tag: "22" },
    isolationFloor: "container",
    sizeClassIds: ["small", "large"],
    imageUser: "node",
    source: "manual",
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  }
}

const actions: ImageCatalogActions = {
  reload: async () => {},
  inspect: async () => {
    throw new Error("not in a story")
  },
  save: async () => ({ ok: true }),
  revoke: async () => ({ ok: true }),
}

const READY: ImageCatalogState = {
  status: "ready",
  facts: {
    poolEnabled: true,
    multiTenant: true,
    floor: "gvisor",
    defaultEntryId: "default",
    sizeClasses: [
      {
        id: "small",
        label: "Small",
        cpuMillis: 2000,
        memoryMib: 4096,
        ephemeralStorageMib: 8192,
        volumeMib: 20480,
      },
      {
        id: "large",
        label: "Large",
        cpuMillis: 8000,
        memoryMib: 16384,
        ephemeralStorageMib: 32768,
        volumeMib: 102400,
      },
      {
        id: "gpu",
        label: "GPU",
        cpuMillis: 8000,
        memoryMib: 32768,
        ephemeralStorageMib: 1,
        volumeMib: 1,
        gpu: { count: 2, resourceName: "nvidia.com/gpu" },
      },
    ],
    egressPresets: [
      { id: "npm", label: "npm", domains: ["registry.npmjs.org"] },
      {
        id: "github",
        label: "GitHub",
        domains: ["github.com", "api.github.com", "codeload.github.com"],
      },
    ],
    bundle: {
      current: {
        registry: "ghcr.io",
        repository: "cognia/bundle",
        digest: DIGEST,
        releaseTag: "v2.0.0",
      },
      retained: [
        { registry: "ghcr.io", repository: "cognia/bundle", digest: DIGEST, releaseTag: "v1.9.0" },
      ],
    },
  },
  rows: [
    {
      entry: entry({
        id: "default",
        scope: "baseline",
        label: "Default runner",
        description: undefined,
        image: { registry: "docker.io", repository: "cognia/runner", tag: "latest" },
        imageUser: undefined,
        source: "legacy",
        sizeClassIds: ["small"],
      }),
      effectiveFloor: "gvisor",
      defaultEntry: true,
    },
    { entry: entry(), effectiveFloor: "gvisor", defaultEntry: false },
    {
      entry: entry({
        id: "python-312",
        label: "Python 3.12",
        description: undefined,
        imageUser: undefined,
      }),
      effectiveFloor: "gvisor",
      defaultEntry: false,
    },
  ],
  rejected: [
    { id: "evil", code: "catalog_registry_not_allowlisted", message: "evil.io is not allowlisted" },
  ],
  driver: {
    driver: "docker",
    deploymentId: "d",
    instanceId: "i",
    multiTenant: true,
    isolationFloor: "gvisor",
    availableTiers: ["container", "gvisor"],
    reachable: true,
    bundles: [],
  },
  busy: false,
}

const meta: Meta<typeof ImageCatalogView> = {
  title: "Settings/ImageCatalog",
  component: ImageCatalogView,
  parameters: { layout: "padded" },
}
export default meta

type Story = StoryObj<typeof ImageCatalogView>

export const Ready: Story = { args: { catalog: { ...READY, ...actions } } }

export const PoolOff: Story = {
  args: { catalog: { status: "pool-off", rows: [], rejected: [], busy: false, ...actions } },
}

export const Narrow: Story = {
  args: { catalog: { ...READY, ...actions } },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 360 }}>
        <Story />
      </div>
    ),
  ],
}
