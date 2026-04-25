import type { JestConfigWithTsJest } from "ts-jest";

/**
 * Jest is invoked from CI with `--shard=<k>/${JEST_SHARD_COUNT}` (see `.github/workflows/test.yml`),
 * so each of four parallel jobs runs a disjoint subset of test files. Keep `maxWorkers: 1` in CI
 * so a single process work-steals within the shard and memory stays bounded across matrix jobs.
 */
export const JEST_SHARD_COUNT = 4 as const;

const isCi = process.env.CI === "true";

const config: JestConfigWithTsJest = {
  // ESM + ts-jest (no preset here so a single `transform` block can pass `tsconfig`)
  testEnvironment: "node",
  roots: ["<rootDir>/tests"],
  testMatch: [
    "<rootDir>/tests/unit/**/*.test.ts",
    "<rootDir>/tests/integration/**/*.test.ts",
    "<rootDir>/tests/e2e/**/*.test.ts",
  ],
  extensionsToTreatAsEsm: [".ts"],
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  transform: {
    "^.+\\.ts$": [
      "ts-jest",
      {
        useESM: true,
        tsconfig: "tsconfig.test.json",
      },
    ],
  },
  maxWorkers: isCi ? 1 : "50%",
  clearMocks: true,
};

export default config;
