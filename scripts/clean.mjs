import { rm } from 'node:fs/promises';
import { glob } from 'node:fs/promises';

const targets = ['packages/*/dist', 'apps/*/dist', 'apps/web/.next',
                 '**/*.tsbuildinfo'];
for (const pattern of targets) {
  for await (const entry of glob(pattern, { exclude: (p) => p.includes('node_modules') })) {
    await rm(entry, { recursive: true, force: true });
    process.stdout.write(`torolve: ${entry}\n`);
  }
}
