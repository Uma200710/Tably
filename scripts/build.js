import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';

const output = '.build/functions/api.mjs';
await mkdir(path.resolve('.build/functions'), { recursive: true });
await build({
  entryPoints: [path.resolve('netlify/functions/api.js')],
  outfile: path.resolve(output),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
});
console.log(`Netlify API function compiled to ${output}`);
