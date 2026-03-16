#!/usr/bin/env npx tsx

/**
 * Sync Cloudflare fields and functions from the official cloudflare-docs repo.
 *
 * Sources:
 *   Fields:    github.com/cloudflare/cloudflare-docs/src/content/fields/index.yaml
 *   Functions: github.com/cloudflare/cloudflare-docs/src/content/docs/ruleset-engine/rules-language/functions.mdx
 *
 * All changes are applied to the local schema files. The GitHub Actions
 * workflow runs this with --apply and opens a PR for review.
 *
 * Usage:
 *   npx tsx scripts/sync-cloudflare-docs.ts           # Dry run (report only)
 *   npx tsx scripts/sync-cloudflare-docs.ts --apply    # Apply all changes
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIELDS_TS_PATH = resolve(__dirname, '../src/schemas/fields.ts');

const BASE_URL = 'https://raw.githubusercontent.com/cloudflare/cloudflare-docs/production';
const FIELDS_YAML_URL = `${BASE_URL}/src/content/fields/index.yaml`;
const FUNCTIONS_MDX_URL = `${BASE_URL}/src/content/docs/ruleset-engine/rules-language/functions.mdx`;

// ── Type Mapping ─────────────────────────────────────────────────────

// Cloudflare docs use "Number" as a generic numeric type. In the
// expression engine these behave as integers for comparison purposes.
// We map Number → Integer except for known float fields.
const TYPE_MAP: Record<string, string> = {
  'String': 'String',
  'Integer': 'Integer',
  'Number': 'Integer',
  'Boolean': 'Boolean',
  'Bytes': 'Bytes',
  'IP address': 'IP',
  'Array<String>': 'Array',
  'Array<Integer>': 'Array',
  'Array<Number>': 'Array',
  'Array<Array<String>>': 'Array',
  'Map<Array<String>>': 'Map',
  'Map<Array<Integer>>': 'Map',
  'Map<Number>': 'Map',
};

const FLOAT_FIELDS = new Set(['ip.src.lat', 'ip.src.lon']);

// ── Interfaces ───────────────────────────────────────────────────────

interface CloudflareField {
  name: string;
  data_type: string;
  categories: string[];
  summary: string;
  plan_info_label?: string;
}

interface LocalField {
  name: string;
  type: string;
  deprecated?: boolean;
  replacement?: string;
}

interface ParsedFunction {
  name: string;
  returnType: string;
}

interface SyncSummary {
  fieldsAdded: string[];
  fieldsDeprecated: string[];
  fieldsTypeChanged: string[];
  functionsAdded: string[];
  functionsRemoved: string[];
}

// ── Fetch ────────────────────────────────────────────────────────────

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status}`);
  return response.text();
}

async function fetchCloudflareFields(): Promise<CloudflareField[]> {
  console.log('Fetching fields from Cloudflare docs...');
  const yamlText = await fetchText(FIELDS_YAML_URL);
  const parsed = parseYaml(yamlText) as { entries: CloudflareField[] };
  console.log(`  Found ${parsed.entries.length} fields`);
  return parsed.entries;
}

async function fetchCloudflareFunctions(): Promise<ParsedFunction[]> {
  console.log('Fetching functions from Cloudflare docs...');
  const mdx = await fetchText(FUNCTIONS_MDX_URL);
  const functions = parseFunctionsMdx(mdx);
  console.log(`  Found ${functions.length} functions`);
  return functions;
}

// ── MDX Parsing ──────────────────────────────────────────────────────

function parseFunctionsMdx(mdx: string): ParsedFunction[] {
  const functions: ParsedFunction[] = [];

  // Split on ### ` headings — each is a function
  const sections = mdx.split(/^### `/m);

  for (const section of sections.slice(1)) {
    // Function name is everything before the closing backtick
    const nameMatch = section.match(/^([a-z_][a-z0-9_]*)`/);
    if (!nameMatch) continue;

    const name = nameMatch[1];

    // Return type is in <Type text="..." /> after the signature line
    // Pattern: ): <Type text="ReturnType" />
    const returnTypeMatch = section.match(/\).*?<Type\s+text="([^"]+)"/);
    const returnType = returnTypeMatch ? mapMdxType(returnTypeMatch[1]) : 'String';

    functions.push({ name, returnType });
  }

  return functions;
}

function mapMdxType(mdxType: string): string {
  const map: Record<string, string> = {
    'String': 'String',
    'Integer': 'Integer',
    'Number': 'Integer',
    'Boolean': 'Boolean',
    'Bytes': 'Bytes',
    'IP address': 'IP',
    'IP Address': 'IP',
    'Array': 'Array',
    'Map': 'Map',
  };
  return map[mdxType] || 'String';
}

// ── Local Schema Parsing ─────────────────────────────────────────────

function parseLocalFields(): LocalField[] {
  const content = readFileSync(FIELDS_TS_PATH, 'utf-8');
  const fields: LocalField[] = [];
  const fieldRegex = /\{\s*name:\s*'([^']+)',\s*type:\s*'([^']+)'(?:,\s*deprecated:\s*(true))?(?:,\s*replacement:\s*'([^']+)')?/g;
  let match;
  while ((match = fieldRegex.exec(content)) !== null) {
    fields.push({
      name: match[1],
      type: match[2],
      deprecated: match[3] === 'true' || undefined,
      replacement: match[4] || undefined,
    });
  }
  console.log(`  Found ${fields.length} local fields`);
  return fields;
}

function parseLocalFunctions(): string[] {
  const content = readFileSync(
    resolve(__dirname, '../src/schemas/functions.ts'),
    'utf-8',
  );
  const names: string[] = [];
  // Match top-level function entries: lines starting with "  {" followed by name:
  // This avoids matching parameter name: fields which are nested deeper
  const regex = /^\s{2}\{\s*\n\s+name:\s*'([^']+)'/gm;
  let match;
  while ((match = regex.exec(content)) !== null) {
    names.push(match[1]);
  }
  console.log(`  Found ${names.length} local functions`);
  return names;
}

// ── Comparison ───────────────────────────────────────────────────────

function resolveType(cf: CloudflareField): string {
  if (FLOAT_FIELDS.has(cf.name) && cf.data_type === 'Number') return 'Float';
  return TYPE_MAP[cf.data_type] || cf.data_type;
}

function compareFields(
  cfFields: CloudflareField[],
  localFields: LocalField[],
): { added: CloudflareField[]; deprecated: LocalField[]; typeChanged: { name: string; from: string; to: string }[] } {
  const cfMap = new Map(cfFields.map(f => [f.name, f]));
  const localMap = new Map(localFields.map(f => [f.name, f]));

  const added: CloudflareField[] = [];
  const deprecated: LocalField[] = [];
  const typeChanged: { name: string; from: string; to: string }[] = [];

  for (const cf of cfFields) {
    if (!localMap.has(cf.name)) {
      added.push(cf);
    } else {
      const local = localMap.get(cf.name)!;
      const expectedType = resolveType(cf);
      if (local.type !== expectedType) {
        typeChanged.push({ name: cf.name, from: local.type, to: expectedType });
      }
    }
  }

  // Fields in our schema not in docs (and not already deprecated)
  for (const local of localFields) {
    if (!cfMap.has(local.name) && !local.deprecated) {
      deprecated.push(local);
    }
  }

  return { added, deprecated, typeChanged };
}

function compareFunctions(
  cfFunctions: ParsedFunction[],
  localFunctions: string[],
): { added: ParsedFunction[]; removed: string[] } {
  const cfSet = new Set(cfFunctions.map(f => f.name));
  const localSet = new Set(localFunctions);

  const added = cfFunctions.filter(f => !localSet.has(f.name));
  const removed = localFunctions.filter(f => !cfSet.has(f));

  return { added, removed };
}

// ── Apply Changes ────────────────────────────────────────────────────

function applyFieldChanges(
  added: CloudflareField[],
  deprecated: LocalField[],
  typeChanged: { name: string; from: string; to: string }[],
): void {
  let content = readFileSync(FIELDS_TS_PATH, 'utf-8');

  // Add new fields before the closing of the FIELDS array
  if (added.length > 0) {
    const newEntries = added
      .map(cf => `  { name: '${cf.name}', type: '${resolveType(cf)}' },`)
      .join('\n');
    const marker = '/** Build a lookup map for fast field resolution */';
    const idx = content.indexOf(marker);
    if (idx === -1) {
      console.error('Could not find insertion point in fields.ts');
      return;
    }
    const syncComment = `  // ── Auto-synced from Cloudflare docs (${today()}) ──────────\n`;
    content = content.substring(0, idx - 3) + '\n' + syncComment + newEntries + '\n];\n\n' + content.substring(idx);
  }

  // Mark removed fields as deprecated
  for (const local of deprecated) {
    const pattern = `{ name: '${local.name}', type: '${local.type}' }`;
    const replacement = `{ name: '${local.name}', type: '${local.type}', deprecated: true, notes: 'Removed from Cloudflare docs ${today()}' }`;
    content = content.replace(pattern, replacement);
  }

  // Update changed types
  for (const change of typeChanged) {
    // Only update if it's a simple entry without other properties
    const pattern = `name: '${change.name}', type: '${change.from}'`;
    const replacement = `name: '${change.name}', type: '${change.to}'`;
    content = content.replace(pattern, replacement);
  }

  writeFileSync(FIELDS_TS_PATH, content, 'utf-8');
}

