import { readFileSync } from 'node:fs';
import { resolveTargets, blockedTargets, toolEndpoints, requiredInputs } from './src/lib/catalog.ts';
import type { Catalog, OutputKind, AssetKind } from './src/lib/catalog.ts';

const catalog: Catalog = JSON.parse(readFileSync('../public/catalog.json', 'utf8'));

const cases: Array<[OutputKind, AssetKind[]]> = [
  ['video', []],
  ['video', ['image']],
  ['video', ['video']],
  ['video', ['image', 'audio']],
  ['image', []],
  ['image', ['image']],
  ['audio', []],
  ['audio', ['audio']],
];

for (const [output, attach] of cases) {
  const targets = resolveTargets(catalog, output, new Set(attach));
  const paths = [...new Set(targets.map((t) => t.endpoint.path))];
  const label = `${output} + [${attach.join(',') || 'khong dinh kem'}]`;
  console.log(`${label.padEnd(30)} -> ${paths.join(', ') || '(khong co)'}  | ${targets.length} model`);
  if (targets.length && targets.length <= 20) {
    console.log(`   ${targets.map((t) => t.variant.model).join(' ')}`);
  }
  const blocked = blockedTargets(catalog, output, new Set(attach));
  if (blocked.size) {
    console.log(`   goi y: ${[...blocked].map(([k, n]) => `dinh ${k} -> mo khoa ${n} model`).join(' | ')}`);
  }
}

console.log('\nCong cu (khong suy ra duoc):');
for (const ep of toolEndpoints(catalog)) {
  const needs = [...requiredInputs(ep.models[0]!)].join(',') || 'khong';
  console.log(`   ${ep.title.padEnd(26)} can: ${needs}`);
}
