/**
 * YAML Scanner
 *
 * Extracts Cloudflare expressions from YAML config files,
 * determines their context (filter vs rewrite vs redirect),
 * and validates them.
 */

import { parse as parseYaml } from 'yaml';
import { validate } from './validator.js';
import type { ValidationContext, LintResult, ExpressionType } from './types.js';

export interface YAMLExpressionLocation {
  file: string;
  yamlPath: string;
  line?: number;
  expressionType: ExpressionType;
  phase?: string;
  expression: string;
}

export interface YAMLScanResult {
  file: string;
  expressions: (YAMLExpressionLocation & { result: LintResult })[];
  parseError?: string;
}

/**
 * YAML key patterns that contain Cloudflare expressions,
 * mapped to their expression type and phase inference.
 */
const EXPRESSION_KEYS: Record<string, { type: ExpressionType; phaseHint?: string }> = {
  'expression': { type: 'filter' },
  'rewrite_expression': { type: 'rewrite_url', phaseHint: 'http_request_transform' },
  'source_url_expression': { type: 'filter', phaseHint: 'http_request_dynamic_redirect' },
  'target_url_expression': { type: 'redirect_target', phaseHint: 'http_request_dynamic_redirect' },
  'target_url_value': { type: 'redirect_target', phaseHint: 'http_request_dynamic_redirect' },
};

/**
 * YAML parent key patterns that help infer the Cloudflare phase.
 */
const PHASE_CONTEXT_KEYS: Record<string, string> = {
  'waf_rules': 'http_request_firewall_custom',
  'custom_rules': 'http_request_firewall_custom',
  'ratelimit_rules': 'http_ratelimit',
  'rate_limit_rules': 'http_ratelimit',
  'cache_rules': 'http_request_cache_settings',
  'configuration_rules': 'http_config_settings',
  'transform_request_header_rules': 'http_request_late_transform',
  'transform_request_headers_rules_default': 'http_request_late_transform',
  'transform_response_header_rules': 'http_response_headers_transform',
  'transform_url_rewrite_rules': 'http_request_transform',
  'single_redirects': 'http_request_dynamic_redirect',
  'origin_rules': 'http_request_origin',
  'snippets': 'http_request_snippets',
};

/**
 * Scan a YAML file content for Cloudflare expressions and validate them.
 */
export function scanYaml(content: string, filePath: string): YAMLScanResult {
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

  const locations: YAMLExpressionLocation[] = [];
  walkYaml(doc, [], locations, filePath, undefined);

  const expressions = locations.map(loc => {
    const ctx: ValidationContext = {
      expressionType: loc.expressionType,
      phase: loc.phase,
      allowPlaceholders: true,
    };
    const result = validate(loc.expression, ctx);
    return { ...loc, result };
  });

  return { file: filePath, expressions };
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
): void {
  if (node === null || node === undefined) return;

  if (typeof node === 'object' && !Array.isArray(node)) {
    const obj = node as Record<string, unknown>;

    // Check if any key in this object hints at a phase
    let phase = inferredPhase;
    for (const key of Object.keys(obj)) {
      if (PHASE_CONTEXT_KEYS[key]) {
        phase = PHASE_CONTEXT_KEYS[key];
      }
    }

    for (const [key, value] of Object.entries(obj)) {
      const keyPath = [...path, key];

      // Check if this key is an expression key
      const exprInfo = EXPRESSION_KEYS[key];
      if (exprInfo && typeof value === 'string') {
        const exprStr = value.trim();
        if (exprStr) {
          results.push({
            file: filePath,
            yamlPath: keyPath.join('.'),
            expressionType: exprInfo.type,
            phase: exprInfo.phaseHint ?? phase,
            expression: exprStr,
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
      walkYaml(value, keyPath, results, filePath, phase);
    }
  } else if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      walkYaml(node[i], [...path, `${i}`], results, filePath, inferredPhase);
    }
  }
}
