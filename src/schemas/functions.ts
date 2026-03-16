/**
 * Cloudflare expression functions registry.
 *
 * Reference: https://developers.cloudflare.com/ruleset-engine/rules-language/functions/
 *
 * MAINTAINER NOTE: To add a new function, add it to the FUNCTIONS array below.
 */

import type { FieldType } from './operators.js';

export type ExpressionContext =
  | 'filter'                          // Boolean filter expressions (the "when" condition)
  | 'rewrite_url'                     // URL rewrite value expressions
  | 'rewrite_header'                  // Header modification value expressions
  | 'redirect_target'                 // Dynamic redirect target expressions
  | 'all';                            // Available everywhere

export interface FunctionParam {
  name: string;
  type: FieldType | 'Any';
  optional?: boolean;
  variadic?: boolean;
}

export interface FunctionDef {
  /** Function name (e.g., "lower") */
  name: string;
  /** Parameter definitions */
  params: FunctionParam[];
  /** Return type */
  returnType: FieldType;
  /** Which expression contexts this function is available in */
  contexts: ExpressionContext[];
  /** Maximum number of times this function can appear in a single expression */
  maxPerExpression?: number;
  /** Whether this function cannot be nested inside certain other functions */
  noNestIn?: string[];
  /** Human-readable notes */
  notes?: string;
}

