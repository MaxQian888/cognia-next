import definition, { manifest } from "./index"
import { createWorkbook } from "./model"
import { OFFICE_TOOL_NAMES } from "./tools"
import { exportWorkbookXlsx } from "./xlsx"

it("registers the workbook renderer, XLSX importer, translations, and all Office tools", async () => {
  const registerTool = jest.fn()
  const registerRenderer = jest.fn(() => jest.fn())
  const registerImporter = jest.fn((_registration: unknown) => jest.fn())
  const registerTranslations = jest.fn()
  await definition.activate?.({
    pluginId: "cognia-office",
    artifact: { registerRenderer },
    agent: { registerTool },
    import: { registerImporter },
    i18n: { registerTranslations, t: (key: string) => key },
    logger: { info: jest.fn() },
  } as never)
  expect(manifest.id).toBe("cognia-office")
  expect(registerRenderer).toHaveBeenCalledWith(
    "cognia-office/workbook",
    expect.objectContaining({ mount: expect.any(Function) })
  )
  expect(registerImporter).toHaveBeenCalledWith(
    expect.objectContaining({ id: "xlsx", extensions: ["xlsx"] })
  )
  const importer = registerImporter.mock.calls[0]?.[0] as unknown as {
    import: (source: {
      content: string | ArrayBuffer
      filename?: string
    }) => Promise<{ success: boolean; data?: unknown; error?: string }>
  }
  await expect(importer.import({ content: "not binary" })).resolves.toMatchObject({
    success: false,
  })
  const bytes = await exportWorkbookXlsx(createWorkbook("Imported"))
  const content = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(content).set(bytes)
  await expect(importer.import({ content, filename: "imported.xlsx" })).resolves.toMatchObject({
    success: true,
    data: expect.objectContaining({
      title: "imported",
      sourceFilename: "imported.xlsx",
    }),
  })
  await expect(
    importer.import({
      content: Uint8Array.from([0x50, 0x4b, 0x03, 0x04]).buffer,
      filename: "broken.xlsx",
    })
  ).resolves.toMatchObject({ success: false, error: expect.any(String) })
  expect(new Set(registerTool.mock.calls.map(([tool]) => tool.name))).toEqual(
    new Set(OFFICE_TOOL_NAMES)
  )
  expect(registerTranslations).toHaveBeenCalledTimes(2)
})
