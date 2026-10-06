module.exports = {
  rootDir: __dirname,
  testEnvironment: "node",
  testMatch: ["<rootDir>/src/**/*.test.ts"],
  clearMocks: true,
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { tsconfig: "<rootDir>/tsconfig.json", diagnostics: true }],
  },
  moduleNameMapper: {
    "^@cognia/agent-contracts$": "<rootDir>/../agent-contracts/src/index.ts",
    "^@cognia/agent-contracts/(.*)$": "<rootDir>/../agent-contracts/src/$1",
    "^@cognia/agent-runtime-kit$": "<rootDir>/../agent-runtime-kit/src/index.ts",
    "^@cognia/agent-runtime-kit/(.*)$": "<rootDir>/../agent-runtime-kit/src/$1",
  },
}
