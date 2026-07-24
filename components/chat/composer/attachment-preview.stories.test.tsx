/**
 * @jest-environment jsdom
 */

jest.mock("storybook/test", () => ({ fn: () => jest.fn() }))

import meta, {
  ImageAndDocument,
  WithOcrHandlers,
  WithTokenBadge,
} from "./attachment-preview.stories"

describe("AttachmentPreview stories", () => {
  it("keeps the mixed-media and token-badge scenarios wired through decorators", () => {
    expect(meta.component).toBeDefined()
    expect(ImageAndDocument.decorators).toHaveLength(1)
    expect(WithTokenBadge.decorators).toHaveLength(1)
  })

  it("wires every OCR action into the OCR scenario", () => {
    expect(WithOcrHandlers.decorators).toHaveLength(1)
    expect(WithOcrHandlers.args).toMatchObject({
      onRunOcr: expect.any(Function),
      onExtractOcrToInput: expect.any(Function),
      onViewOcrDetail: expect.any(Function),
    })
  })
})
