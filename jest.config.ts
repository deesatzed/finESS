import type { Config } from "jest";

const config: Config = {
  preset: "ts-jest",
  testEnvironment: "node",
  setupFiles: ["<rootDir>/jest.setup.cjs"],
  roots: ["<rootDir>/__tests__"],
  testPathIgnorePatterns: ["/node_modules/", "test-fixtures\\.ts$"],
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/$1",
  },
  // A5: ts-jest transform with a JSX-aware override so `.tsx` test files
  // (and the `.tsx` modules they import — SemanticPanel and friends) can
  // compile. The project tsconfig sets `jsx: "preserve"` for Next.js's
  // own build pipeline; Jest needs an actually-compiled JSX target.
  // `react-jsx` is the modern automatic runtime so test files do not
  // have to import React themselves. The override does NOT mutate the
  // shared tsconfig — it only applies inside Jest.
  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        tsconfig: {
          jsx: "react-jsx",
          esModuleInterop: true,
          module: "commonjs",
          target: "es2017",
          moduleResolution: "node",
          resolveJsonModule: true,
          strict: true,
          isolatedModules: true,
          baseUrl: ".",
          paths: { "@/*": ["./*"] },
        },
      },
    ],
  },
  collectCoverageFrom: [
    "lib/**/*.{ts,tsx}",
    "app/api/**/*.{ts,tsx}",
    "!**/*.d.ts",
    "!**/__tests__/**",
  ],
  coverageThreshold: {
    // Globals are regression gates pinned at current measured coverage with
    // a small noise buffer. Per-file gates below tighten this for the
    // high-traffic correctness files. Lift any threshold once the
    // corresponding file genuinely improves; do not weaken to mask a
    // regression.
    global: {
      statements: 84,
      branches: 72,
      functions: 89,
      lines: 84,
    },
    // M8-06: per-file regression gates on the high-traffic correctness files
    // (semantic validator, DAG executor, multi-proposer pool, OpenRouter
    // client wrapper). Thresholds are pinned at current coverage minus a
    // small buffer for run-to-run noise. They catch regressions without
    // forcing premature test-writing for already well-covered files. Lift
    // any threshold once the corresponding file genuinely improves.
    "./lib/ai/parse-response.ts": {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    "./lib/engine/dag-executor.ts": {
      statements: 100,
      branches: 95,
      functions: 100,
      lines: 100,
    },
    "./lib/ai/multi-proposer.ts": {
      statements: 92,
      branches: 78,
      functions: 100,
      lines: 92,
    },
    "./lib/ai/openrouter-client.ts": {
      statements: 84,
      branches: 74,
      functions: 92,
      lines: 88,
    },
  },
};

export default config;
