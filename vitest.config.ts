import { defineConfig } from 'vitest/config';
import path from 'node:path';

const r = (p: string) => path.resolve(process.cwd(), p);

export default defineConfig({
  resolve: {
    alias: {
      '@radovin/contracts': r('packages/contracts/src/index.ts'),
      '@radovin/observability': r('packages/observability/src/index.ts'),
      '@radovin/domain': r('packages/domain/src/index.ts'),
      '@radovin/extraction': r('packages/extraction/src/index.ts'),
      '@radovin/crawler-core': r('packages/crawler-core/src/index.ts'),
      '@radovin/adapters': r('packages/adapters/src/index.ts'),
      '@radovin/db': r('packages/db/src/index.ts'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    globals: false,
    testTimeout: 20000,
    // Az e2e fajlok ugyanazt a TEST_DATABASE_URL adatbazist hasznaljak, es
    // mindegyik a sajat tablait uriti ki az elejen - parhuzamosan egymas
    // alol huznak ki a sorokat.
    fileParallelism: !process.env['TEST_DATABASE_URL'],
  },
});
