module.exports = {
  rootDir: __dirname,
  testEnvironment: "node",
  testMatch: ["<rootDir>/src/**/*.test.ts"],
  clearMocks: true,
  transform: {
    "^.+\\.tsx?$": [
      "@swc/jest",
      {
        jsc: {
          target: "es2022",
          parser: { syntax: "typescript", tsx: true },
          transform: { react: { runtime: "automatic" } },
        },
        module: { type: "commonjs" },
      },
    ],
  },
  moduleNameMapper: {
    "^@cognia/agent-contracts$": "<rootDir>/../agent-contracts/src/index.ts",
    "^@cognia/agent-contracts/(.*)$": "<rootDir>/../agent-contracts/src/$1",
    "^@cognia/agent-runtime-kit$": "<rootDir>/../agent-runtime-kit/src/index.ts",
    "^@cognia/agent-runtime-kit/(.*)$": "<rootDir>/../agent-runtime-kit/src/$1",
  },
}
