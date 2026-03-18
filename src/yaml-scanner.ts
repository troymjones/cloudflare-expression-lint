/**
 * YAML Scanner
 *
 * Extracts Cloudflare expressions from YAML config files,
 * determines their context (filter vs rewrite vs redirect),
 * and validates them.
 *
 * The scanner ships with minimal built-in mappings that cover
 * standard Cloudflare Terraform provider attribute names. Users
 * can supply custom mappings via ScannerOptions to match their
 * own YAML schema.
 */

import { parse as parseYaml } from 'yaml';
import { validate } from './validator.js';
import type { ValidationContext, LintResult, ExpressionType } from './types.js';

// ── Public Types ─────────────────────────────────────────────────────

export interface YAMLExpressionLocation {
  file: string;
  yamlPath: string;
  line?: number;
  expressionType: ExpressionType;
  phase?: string;
  expression: string;
  accountLevel?: boolean;
}

export interface YAMLScanResult {
  file: string;
  expressions: (YAMLExpressionLocation & { result: LintResult })[];
  parseError?: string;
}

/**
 * Defines how a YAML key containing an expression should be interpreted.
 */
export interface ExpressionKeyMapping {
  /** The expression type (filter, rewrite_url, etc.) */
  type: ExpressionType;
  /** If set, overrides any parent-inferred phase for this key */
  phaseHint?: string;
}

/**
 * Maps a YAML parent key to a Cloudflare ruleset phase.
 *
 * When the scanner encounters a YAML object with this key, all
 * descendant `expression` values inherit the specified phase.
 *
 * Example: `{ "rules": "http_request_firewall_custom" }` means
 * any `expression` found inside a `rules:` block is treated as
 * belonging to the `http_request_firewall_custom` phase.
 */
export type PhaseMapping = Record<string, string>;

/**
 * Options for customizing how the YAML scanner detects and
 * interprets Cloudflare expressions.
 */
export interface ScannerOptions {
  /**
   * Map of YAML key names to expression type + optional phase.
   * Merged with (and overrides) the built-in defaults.
   *
   * Built-in keys: expression, rewrite_expression,
   * source_url_expression, target_url_expression
   */
  expressionKeys?: Record<string, ExpressionKeyMapping>;

  /**
   * Map of YAML parent key names to Cloudflare phases.
   * Merged with (and overrides) the built-in defaults.
   *
   * Example: `{ "firewall_rules": "http_request_firewall_custom" }`
   */
  phaseMappings?: PhaseMapping;

  /**
   * If true, replaces the built-in expression key defaults
   * instead of merging with them.
   */
  replaceExpressionKeys?: boolean;

  /**
   * If true, replaces the built-in phase mapping defaults
   * instead of merging with them.
   */
  replacePhaseMappings?: boolean;

  /**
   * If true, require outer parentheses on filter expressions
   * (for Expression Builder compatibility). Missing parens becomes
   * an error instead of info.
   */
  requireOuterParentheses?: boolean;

  /**
   * YAML parent keys that indicate account-level expressions.
   * Expressions under these keys will be checked for the
   * `and (cf.zone.plan eq "ENT")` suffix.
   */
  accountLevelKeys?: string[];
}

// ── Built-in Defaults ────────────────────────────────────────────────

/**
 * Default YAML keys that contain Cloudflare expressions.
 *
 * Only includes `expression` — the standard attribute name used by the
 * Cloudflare Terraform provider (cloudflare_ruleset.rules.expression).
 *
 * Users should add their own keys if their YAML schema uses different
 * names for filter, rewrite, or redirect expressions.
 */
const DEFAULT_EXPRESSION_KEYS: Record<string, ExpressionKeyMapping> = {
  'expression': { type: 'filter' },
};

/**
 * Default phase inference from YAML parent keys.
 *
 * These are intentionally minimal — only mappings that directly
 * correspond to Cloudflare phase names or widely-used conventions.
 * Users should add their own mappings for custom YAML schemas.
 */
const DEFAULT_PHASE_MAPPINGS: PhaseMapping = {
  // Direct Cloudflare phase names (if someone uses these as YAML keys)
  'http_request_firewall_custom': 'http_request_firewall_custom',
  'http_ratelimit': 'http_ratelimit',
  'http_request_cache_settings': 'http_request_cache_settings',
  'http_config_settings': 'http_config_settings',
  'http_request_late_transform': 'http_request_late_transform',
  'http_response_headers_transform': 'http_response_headers_transform',
  'http_request_transform': 'http_request_transform',
  'http_request_dynamic_redirect': 'http_request_dynamic_redirect',
  'http_request_origin': 'http_request_origin',
  'http_request_snippets': 'http_request_snippets',
  'http_request_redirect': 'http_request_redirect',

  // Load balancing
  'load_balancing': 'load_balancing',

  // Common shorthand keys used in YAML configs
  'cache_rules': 'http_request_cache_settings',
  'rate_limit_rules': 'http_ratelimit',
  'ratelimit_rules': 'http_ratelimit',
  'single_redirects': 'http_request_dynamic_redirect',
  'origin_rules': 'http_request_origin',
};