export const FUNCTIONS: FunctionDef[] = [
  // ── Universally Available Functions ──────────────────────────────────
  {
    name: 'any',
    params: [{ name: 'values', type: 'Array' }],
    returnType: 'Boolean',
    contexts: ['all'],
  },
  {
    name: 'all',
    params: [{ name: 'values', type: 'Array' }],
    returnType: 'Boolean',
    contexts: ['all'],
  },
  {
    name: 'concat',
    params: [{ name: 'values', type: 'Any', variadic: true }],
    returnType: 'String',
    contexts: ['all'],
  },
  {
    name: 'ends_with',
    params: [
      { name: 'source', type: 'String' },
      { name: 'substring', type: 'String' },
    ],
    returnType: 'Boolean',
    contexts: ['all'],
  },
  {
    name: 'starts_with',
    params: [
      { name: 'source', type: 'String' },
      { name: 'substring', type: 'String' },
    ],
    returnType: 'Boolean',
    contexts: ['all'],
  },
  {
    name: 'has_key',
    params: [
      { name: 'map', type: 'Map' },
      { name: 'key', type: 'String' },
    ],
    returnType: 'Boolean',
    contexts: ['all'],
  },
  {
    name: 'has_value',
    params: [
      { name: 'collection', type: 'Any' },
      { name: 'value', type: 'Any' },
    ],
    returnType: 'Boolean',
    contexts: ['all'],
  },
  {
    name: 'len',
    params: [{ name: 'value', type: 'Any' }],
    returnType: 'Integer',
    contexts: ['all'],
  },
  {
    name: 'lookup_json_integer',
    params: [
      { name: 'field', type: 'String' },
      { name: 'key', type: 'Any', variadic: true },
    ],
    returnType: 'Integer',
    contexts: ['all'],
  },
  {
    name: 'lookup_json_string',
    params: [
      { name: 'field', type: 'String' },
      { name: 'key', type: 'Any', variadic: true },
    ],
    returnType: 'String',
    contexts: ['all'],
  },
  {
    name: 'lower',
    params: [{ name: 'value', type: 'String' }],
    returnType: 'String',
    contexts: ['all'],
  },
  {
    name: 'upper',
    params: [{ name: 'value', type: 'String' }],
    returnType: 'String',
    contexts: ['all'],
  },
  {
    name: 'remove_bytes',
    params: [
      { name: 'value', type: 'Bytes' },
      { name: 'bytes_to_remove', type: 'Bytes' },
    ],
    returnType: 'Bytes',
    contexts: ['all'],
  },
  {
    name: 'substring',
    params: [
      { name: 'value', type: 'String' },
      { name: 'start', type: 'Integer' },
      { name: 'end', type: 'Integer', optional: true },
    ],
    returnType: 'String',
    contexts: ['all'],
  },
  {
    name: 'url_decode',
    params: [
      { name: 'source', type: 'String' },
      { name: 'options', type: 'String', optional: true },
    ],
    returnType: 'String',
    contexts: ['all'],
  },

  // ── Transform / Redirect-Only Functions ──────────────────────────────
  {
    name: 'regex_replace',
    params: [
      { name: 'source', type: 'String' },
      { name: 'regex', type: 'String' },
      { name: 'replacement', type: 'String' },
    ],
    returnType: 'String',
    contexts: ['rewrite_url', 'rewrite_header', 'redirect_target'],
    maxPerExpression: 1,
    noNestIn: ['wildcard_replace'],
    notes: 'Supports capture group references ${1} through ${8}',
  },
  {
    name: 'wildcard_replace',
    params: [
      { name: 'source', type: 'String' },
      { name: 'pattern', type: 'String' },
      { name: 'replacement', type: 'String' },
      { name: 'flags', type: 'String', optional: true },
    ],
    returnType: 'String',
    contexts: ['rewrite_url', 'redirect_target'],
    maxPerExpression: 1,
    noNestIn: ['regex_replace'],
  },
  {
    name: 'to_string',
    params: [{ name: 'value', type: 'Any' }],
    returnType: 'String',
    contexts: ['rewrite_url', 'rewrite_header', 'redirect_target'],
  },
  {
    name: 'encode_base64',
    params: [
      { name: 'input', type: 'Any' },
      { name: 'flags', type: 'String', optional: true },
    ],
    returnType: 'String',
    contexts: ['rewrite_header'],
  },
  {
    name: 'decode_base64',
    params: [{ name: 'source', type: 'String' }],
    returnType: 'String',
    contexts: ['rewrite_url', 'rewrite_header', 'filter'],
  },
  {
    name: 'remove_query_args',
    params: [
      { name: 'field', type: 'String' },
      { name: 'query_param', type: 'String', variadic: true },
    ],
    returnType: 'String',
    contexts: ['rewrite_url'],
  },
  {
    name: 'sha256',
    params: [{ name: 'input', type: 'Any' }],
    returnType: 'Bytes',
    contexts: ['rewrite_url', 'rewrite_header'],
  },
  {
    name: 'uuidv4',
    params: [{ name: 'source', type: 'Bytes' }],
    returnType: 'String',
    contexts: ['rewrite_url', 'rewrite_header'],
  },
  {
    name: 'split',
    params: [
      { name: 'input', type: 'String' },
      { name: 'separator', type: 'String' },
      { name: 'limit', type: 'Integer' },
    ],
    returnType: 'Array',
    contexts: ['rewrite_header'],
    notes: 'Limit must be 1-128',
  },
  {
    name: 'join',
    params: [
      { name: 'items', type: 'Array' },
      { name: 'separator', type: 'String' },
    ],
    returnType: 'String',
    contexts: ['rewrite_url', 'rewrite_header', 'filter'],
  },

  // ── Rate Limiting / Custom Rule Functions ────────────────────────────
  {
    name: 'cidr',
    params: [
      { name: 'address', type: 'IP' },
      { name: 'ipv4_network_bits', type: 'Integer' },
      { name: 'ipv6_network_bits', type: 'Integer' },
    ],
    returnType: 'IP',
    contexts: ['filter'],
    notes: 'IPv4 bits: 1-32, IPv6 bits: 1-128',
  },
  {
    name: 'cidr6',
    params: [
      { name: 'address', type: 'IP' },
      { name: 'ipv6_network_bits', type: 'Integer' },
    ],
    returnType: 'IP',
    contexts: ['filter'],
  },

  // ── HMAC Validation ──────────────────────────────────────────────────
  {
    name: 'is_timed_hmac_valid_v0',
    params: [
      { name: 'key', type: 'String' },
      { name: 'messageMac', type: 'String' },
      { name: 'ttl', type: 'Integer' },
      { name: 'timestamp', type: 'Integer' },
      { name: 'separator', type: 'Integer', optional: true },
      { name: 'flags', type: 'String', optional: true },
    ],
    returnType: 'Boolean',
    contexts: ['filter'],
  },
];

/** Build lookup map */
const functionMap = new Map<string, FunctionDef>();
for (const fn of FUNCTIONS) {
  functionMap.set(fn.name, fn);
}

export function findFunction(name: string): FunctionDef | undefined {
  return functionMap.get(name);
}
