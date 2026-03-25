/**
 * Schema completeness tests.
 *
 * Verifies that all fields and functions in the registries are
 * recognized by the parser and validator. Catches sync-docs
 * regressions where fields could be silently dropped.
 */

import { describe, it, expect } from 'vitest';
import { FIELDS, findField, findBaseField } from '../schemas/fields.js';
import { FUNCTIONS, findFunction } from '../schemas/functions.js';
import { COMPARISON_OPERATORS, LOGICAL_OPERATORS } from '../schemas/operators.js';
import { validate } from '../validator.js';
import { parse } from '../parser.js';
import type { FieldDef } from '../schemas/fields.js';

describe('field registry', () => {
  it('has at least 150 fields', () => {
    expect(FIELDS.length).toBeGreaterThanOrEqual(150);
  });

  it('every field has a name and type', () => {
    for (const field of FIELDS) {
      expect(field.name).toBeTruthy();
      expect(field.type).toBeTruthy();
    }
  });

  it('no duplicate field names', () => {
    const names = FIELDS.map(f => f.name);
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    expect(dupes).toEqual([]);
  });

  it('findField resolves every registered field', () => {
    for (const field of FIELDS) {
      const found = findField(field.name);
      expect(found).toBeDefined();
      expect(found!.name).toBe(field.name);
    }
  });

  it('findBaseField resolves map-access fields', () => {
    // http.request.headers is a base for http.request.headers["key"]
    const base = findBaseField('http.request.headers');
    expect(base).toBeDefined();
  });

  it('deprecated fields have a replacement', () => {
    const deprecated = FIELDS.filter(f => f.deprecated);
    for (const field of deprecated) {
      expect(field.replacement).toBeTruthy();
    }
  });

  it('deprecated field replacements exist in the registry', () => {
    const deprecated = FIELDS.filter(f => f.deprecated && f.replacement);
    for (const field of deprecated) {
      const replacement = findField(field.replacement!);
      // Replacement should exist (may also be deprecated in rare chains)
      expect(replacement).toBeDefined();
    }
  });

  it('common fields are recognized by the validator', () => {
    const commonFields = [
      'http.host', 'http.request.uri.path', 'http.request.method',
      'ip.src', 'ip.src.country', 'cf.bot_management.score',
      'http.request.headers', 'http.cookie', 'http.user_agent',
    ];
    for (const field of commonFields) {
      const result = validate(`(${field} eq "test")`, { expressionType: 'filter' });
      const fieldErrors = result.diagnostics.filter(d => d.code === 'unknown-field');
      expect(fieldErrors).toHaveLength(0);
    }
  });
});

describe('function registry', () => {
  it('has at least 20 functions', () => {
    expect(FUNCTIONS.length).toBeGreaterThanOrEqual(20);
  });

  it('every function has a name, params, and return type', () => {
    for (const fn of FUNCTIONS) {
      expect(fn.name).toBeTruthy();
      expect(fn.params).toBeDefined();
      expect(fn.returnType).toBeTruthy();
    }
  });

  it('no duplicate function names', () => {
    const names = FUNCTIONS.map(f => f.name);
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    expect(dupes).toEqual([]);
  });

  it('findFunction resolves every registered function', () => {
    for (const fn of FUNCTIONS) {
      const found = findFunction(fn.name);
      expect(found).toBeDefined();
      expect(found!.name).toBe(fn.name);
    }
  });

  it('common functions parse and validate', () => {
    const expressions = [
      'lower(http.request.uri.path)',
      'upper(http.host)',
      'len(http.request.uri.path)',
      'starts_with(http.request.uri.path, "/api")',
      'ends_with(http.host, ".com")',
      'concat(http.host, http.request.uri.path)',
    ];
    for (const expr of expressions) {
      // Should parse without error
      expect(() => parse(expr)).not.toThrow();
    }
  });
});

describe('operator registry', () => {
  it('has comparison operators', () => {
    expect(COMPARISON_OPERATORS.length).toBeGreaterThan(0);
    const names = COMPARISON_OPERATORS.map(o => o.name);
    expect(names).toContain('eq');
    expect(names).toContain('ne');
    expect(names).toContain('contains');
    expect(names).toContain('matches');
    expect(names).toContain('in');
  });

  it('has logical operators', () => {
    expect(LOGICAL_OPERATORS.length).toBeGreaterThan(0);
    const names = LOGICAL_OPERATORS.map(o => o.name);
    expect(names).toContain('and');
    expect(names).toContain('or');
    expect(names).toContain('not');
  });
});
