#!/usr/bin/env npx tsx

/**
 * Sync Cloudflare fields from the official cloudflare-docs repo.
 *
 * Fetches the canonical fields YAML from:
 *   github.com/cloudflare/cloudflare-docs/src/content/fields/index.yaml
 *
 * Compares against our local schema and reports:
 *   - New fields not in our registry
 *   - Fields removed from Cloudflare docs
 *   - Type changes
 *
 * Usage:
 *   npx tsx scripts/sync-cloudflare-docs.ts           # Dry run (report only)
 *   npx tsx scripts/sync-cloudflare-docs.ts --apply    # Apply changes to fields.ts
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIELDS_TS_PATH = resolve(__dirname, '../src/schemas/fields.ts');

const FIELDS_YAML_URL =
  'https://raw.githubusercontent.com/cloudflare/cloudflare-docs/production/src/content/fields/index.yaml';

// Map Cloudflare docs data_type to our FieldType.
// Note: Cloudflare docs use "Number" as a generic numeric type.
// In the expression engine these behave as integers for comparison
// purposes (eq, ne, lt, gt, in). We map Number → Integer since
// that's the practical behavior, and flag Float only for lat/lon.
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

// Fields where Number should map to Float instead of Integer
const FLOAT_FIELDS = new Set(['ip.src.lat', 'ip.src.lon']);

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
  phases?: string[];
}

async function fetchCloudflareFields(): Promise<CloudflareField[]> {
  console.log(`Fetching fields from Cloudflare docs...`);
  const response = await fetch(FIELDS_YAML_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch: ${response.status} ${response.statusText}`);
  }
  const yamlText = await response.text();
  const parsed = parseYaml(yamlText) as { entries: CloudflareField[] };
  const fields = parsed.entries;
  console.log(`  Found ${fields.length} fields in Cloudflare docs`);
  return fields;
}

function parseLocalFields(): LocalField[] {
  const content = readFileSync(FIELDS_TS_PATH, 'utf-8');
  const fields: LocalField[] = [];

  // Parse field entries from the FIELDS array
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

  console.log(`  Found ${fields.length} fields in local schema`);
  return fields;
}

function compareFields(
  cloudflare: CloudflareField[],
  local: LocalField[],
): { added: CloudflareField[]; removed: LocalField[]; typeChanged: { cf: CloudflareField; local: LocalField }[] } {
  const cfMap = new Map(cloudflare.map(f => [f.name, f]));
  const localMap = new Map(local.map(f => [f.name, f]));

  const added: CloudflareField[] = [];
  const removed: LocalField[] = [];
  const typeChanged: { cf: CloudflareField; local: LocalField }[] = [];

  // Fields in CF docs but not in our schema
  for (const cf of cloudflare) {
    if (!localMap.has(cf.name)) {
      added.push(cf);
    } else {
      // Check type match
      const localField = localMap.get(cf.name)!;
      let expectedType = TYPE_MAP[cf.data_type] || cf.data_type;
      if (FLOAT_FIELDS.has(cf.name) && cf.data_type === 'Number') {
        expectedType = 'Float';
      }
      if (localField.type !== expectedType) {
        typeChanged.push({ cf, local: localField });
      }
    }
  }

  // Fields in our schema but not in CF docs (excluding deprecated aliases)
  for (const local of localMap.values()) {
    if (!cfMap.has(local.name) && !local.deprecated) {
      removed.push(local);
    }
  }

  return { added, removed, typeChanged };
}

function generateFieldEntry(cf: CloudflareField): string {
  let type = TYPE_MAP[cf.data_type] || cf.data_type;
  if (FLOAT_FIELDS.has(cf.name) && cf.data_type === 'Number') {
    type = 'Float';
  }
  return `  { name: '${cf.name}', type: '${type}' },`;
}

async function main() {
  const applyMode = process.argv.includes('--apply');

  const cloudflareFields = await fetchCloudflareFields();
  const localFields = parseLocalFields();
  const diff = compareFields(cloudflareFields, localFields);

  console.log('\n── Comparison Results ──────────────────────────────────');

  if (diff.added.length === 0 && diff.removed.length === 0 && diff.typeChanged.length === 0) {
    console.log('\n✓ Schema is up to date with Cloudflare docs');
    process.exit(0);
  }

  if (diff.added.length > 0) {
    console.log(`\n${diff.added.length} new field(s) in Cloudflare docs:`);
    for (const f of diff.added) {
      console.log(`  + ${f.name} (${f.data_type})`);
    }
  }

  if (diff.removed.length > 0) {
    console.log(`\n${diff.removed.length} field(s) in local schema but not in Cloudflare docs:`);
    for (const f of diff.removed) {
      console.log(`  - ${f.name} (${f.type})`);
    }
  }

  if (diff.typeChanged.length > 0) {
    console.log(`\n${diff.typeChanged.length} field(s) with type changes:`);
    for (const { cf, local } of diff.typeChanged) {
      console.log(`  ~ ${cf.name}: ${local.type} → ${TYPE_MAP[cf.data_type] || cf.data_type}`);
    }
  }

  if (!applyMode) {
    console.log('\nRun with --apply to add new fields to src/schemas/fields.ts');
    // Exit with code 1 if there are differences (useful for CI)
    process.exit(diff.added.length > 0 || diff.typeChanged.length > 0 ? 1 : 0);
  }

  // Apply: add new fields to fields.ts
  if (diff.added.length > 0) {
    let content = readFileSync(FIELDS_TS_PATH, 'utf-8');

    const newEntries = diff.added.map(generateFieldEntry).join('\n');
    const insertMarker = '/** Build a lookup map for fast field resolution */';
    const insertPoint = content.indexOf(insertMarker);

    if (insertPoint === -1) {
      console.error('Could not find insertion point in fields.ts');
      process.exit(1);
    }

    const newSection = `\n  // ── Auto-synced from Cloudflare docs (${new Date().toISOString().split('T')[0]}) ──\n${newEntries}\n];\n\n`;
    content = content.substring(0, insertPoint - 3) + newSection + content.substring(insertPoint);

    writeFileSync(FIELDS_TS_PATH, content, 'utf-8');
    console.log(`\n✓ Added ${diff.added.length} new field(s) to ${FIELDS_TS_PATH}`);
  }

  if (diff.typeChanged.length > 0) {
    console.log('\n⚠ Type changes detected but not auto-applied — review manually:');
    for (const { cf, local } of diff.typeChanged) {
      console.log(`  ${cf.name}: local="${local.type}" docs="${TYPE_MAP[cf.data_type] || cf.data_type}"`);
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
