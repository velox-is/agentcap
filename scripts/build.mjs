import { chmodSync, cpSync, mkdirSync, rmSync } from 'node:fs';
import { build } from 'esbuild';

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });

await build({
  entryPoints: ['src/cli/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: 'dist/cli.js',
  // better-sqlite3 is native, so it can never be bundled. js-tiktoken is 5.6 MB
  // of inlined rank tables; leaving it external keeps the tarball in the low
  // hundreds of KB instead of 2.6 MB, and npm resolves it as a normal dependency.
  external: ['better-sqlite3', 'js-tiktoken'],
  banner: { js: '#!/usr/bin/env node' },
  sourcemap: true,
});

chmodSync('dist/cli.js', 0o755);
cpSync('src/store/migrations', 'dist/migrations', { recursive: true });
cpSync('assets', 'dist/assets', { recursive: true });
console.log('built dist/cli.js');