// ── Public API ───────────────────────────────────────────────────────

/**
 * Scan a YAML file content for Cloudflare expressions and validate them.
 *
 * @param content - Raw YAML file content
 * @param filePath - File path (used in diagnostics)
 * @param options - Optional scanner customization
 */
export function scanYaml(
  content: string,
  filePath: string,
  options?: ScannerOptions,
): YAMLScanResult {
  const expressionKeys = buildExpressionKeys(options);
  const phaseMappings = buildPhaseMappings(options);

  let doc: unknown;
  try {
    doc = parseYaml(content);
  } catch (err) {
    return {
      file: filePath,
      expressions: [],
      parseError: err instanceof Error ? err.message : String(err),
    };
  }

  const accountLevelKeys = new Set(options?.accountLevelKeys ?? []);

  const locations: YAMLExpressionLocation[] = [];
  walkYaml(doc, [], locations, filePath, undefined, false, expressionKeys, phaseMappings, accountLevelKeys);

  const expressions = locations.map(loc => {
    const ctx: ValidationContext = {
      expressionType: loc.expressionType,
      phase: loc.phase,
      allowPlaceholders: true,
      requireOuterParentheses: options?.requireOuterParentheses,
      accountLevel: loc.accountLevel,
    };
    const result = validate(loc.expression, ctx);
    return { ...loc, result };
  });

  return { file: filePath, expressions };
}

/**
 * Get the current default expression key mappings.
 * Useful for inspecting or extending the defaults.
 */
export function getDefaultExpressionKeys(): Record<string, ExpressionKeyMapping> {
  return { ...DEFAULT_EXPRESSION_KEYS };
}

/**
 * Get the current default phase mappings.
 * Useful for inspecting or extending the defaults.
 */
export function getDefaultPhaseMappings(): PhaseMapping {
  return { ...DEFAULT_PHASE_MAPPINGS };
}

// ── Internal Helpers ─────────────────────────────────────────────────

function buildExpressionKeys(
  options?: ScannerOptions,
): Record<string, ExpressionKeyMapping> {
  if (!options?.expressionKeys) return DEFAULT_EXPRESSION_KEYS;
  if (options.replaceExpressionKeys) return options.expressionKeys;
  return { ...DEFAULT_EXPRESSION_KEYS, ...options.expressionKeys };
}

function buildPhaseMappings(options?: ScannerOptions): PhaseMapping {
  if (!options?.phaseMappings) return DEFAULT_PHASE_MAPPINGS;
  if (options.replacePhaseMappings) return options.phaseMappings;
  return { ...DEFAULT_PHASE_MAPPINGS, ...options.phaseMappings };
}

/**
 * Recursively walk a parsed YAML structure and extract expressions.
 */
function walkYaml(
  node: unknown,
  path: string[],
  results: YAMLExpressionLocation[],
  filePath: string,
  inferredPhase: string | undefined,
  inferredAccountLevel: boolean,
  expressionKeys: Record<string, ExpressionKeyMapping>,
  phaseMappings: PhaseMapping,
  accountLevelKeys: Set<string>,
): void {
  if (node === null || node === undefined) return;

  if (typeof node === 'object' && !Array.isArray(node)) {
    const obj = node as Record<string, unknown>;

    // Check if any key in this object hints at a phase or account level
    let phase = inferredPhase;
    let isAccountLevel = inferredAccountLevel;
    for (const key of Object.keys(obj)) {
      if (phaseMappings[key]) {
        phase = phaseMappings[key];
      }
      if (accountLevelKeys.has(key)) {
        isAccountLevel = true;
      }
    }

    for (const [key, value] of Object.entries(obj)) {
      const keyPath = [...path, key];

      // Check if this key is an expression key
      const exprInfo = expressionKeys[key];
      if (exprInfo && typeof value === 'string') {
        const exprStr = value.trim();
        if (exprStr) {
          results.push({
            file: filePath,
            yamlPath: keyPath.join('.'),
            expressionType: exprInfo.type,
            phase: exprInfo.phaseHint ?? phase,
            expression: exprStr,
            accountLevel: isAccountLevel || undefined,
          });
        }
      }

      // Check for header expression (nested in headers array)
      if (key === 'headers' && Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
          const header = value[i];
          if (header && typeof header === 'object' && 'expression' in header && typeof header.expression === 'string') {
            results.push({
              file: filePath,
              yamlPath: [...keyPath, `${i}`, 'expression'].join('.'),
              expressionType: 'rewrite_header',
              phase: phase ?? 'http_request_late_transform',
              expression: header.expression.trim(),
            });
          }
        }
      }

      // Recurse
      walkYaml(value, keyPath, results, filePath, phase, isAccountLevel, expressionKeys, phaseMappings, accountLevelKeys);
    }
  } else if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      walkYaml(node[i], [...path, `${i}`], results, filePath, inferredPhase, inferredAccountLevel, expressionKeys, phaseMappings, accountLevelKeys);
    }
  }
}
