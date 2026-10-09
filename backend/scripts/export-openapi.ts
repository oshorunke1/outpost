// Writes contracts/openapi.yaml from the route schemas, or with --check fails if the committed
// file is stale or missing. It builds the app on in-memory fakes, so it needs no database.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkContract, renderContract } from './openapiContract.js';

// --target <path> points at another file. The tests use it so they never touch the real contract.
const targetFlag = process.argv.indexOf('--target');
const target = targetFlag === -1 ? fileURLToPath(new URL('../../contracts/openapi.yaml', import.meta.url)) : process.argv[targetFlag + 1];
if (!target) {
  console.error('--target needs a file path');
  process.exit(2);
}
const yaml = await renderContract();

if (process.argv.includes('--check')) {
  const result = checkContract(target, yaml);
  if (result.ok) {
    console.log(result.message);
  } else {
    console.error(result.message);
    process.exitCode = 1;
  }
} else {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, yaml);
  console.log('wrote contracts/openapi.yaml');
}
