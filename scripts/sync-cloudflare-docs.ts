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
  params: { name: string; type: string; optional: boolean }[];
  returnType: string;
  contexts: string[];
  maxPerExpression?: number;
  noNestIn?: string[];
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
    const nameMatch = section.match(/^([a-z_][a-z0-9_]*)`/);
    if (!nameMatch) continue;

    const name = nameMatch[1];

    // Parse return type: ): <Type text="ReturnType" />
    const returnTypeMatch = section.match(/\).*?<\/code>:\s*<Type\s+text="([^"]+)"/);
    const returnType = returnTypeMatch ? mapMdxType(returnTypeMatch[1]) : 'String';

    // Parse params from <code> signature line
    // Pattern: name(param1 <Type text="T1" /> [, param2 <Type text="T2" />])
    const params = parseParams(section);

    // Parse context restrictions from :::note blocks
    const contexts = parseContexts(section);

    // Parse usage limits
    const maxPerExpression = parseMaxPerExpression(section, name);
    const noNestIn = parseNoNestIn(section, name);

    functions.push({ name, params, returnType, contexts, maxPerExpression, noNestIn });
  }

  return functions;
}

function parseParams(section: string): { name: string; type: string; optional: boolean }[] {
  const params: { name: string; type: string; optional: boolean }[] = [];

  // Find the <code>...</code> signature line
  const sigMatch = section.match(/<code>[^<]*\(([^)]*(?:\([^)]*\))*[^)]*)\)<\/code>/s);
  if (!sigMatch) return params;

  const sigBody = sigMatch[1];

  // Match each param: name <Type text="ParamType" />
  // Optional params are wrapped in [, ...]
  const paramRegex = /(\[?,?\s*)?(\w+)\s*<Type\s+text="([^"]+)"\s*\/>/g;
  let match;
  while ((match = paramRegex.exec(sigBody)) !== null) {
    const optional = (match[1] || '').includes('[');
    params.push({
      name: match[2],
      type: mapMdxType(match[3].split('|')[0].trim()),
      optional,
    });
  }

  return params;
}

function parseContexts(section: string): string[] {
  // Look for :::note blocks with context restrictions
  const noteMatch = section.match(/:::note\n([\s\S]*?):::/);
  if (!noteMatch) return ['all'];

  const note = noteMatch[1].toLowerCase();

  const contexts: string[] = [];

  if (note.includes('transform rules') || note.includes('header transform'))
    contexts.push('rewrite_url', 'rewrite_header');
  if (note.includes('custom rules') || note.includes('waf'))
    contexts.push('filter');
  if (note.includes('rate limiting'))
    contexts.push('filter');
  if (note.includes('dynamic url redirect') || note.includes('single redirects') || note.includes('url forwarding'))
    contexts.push('redirect_target');
  if (note.includes('rewrite expressions'))
    contexts.push('rewrite_url');
  if (note.includes('custom error'))
    contexts.push('rewrite_header');

  // Deduplicate
  return contexts.length > 0 ? [...new Set(contexts)] : ['all'];
}

function parseMaxPerExpression(section: string, name: string): number | undefined {
  if (section.includes(`only use the \`${name}()\` function once`)) return 1;
  return undefined;
}

function parseNoNestIn(section: string, name: string): string[] | undefined {
  const nestMatch = section.match(/cannot nest it with the \[`(\w+)\(\)`\]/);
  if (nestMatch) return [nestMatch[1]];
  return undefined;
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
): { added: ParsedFunction[]; notInDocs: string[] } {
  const cfSet = new Set(cfFunctions.map(f => f.name));
  const localSet = new Set(localFunctions);

  const added = cfFunctions.filter(f => !localSet.has(f.name));
  const notInDocs = localFunctions.filter(f => !cfSet.has(f));

  return { added, notInDocs };
}

function generateFunctionEntry(fn: ParsedFunction): string {
  const params = fn.params.map(p => {
    let entry = `{ name: '${p.name}', type: '${p.type}'`;
    if (p.optional) entry += ', optional: true';
    return entry + ' }';
  }).join(',\n        ');

  const contexts = fn.contexts.map(c => `'${c}'`).join(', ');

  let entry = `  {\n    name: '${fn.name}',\n    params: [\n        ${params}\n    ],\n    returnType: '${fn.returnType}',\n    contexts: [${contexts}],`;

  if (fn.maxPerExpression) {
    entry += `\n    maxPerExpression: ${fn.maxPerExpression},`;
  }
  if (fn.noNestIn && fn.noNestIn.length > 0) {
    entry += `\n    noNestIn: [${fn.noNestIn.map(n => `'${n}'`).join(', ')}],`;
  }

  entry += '\n  },';
  return entry;
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
    const markerIdx = content.indexOf(marker);
    if (markerIdx === -1) {
      console.error('Could not find insertion point in fields.ts');
      return;
    }
    // Find the `];` that closes the FIELDS array
    const beforeMarker = content.substring(0, markerIdx);
    const arrayEndIdx = beforeMarker.lastIndexOf('];');
    if (arrayEndIdx === -1) {
      console.error('Could not find FIELDS array end');
      return;
    }
    const syncComment = `\n  // ── Auto-synced from Cloudflare docs (${today()}) ──────────\n`;
    content = content.substring(0, arrayEndIdx) + syncComment + newEntries + '\n];\n' + content.substring(arrayEndIdx + 2);
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
    functionsRemoved: funcDiff.notInDocs,
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

  // Apply function additions
  if (funcDiff.added.length > 0) {
    const functionsPath = resolve(__dirname, '../src/schemas/functions.ts');
    let funcContent = readFileSync(functionsPath, 'utf-8');

    const newEntries = funcDiff.added.map(generateFunctionEntry).join('\n');
    // Find the end of the FUNCTIONS array: the last `];` before the lookup map
    const marker = '/** Build lookup map */';
    const markerIdx = funcContent.indexOf(marker);

    if (markerIdx !== -1) {
      // Find the `];` that closes the FUNCTIONS array (searching backwards from marker)
      const beforeMarker = funcContent.substring(0, markerIdx);
      const arrayEndIdx = beforeMarker.lastIndexOf('];');

      if (arrayEndIdx !== -1) {
        const syncComment = `\n  // ── Auto-synced from Cloudflare docs (${today()}) ──────────\n`;
        funcContent = funcContent.substring(0, arrayEndIdx) + syncComment + newEntries + '\n];\n' + funcContent.substring(arrayEndIdx + 2);
        writeFileSync(functionsPath, funcContent, 'utf-8');
        console.log(`\n✓ Added ${funcDiff.added.length} new function(s) to ${functionsPath}`);
      } else {
        console.log('\n⚠ Could not find FUNCTIONS array end');
      }
    } else {
      console.log('\n⚠ Could not find insertion point in functions.ts');
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
    summary.functionsAdded.length > 0 ? `### New Functions (${summary.functionsAdded.length})\n${summary.functionsAdded.map(n => `- \`${n}()\``).join('\n')}` : '',
    summary.functionsRemoved.length > 0 ? `### Functions Not In Docs (${summary.functionsRemoved.length})\n${summary.functionsRemoved.map(n => `- \`${n}()\``).join('\n')}` : '',
  ].filter(Boolean).join('\n\n');

  writeFileSync(summaryPath, summaryMd, 'utf-8');
  console.log(`\n✓ Wrote sync summary to ${summaryPath}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
