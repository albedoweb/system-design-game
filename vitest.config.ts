import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * Test files that each take more than five seconds because they run the real
 * simulation engines end to end. Together they are about fifteen minutes of
 * work; the other ~135 files take well under one. `npm test` runs everything;
 * `npm run test:fast` (used in CI) skips these.
 *
 * `src/cart/__tests__/observation-load.test.ts` is deliberately NOT listed:
 * it is the one end-to-end check kept in the fast set — the reference design
 * must pass both scenarios on the real engine.
 */
const HEAVY_TESTS = [
  'src/app/App.test.tsx',
  'src/cart/__tests__/basic-fault-free.test.ts',
  'src/cart/__tests__/basic-level.test.ts',
  'src/cart/__tests__/basic-reference.test.ts',
  'src/cart/__tests__/boundary.test.ts',
  'src/cart/__tests__/content-identity.test.ts',
  'src/cart/__tests__/evaluation.test.ts',
  'src/cart/__tests__/model-cpu.test.ts',
  'src/cart/__tests__/probe-oracle.test.ts',
  'src/cart/__tests__/qualification-gates.test.ts',
  'src/cart/__tests__/session-telemetry.test.ts',
  'src/cart/__tests__/telemetry.test.ts',
  'src/cart/__tests__/workload-desync.test.ts',
  'src/cart/__tests__/workload.test.ts',
  'src/cart/worker/cartRuntime.test.ts',
  'src/engine/__tests__/simulation.test.ts',
  'src/images/__tests__/evaluation.test.ts',
  'src/images/__tests__/traffic.test.ts',
  'src/parcel/__tests__/cli.test.ts',
  'src/parcel/__tests__/evaluation.test.ts',
  'src/parcel/__tests__/result-schema.test.ts',
  'src/simulation/__tests__/registry.test.ts',
];

const fast = process.env.VITEST_FAST === '1';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./src/app/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: ['node_modules/**', 'dist/**', 'tests/smoke/**', ...(fast ? HEAVY_TESTS : [])],
    // CI runners are slower and run files in parallel; give the fast set headroom.
    testTimeout: fast ? 20_000 : 5_000,
    restoreMocks: true,
    clearMocks: true,
  },
});