function today(): string {
  return new Date().toISOString().split('T')[0];
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  const applyMode = process.argv.includes('--apply');

  // Fetch from Cloudflare docs
  const [cfFields, cfFunctions] = await Promise.all([
    fetchCloudflareFields(),
    fetchCloudflareFunctions(),
  ]);

  // Parse local schemas
  const localFields = parseLocalFields();
  const localFunctions = parseLocalFunctions();

  // Compare
  const fieldDiff = compareFields(cfFields, localFields);
  const funcDiff = compareFunctions(cfFunctions, localFunctions);

  const summary: SyncSummary = {
    fieldsAdded: fieldDiff.added.map(f => f.name),
    fieldsDeprecated: fieldDiff.deprecated.map(f => f.name),
    fieldsTypeChanged: fieldDiff.typeChanged.map(c => `${c.name}: ${c.from} → ${c.to}`),
    functionsAdded: funcDiff.added.map(f => f.name),
    functionsRemoved: funcDiff.removed,
  };

  // Report
  console.log('\n── Sync Results ────────────────────────────────────────');

  const totalChanges =
    summary.fieldsAdded.length +
    summary.fieldsDeprecated.length +
    summary.fieldsTypeChanged.length +
    summary.functionsAdded.length +
    summary.functionsRemoved.length;

  if (totalChanges === 0) {
    console.log('\n✓ All schemas are up to date with Cloudflare docs');
    process.exit(0);
  }

  if (summary.fieldsAdded.length > 0) {
    console.log(`\n+ ${summary.fieldsAdded.length} new field(s):`);
    for (const name of summary.fieldsAdded) console.log(`    ${name}`);
  }

  if (summary.fieldsDeprecated.length > 0) {
    console.log(`\n⚠ ${summary.fieldsDeprecated.length} field(s) to deprecate (removed from docs):`);
    for (const name of summary.fieldsDeprecated) console.log(`    ${name}`);
  }

  if (summary.fieldsTypeChanged.length > 0) {
    console.log(`\n~ ${summary.fieldsTypeChanged.length} field type change(s):`);
    for (const desc of summary.fieldsTypeChanged) console.log(`    ${desc}`);
  }

  if (summary.functionsAdded.length > 0) {
    console.log(`\n+ ${summary.functionsAdded.length} new function(s):`);
    for (const name of summary.functionsAdded) console.log(`    ${name}`);
  }

  if (summary.functionsRemoved.length > 0) {
    console.log(`\n⚠ ${summary.functionsRemoved.length} function(s) not found in docs:`);
    for (const name of summary.functionsRemoved) console.log(`    ${name}`);
  }

  if (!applyMode) {
    console.log('\nRun with --apply to apply changes to schema files');
    process.exit(1);
  }

  // Apply field changes
  if (fieldDiff.added.length > 0 || fieldDiff.deprecated.length > 0 || fieldDiff.typeChanged.length > 0) {
    applyFieldChanges(fieldDiff.added, fieldDiff.deprecated, fieldDiff.typeChanged);
    console.log(`\n✓ Applied field changes to ${FIELDS_TS_PATH}`);
  }

  // Report function changes (manual for now — functions have complex signatures)
  if (funcDiff.added.length > 0) {
    console.log('\n⚠ New functions detected — add to src/schemas/functions.ts manually:');
    for (const f of funcDiff.added) {
      console.log(`    ${f.name}() → ${f.returnType}`);
    }
  }

  // Write summary for GitHub Actions PR body
  const summaryPath = resolve(__dirname, '../sync-summary.md');
  const summaryMd = [
    '## Cloudflare Docs Sync',
    '',
    `Synced on ${today()} from [cloudflare/cloudflare-docs](https://github.com/cloudflare/cloudflare-docs).`,
    '',
    summary.fieldsAdded.length > 0 ? `### New Fields (${summary.fieldsAdded.length})\n${summary.fieldsAdded.map(n => `- \`${n}\``).join('\n')}` : '',
    summary.fieldsDeprecated.length > 0 ? `### Deprecated Fields (${summary.fieldsDeprecated.length})\n${summary.fieldsDeprecated.map(n => `- \`${n}\``).join('\n')}` : '',
    summary.fieldsTypeChanged.length > 0 ? `### Type Changes (${summary.fieldsTypeChanged.length})\n${summary.fieldsTypeChanged.map(d => `- ${d}`).join('\n')}` : '',
    summary.functionsAdded.length > 0 ? `### New Functions (${summary.functionsAdded.length})\n${summary.functionsAdded.map(n => `- \`${n}()\``).join('\n')}\n\n> These need to be added to \`src/schemas/functions.ts\` manually.` : '',
    summary.functionsRemoved.length > 0 ? `### Functions Not In Docs (${summary.functionsRemoved.length})\n${summary.functionsRemoved.map(n => `- \`${n}()\``).join('\n')}` : '',
  ].filter(Boolean).join('\n\n');

  writeFileSync(summaryPath, summaryMd, 'utf-8');
  console.log(`\n✓ Wrote sync summary to ${summaryPath}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
