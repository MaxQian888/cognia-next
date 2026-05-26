import "@testing-library/jest-dom/vitest"

// jsdom doesn't implement object URLs; the backup download path needs them.
if (typeof URL.createObjectURL !== "function") {
  URL.createObjectURL = () => "blob:mock"
  URL.revokeObjectURL = () => {}
}
