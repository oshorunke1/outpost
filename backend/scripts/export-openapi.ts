// Writes contracts/openapi.yaml from the route schemas, or with --check fails if the committed
// file is stale or missing. It builds the app on in-memory fakes, so it needs no database.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkContract, renderContract } from './openapiContract.js';

const target = fileURLToPath(new URL('../../contracts/openapi.yaml', import.meta.url));
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
