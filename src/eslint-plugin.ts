/**
 * ESLint plugin adapter for cloudflare-expression-lint.
 *
 * Provides a `validate-expression` rule that hooks into YAML AST nodes
 * (via yaml-eslint-parser) and JSON files to detect and validate
 * Cloudflare Rules Language expressions.
 *
 * yaml-eslint-parser and eslint are optional peer dependencies.
 */

import { validate } from './validator.js';
import type { ExpressionType, DiagnosticSeverity } from './types.js';

// ── Expression key detection ────────────────────────────────────────────

/**
 * Default mapping of YAML/JSON key names to expression types.
 */
export const DEFAULT_EXPRESSION_KEYS: Record<string, ExpressionType> = {
  expression: 'filter',
  rewrite_expression: 'rewrite_url',
  source_url_expression: 'filter',
  target_url_expression: 'redirect_target',
};

/**
 * Check whether a given key name is one of the known expression keys.
 */
export function isExpressionKey(
  key: string,
  customMappings?: Record<string, ExpressionType>,
): boolean {
  if (customMappings && key in customMappings) return true;
  return key in DEFAULT_EXPRESSION_KEYS;
}

/**
 * Infer the ExpressionType for a given key name.
 * Custom mappings take precedence over defaults.
 */
export function inferExpressionType(
  key: string,
  customMappings?: Record<string, ExpressionType>,
): ExpressionType {
  if (customMappings && key in customMappings) {
    return customMappings[key];
  }
  return DEFAULT_EXPRESSION_KEYS[key] ?? 'filter';
}

// ── Phase inference from key name ───────────────────────────────────────

/**
 * Mapping from expression key names to a phase hint.
 */
const KEY_PHASE_HINTS: Record<string, string> = {
  rewrite_expression: 'http_request_transform',
  source_url_expression: 'http_request_dynamic_redirect',
  target_url_expression: 'http_request_dynamic_redirect',
};

/**
 * Infer a phase hint from the key name, if one exists.
 */
export function inferPhaseFromKey(
  key: string,
  customPhaseMappings?: Record<string, string>,
): string | undefined {
  if (customPhaseMappings && key in customPhaseMappings) {
    return customPhaseMappings[key];
  }
  return KEY_PHASE_HINTS[key];
}

// ── ESLint severity mapping ─────────────────────────────────────────────

function diagnosticSeverityToEslint(severity: DiagnosticSeverity): 1 | 2 {
  // ESLint only has warn (1) and error (2). Map info to warn.
  switch (severity) {
    case 'error':
      return 2;
    case 'warning':
    case 'info':
      return 1;
  }
}

// ── Rule option types ───────────────────────────────────────────────────

export interface ValidateExpressionRuleOptions {
  /** Custom key name to ExpressionType mappings */
  customKeyMappings?: Record<string, ExpressionType>;
  /** Custom key name to phase mappings */
  customPhaseMappings?: Record<string, string>;
  /** Default phase when none can be inferred */
  defaultPhase?: string;
}

// ── ESLint rule definition ──────────────────────────────────────────────

/**
 * Creates the ESLint rule object for validate-expression.
 * Factored out so it can be tested without requiring ESLint.
 */
export function createValidateExpressionRule(): {
  meta: Record<string, unknown>;
  create: (context: any) => Record<string, (node: any) => void>;
} {
  return {
    meta: {
      type: 'problem',
      docs: {
        description: 'Validate Cloudflare Rules Language expressions',
        category: 'Possible Errors',
        recommended: true,
      },
      schema: [
        {
          type: 'object',
          properties: {
            customKeyMappings: {
              type: 'object',
              additionalProperties: { type: 'string' },
            },
            customPhaseMappings: {
              type: 'object',
              additionalProperties: { type: 'string' },
            },
            defaultPhase: { type: 'string' },
          },
          additionalProperties: false,
        },
      ],
      messages: {
        expressionDiagnostic: '{{message}}',
      },
    },

    create(context: any) {
      const options: ValidateExpressionRuleOptions = context.options?.[0] ?? {};
      const { customKeyMappings, customPhaseMappings, defaultPhase } = options;
      const filename: string = context.getFilename?.() ?? context.filename ?? '';

      const visitors: Record<string, (node: any) => void> = {};

      // ── YAML file handling (requires yaml-eslint-parser) ──────────
      if (filename.endsWith('.yaml') || filename.endsWith('.yml')) {
        visitors['YAMLPair'] = (node: any) => {
          // YAMLPair has .key and .value nodes
          const keyNode = node.key;
          const valueNode = node.value;

          if (!keyNode || !valueNode) return;

          // Get the key string
          const keyName = keyNode.value ?? keyNode.raw;
          if (typeof keyName !== 'string') return;

          // Check if this is an expression key
          if (!isExpressionKey(keyName, customKeyMappings)) return;

          // Get the value string
          const valueStr = valueNode.value ?? valueNode.raw;
          if (typeof valueStr !== 'string') return;

          const expression = valueStr.trim();
          if (!expression) return;

          // Determine expression type and phase
          const expressionType = inferExpressionType(keyName, customKeyMappings);
          const phase = inferPhaseFromKey(keyName, customPhaseMappings) ?? defaultPhase;

          // Validate
          const result = validate(expression, {
            expressionType,
            phase,
            allowPlaceholders: true,
          });

          // Report diagnostics
          for (const diagnostic of result.diagnostics) {
            context.report({
              node: valueNode,
              messageId: 'expressionDiagnostic',
              data: { message: `[${diagnostic.code}] ${diagnostic.message}` },
              // Use ESLint severity mapping (note: ESLint rule severity is
              // configured at the config level, but we include our severity
              // in the message for clarity)
            });
          }
        };
      }

      // ── JSON file handling ────────────────────────────────────────
      if (filename.endsWith('.json')) {
        visitors['Property'] = (node: any) => {
          const keyNode = node.key;
          const valueNode = node.value;

          if (!keyNode || !valueNode) return;

          // Get key name from JSON AST
          const keyName = keyNode.value ?? keyNode.name;
          if (typeof keyName !== 'string') return;

          if (!isExpressionKey(keyName, customKeyMappings)) return;

          // Value must be a string literal
          if (valueNode.type !== 'Literal' || typeof valueNode.value !== 'string') return;

          const expression = valueNode.value.trim();
          if (!expression) return;

          const expressionType = inferExpressionType(keyName, customKeyMappings);
          const phase = inferPhaseFromKey(keyName, customPhaseMappings) ?? defaultPhase;

          const result = validate(expression, {
            expressionType,
            phase,
            allowPlaceholders: true,
          });

          for (const diagnostic of result.diagnostics) {
            context.report({
              node: valueNode,
              messageId: 'expressionDiagnostic',
              data: { message: `[${diagnostic.code}] ${diagnostic.message}` },
            });
          }
        };
      }

      return visitors;
    },
  };
}

// ── Plugin export ───────────────────────────────────────────────────────

const rule = createValidateExpressionRule();

const plugin = {
  rules: {
    'validate-expression': rule,
  },
  configs: {
    recommended: {
      plugins: ['cloudflare-expression-lint'],
      rules: {
        'cloudflare-expression-lint/validate-expression': 'warn',
      },
    },
  },
};

export default plugin;

// Also export for named imports
export { plugin, rule as validateExpressionRule };

// Re-export the severity mapper for testing
export { diagnosticSeverityToEslint };
