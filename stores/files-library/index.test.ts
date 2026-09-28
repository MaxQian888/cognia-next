import * as barrel from "./index"
import { useFilesLibraryStore } from "./files-library-store"

it("re-exports the Files store", () => {
  expect(barrel.useFilesLibraryStore).toBe(useFilesLibraryStore)
})
