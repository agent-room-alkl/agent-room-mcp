#!/usr/bin/env node
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const here = dirname(fileURLToPath(import.meta.url));
const child = spawn('node', ['--import', 'tsx', join(here, 'src/index.ts')], {
  stdio: 'inherit',
  env: process.env,
});
child.on('exit', code => process.exit(code ?? 0));
