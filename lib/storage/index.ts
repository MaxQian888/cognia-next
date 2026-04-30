// Public surface of the storage subsystem. The settings UI imports stats /
// cleanup helpers + types from here so we keep a single curated entry point.

export * from "./types"
export {
  CATEGORY_INFO,
  TABLE_TO_CATEGORY,
  categoryForTable,
  defaultDisplayName,
} from "./category-info"
export { StorageManager, StorageManagerImpl } from "./storage-manager"
export {
  cleanupCategories,
  clearCategory,
  deepCleanup,
  previewCleanup,
  quickCleanup,
  selectableCategories,
} from "./cleanup"
