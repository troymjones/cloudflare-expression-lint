/**
 * Tests for the ESLint plugin adapter.
 *
 * Tests the rule logic functions directly using vitest,
 * NOT ESLint's RuleTester (to avoid eslint as a hard dependency).
 */

import { describe, it, expect } from 'vitest';
import {
  isExpressionKey,
  inferExpressionType,
  inferPhaseFromKey,
  DEFAULT_EXPRESSION_KEYS,
  createValidateExpressionRule,
  diagnosticSeverityToEslint,
} from '../eslint-plugin.js';
import type { ExpressionType } from '../types.js';

// ── isExpressionKey ─────────────────────────────────────────────────────

describe('isExpressionKey', () => {
  it('recognizes default expression keys', () => {
    expect(isExpressionKey('expression')).toBe(true);
    expect(isExpressionKey('rewrite_expression')).toBe(true);
    expect(isExpressionKey('source_url_expression')).toBe(true);
    expect(isExpressionKey('target_url_expression')).toBe(true);
  });

  it('rejects non-expression keys', () => {
    expect(isExpressionKey('name')).toBe(false);
    expect(isExpressionKey('description')).toBe(false);
    expect(isExpressionKey('action')).toBe(false);
    expect(isExpressionKey('')).toBe(false);
  });

  it('recognizes custom key mappings', () => {
    const custom: Record<string, ExpressionType> = {
      my_custom_expr: 'filter',
    };
    expect(isExpressionKey('my_custom_expr', custom)).toBe(true);
    // Default keys should still work
    expect(isExpressionKey('expression', custom)).toBe(true);
  });

  it('custom mappings do not break default key detection', () => {
    const custom: Record<string, ExpressionType> = {
      special_key: 'rewrite_url',
    };
    expect(isExpressionKey('expression', custom)).toBe(true);
    expect(isExpressionKey('not_a_key', custom)).toBe(false);
  });
});

// ── inferExpressionType ─────────────────────────────────────────────────

describe('inferExpressionType', () => {
  it('maps "expression" to filter', () => {
    expect(inferExpressionType('expression')).toBe('filter');
  });

  it('maps "rewrite_expression" to rewrite_url', () => {
    expect(inferExpressionType('rewrite_expression')).toBe('rewrite_url');
  });

  it('maps "source_url_expression" to filter', () => {
    expect(inferExpressionType('source_url_expression')).toBe('filter');
  });

  it('maps "target_url_expression" to redirect_target', () => {
    expect(inferExpressionType('target_url_expression')).toBe('redirect_target');
  });

  it('falls back to filter for unknown keys', () => {
    expect(inferExpressionType('unknown_key')).toBe('filter');
  });

  it('custom mappings take precedence over defaults', () => {
    const custom: Record<string, ExpressionType> = {
      expression: 'rewrite_url', // override the default
    };
    expect(inferExpressionType('expression', custom)).toBe('rewrite_url');
  });

  it('custom mappings work for new keys', () => {
    const custom: Record<string, ExpressionType> = {
      custom_expr: 'rewrite_header',
    };
    expect(inferExpressionType('custom_expr', custom)).toBe('rewrite_header');
  });
});

// ── inferPhaseFromKey ───────────────────────────────────────────────────

describe('inferPhaseFromKey', () => {
  it('returns phase hint for rewrite_expression', () => {
    expect(inferPhaseFromKey('rewrite_expression')).toBe('http_request_transform');
  });

  it('returns phase hint for source_url_expression', () => {
    expect(inferPhaseFromKey('source_url_expression')).toBe('http_request_dynamic_redirect');
  });

  it('returns phase hint for target_url_expression', () => {
    expect(inferPhaseFromKey('target_url_expression')).toBe('http_request_dynamic_redirect');
  });

  it('returns undefined for "expression" (no phase hint)', () => {
    expect(inferPhaseFromKey('expression')).toBeUndefined();
  });

  it('returns undefined for unknown keys', () => {
    expect(inferPhaseFromKey('random_key')).toBeUndefined();
  });

  it('custom phase mappings take precedence', () => {
    const custom: Record<string, string> = {
      expression: 'http_request_firewall_custom',
    };
    expect(inferPhaseFromKey('expression', custom)).toBe('http_request_firewall_custom');
  });

  it('custom phase mappings work for new keys', () => {
    const custom: Record<string, string> = {
      my_expr: 'http_ratelimit',
    };
    expect(inferPhaseFromKey('my_expr', custom)).toBe('http_ratelimit');
  });
});

// ── DEFAULT_EXPRESSION_KEYS ─────────────────────────────────────────────

describe('DEFAULT_EXPRESSION_KEYS', () => {
  it('contains all expected keys', () => {
    expect(Object.keys(DEFAULT_EXPRESSION_KEYS)).toEqual(
      expect.arrayContaining([
        'expression',
        'rewrite_expression',
        'source_url_expression',
        'target_url_expression',
      ]),
    );
  });

  it('has exactly 4 default keys', () => {
    expect(Object.keys(DEFAULT_EXPRESSION_KEYS)).toHaveLength(4);
  });
});

// ── diagnosticSeverityToEslint ──────────────────────────────────────────

describe('diagnosticSeverityToEslint', () => {
  it('maps error to 2', () => {
    expect(diagnosticSeverityToEslint('error')).toBe(2);
  });

  it('maps warning to 1', () => {
    expect(diagnosticSeverityToEslint('warning')).toBe(1);
  });

  it('maps info to 1', () => {
    expect(diagnosticSeverityToEslint('info')).toBe(1);
  });
});

