import { describe, it, expect } from 'vitest';
import { validate } from '../validator.js';
import type { Diagnostic } from '../types.js';

function diags(expr: string): Diagnostic[] {
  return validate(expr, { expressionType: 'filter' }).diagnostics;
}

function hasBuilderWarning(expr: string): boolean {
  return diags(expr).some(d => d.code === 'builder-incompatible');
}

describe('Expression Builder Compatibility', () => {
  // ── Already Builder-compatible (no warning) ────────────────────────

  describe('expressions already Builder-compatible', () => {
    it('accepts wrapped single comparison', () => {
      expect(hasBuilderWarning('(http.host eq "test.com")')).toBe(false);
    });

    it('accepts wrapped in-expression', () => {
      expect(hasBuilderWarning('(ip.src.country in {"US" "JP"})')).toBe(false);
    });

    it('accepts chain of wrapped clauses with or', () => {
      expect(hasBuilderWarning(
        '(http.request.uri.path eq "/my") or (http.request.uri.path eq "/myjobs")'
      )).toBe(false);
    });

    it('accepts chain of wrapped clauses with and', () => {
      expect(hasBuilderWarning(
        '(http.host eq "test.com") and (http.request.method eq "POST")'
      )).toBe(false);
    });

    it('accepts bare true', () => {
      expect(hasBuilderWarning('true')).toBe(false);
    });

    it('accepts bare boolean field', () => {
      expect(hasBuilderWarning('ssl')).toBe(false);
    });
  });

  // ── Simple but not Builder-formatted (should warn) ─────────────────

  describe('simple expressions needing Builder formatting', () => {
    it('flags unwrapped single comparison', () => {
      expect(hasBuilderWarning('http.host eq "test.com"')).toBe(true);
    });

    it('flags unwrapped in-expression', () => {
      expect(hasBuilderWarning('ip.src.country in {"US" "JP"}')).toBe(true);
    });

    it('flags chain where some clauses lack parens', () => {
      expect(hasBuilderWarning(
        'http.request.uri.path eq "/my" or http.request.uri.path eq "/myjobs"'
      )).toBe(true);
    });

    it('flags mixed wrapped and unwrapped', () => {
      expect(hasBuilderWarning(
        '(http.host eq "test.com") or http.request.method eq "POST"'
      )).toBe(true);
    });
  });

  // ── Complex expressions (silently skipped) ─────────────────────────

  describe('complex expressions skipped silently', () => {
    it('skips function calls', () => {
      expect(hasBuilderWarning('starts_with(http.request.uri.path, "/admin")')).toBe(false);
    });

    it('skips not expressions', () => {
      expect(hasBuilderWarning('not ssl')).toBe(false);
    });

    it('skips mixed and/or operators', () => {
      // A and B or C — mixed operators, too complex for Builder
      expect(hasBuilderWarning(
        'http.host eq "a.com" and http.request.method eq "POST" or ssl'
      )).toBe(false);
    });

    it('skips expressions with function calls in comparisons', () => {
      expect(hasBuilderWarning('lower(http.host) eq "test.com"')).toBe(false);
    });

    it('skips expressions with array unpack', () => {
      expect(hasBuilderWarning(
        'any(http.request.headers["accept"][*] contains "text/html")'
      )).toBe(false);
    });
  });

  // ── Severity ───────────────────────────────────────────────────────

  describe('diagnostic properties', () => {
    it('is info severity', () => {
      const d = diags('http.host eq "test.com"').find(d => d.code === 'builder-incompatible');
      expect(d?.severity).toBe('info');
    });

    it('does not affect validity', () => {
      const result = validate('http.host eq "test.com"', { expressionType: 'filter' });
      expect(result.valid).toBe(true);
    });

    it('only applies to filter expressions', () => {
      const result = validate('concat("/m", http.request.uri.path)', { expressionType: 'rewrite_url' });
      expect(result.diagnostics.some(d => d.code === 'builder-incompatible')).toBe(false);
    });
  });
});
