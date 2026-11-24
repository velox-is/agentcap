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
  external: ['better-sqlite3'],
  banner: { js: '#!/usr/bin/env node' },
  sourcemap: true,
});

chmodSync('dist/cli.js', 0o755);
cpSync('src/store/migrations', 'dist/migrations', { recursive: true });
cpSync('assets', 'dist/assets', { recursive: true });
console.log('built dist/cli.js');