// ── createValidateExpressionRule ────────────────────────────────────────

describe('createValidateExpressionRule', () => {
  it('returns a rule with meta and create', () => {
    const rule = createValidateExpressionRule();
    expect(rule.meta).toBeDefined();
    expect(rule.meta.type).toBe('problem');
    expect(rule.create).toBeInstanceOf(Function);
  });

  it('meta has schema for rule options', () => {
    const rule = createValidateExpressionRule();
    const schema = rule.meta.schema as any[];
    expect(schema).toHaveLength(1);
    expect(schema[0].type).toBe('object');
    expect(schema[0].properties).toHaveProperty('customKeyMappings');
    expect(schema[0].properties).toHaveProperty('customPhaseMappings');
    expect(schema[0].properties).toHaveProperty('defaultPhase');
  });

  describe('YAML visitor', () => {
    it('returns YAMLPair visitor for .yaml files', () => {
      const rule = createValidateExpressionRule();
      const visitors = rule.create({
        options: [{}],
        getFilename: () => 'test.yaml',
      });
      expect(visitors).toHaveProperty('YAMLPair');
    });

    it('returns YAMLPair visitor for .yml files', () => {
      const rule = createValidateExpressionRule();
      const visitors = rule.create({
        options: [{}],
        getFilename: () => 'config.yml',
      });
      expect(visitors).toHaveProperty('YAMLPair');
    });

    it('reports diagnostics for invalid expressions in YAML', () => {
      const rule = createValidateExpressionRule();
      const reports: any[] = [];
      const visitors = rule.create({
        options: [{}],
        getFilename: () => 'test.yaml',
        report: (r: any) => reports.push(r),
      });

      // Simulate a YAMLPair node with an invalid expression
      visitors['YAMLPair']({
        key: { value: 'expression' },
        value: { value: 'unknown_field eq "test"' },
      });

      expect(reports.length).toBeGreaterThan(0);
      expect(reports[0].data.message).toContain('unknown-field');
    });

    it('does not report for non-expression keys in YAML', () => {
      const rule = createValidateExpressionRule();
      const reports: any[] = [];
      const visitors = rule.create({
        options: [{}],
        getFilename: () => 'test.yaml',
        report: (r: any) => reports.push(r),
      });

      visitors['YAMLPair']({
        key: { value: 'name' },
        value: { value: 'some value' },
      });

      expect(reports).toHaveLength(0);
    });

    it('skips empty expression values', () => {
      const rule = createValidateExpressionRule();
      const reports: any[] = [];
      const visitors = rule.create({
        options: [{}],
        getFilename: () => 'test.yaml',
        report: (r: any) => reports.push(r),
      });

      visitors['YAMLPair']({
        key: { value: 'expression' },
        value: { value: '   ' },
      });

      expect(reports).toHaveLength(0);
    });

    it('uses custom key mappings', () => {
      const rule = createValidateExpressionRule();
      const reports: any[] = [];
      const visitors = rule.create({
        options: [{
          customKeyMappings: { my_expr: 'filter' },
        }],
        getFilename: () => 'test.yaml',
        report: (r: any) => reports.push(r),
      });

      visitors['YAMLPair']({
        key: { value: 'my_expr' },
        value: { value: 'unknown_field eq "test"' },
      });

      expect(reports.length).toBeGreaterThan(0);
    });

    it('reports no diagnostics for valid expressions', () => {
      const rule = createValidateExpressionRule();
      const reports: any[] = [];
      const visitors = rule.create({
        options: [{}],
        getFilename: () => 'test.yaml',
        report: (r: any) => reports.push(r),
      });

      visitors['YAMLPair']({
        key: { value: 'expression' },
        value: { value: 'http.request.uri.path eq "/test"' },
      });

      expect(reports).toHaveLength(0);
    });
  });

  describe('JSON visitor', () => {
    it('returns Property visitor for .json files', () => {
      const rule = createValidateExpressionRule();
      const visitors = rule.create({
        options: [{}],
        getFilename: () => 'config.json',
      });
      expect(visitors).toHaveProperty('Property');
    });

    it('reports diagnostics for invalid expressions in JSON', () => {
      const rule = createValidateExpressionRule();
      const reports: any[] = [];
      const visitors = rule.create({
        options: [{}],
        getFilename: () => 'config.json',
        report: (r: any) => reports.push(r),
      });

      visitors['Property']({
        key: { value: 'expression' },
        value: { type: 'Literal', value: 'bad_field eq "x"' },
      });

      expect(reports.length).toBeGreaterThan(0);
      expect(reports[0].data.message).toContain('unknown-field');
    });

    it('ignores non-string JSON values', () => {
      const rule = createValidateExpressionRule();
      const reports: any[] = [];
      const visitors = rule.create({
        options: [{}],
        getFilename: () => 'config.json',
        report: (r: any) => reports.push(r),
      });

      visitors['Property']({
        key: { value: 'expression' },
        value: { type: 'Literal', value: 42 },
      });

      expect(reports).toHaveLength(0);
    });

    it('does not return YAML visitors for .json files', () => {
      const rule = createValidateExpressionRule();
      const visitors = rule.create({
        options: [{}],
        getFilename: () => 'config.json',
      });
      expect(visitors).not.toHaveProperty('YAMLPair');
    });
  });

  describe('non-YAML/JSON files', () => {
    it('returns empty visitors for .ts files', () => {
      const rule = createValidateExpressionRule();
      const visitors = rule.create({
        options: [{}],
        getFilename: () => 'test.ts',
      });
      expect(Object.keys(visitors)).toHaveLength(0);
    });
  });
});
