import { describe, it, expect } from 'vitest';
import { validate } from '../validator.js';

function hasWarning(expr: string): boolean {
  return validate(expr, { expressionType: 'filter' })
    .diagnostics.some(d => d.code === 'ambiguous-precedence');
}

describe('Ambiguous Operator Precedence', () => {
  describe('flags ambiguous and/or mixing', () => {
    it('flags A and B or C (and binds tighter)', () => {
      expect(hasWarning(
        '(http.host eq "media.example.com") and (http.request.uri.path wildcard "*.jpg") or (http.request.uri.path wildcard "*.png")'
      )).toBe(true);
    });

    it('flags A or B and C', () => {
      expect(hasWarning(
        'http.host eq "a.com" or http.host eq "b.com" and http.request.method eq "POST"'
      )).toBe(true);
    });
  });

  describe('does not flag explicitly grouped expressions', () => {
    it('accepts (A and B) or (C)', () => {
      expect(hasWarning(
        '(http.host eq "media.example.com" and http.request.uri.path wildcard "*.jpg") or (http.request.uri.path wildcard "*.png")'
      )).toBe(false);
    });

    it('accepts (A) or (B) or (C)', () => {
      expect(hasWarning(
        '(http.host eq "a.com") or (http.host eq "b.com") or (http.host eq "c.com")'
      )).toBe(false);
    });

    it('accepts (A and B and C)', () => {
      expect(hasWarning(
        '(http.host eq "test.com" and http.request.method eq "POST" and ip.src.country eq "US")'
      )).toBe(false);
    });

    it('accepts A and (B or C)', () => {
      // Explicit grouping around the or — clear intent
      expect(hasWarning(
        '(http.host eq "media.example.com") and ((http.request.uri.path wildcard "*.jpg") or (http.request.uri.path wildcard "*.png"))'
      )).toBe(false);
    });
  });

  describe('does not flag simple expressions', () => {
    it('accepts single comparison', () => {
      expect(hasWarning('(http.host eq "test.com")')).toBe(false);
    });

    it('accepts all-and chain', () => {
      expect(hasWarning('http.host eq "test.com" and http.request.method eq "POST"')).toBe(false);
    });

    it('accepts all-or chain', () => {
      expect(hasWarning('http.host eq "a.com" or http.host eq "b.com"')).toBe(false);
    });

    it('accepts bare true', () => {
      expect(hasWarning('true')).toBe(false);
    });
  });

  describe('severity', () => {
    it('is a warning (not error or info)', () => {
      const result = validate(
        '(http.host eq "test.com") and (http.request.uri.path eq "/api") or (http.host eq "other.com")',
        { expressionType: 'filter' }
      );
      const d = result.diagnostics.find(d => d.code === 'ambiguous-precedence');
      expect(d?.severity).toBe('warning');
    });

    it('expression is still valid (warning not error)', () => {
      const result = validate(
        '(http.host eq "test.com") and (http.request.uri.path eq "/api") or (http.host eq "other.com")',
        { expressionType: 'filter' }
      );
      expect(result.valid).toBe(true);
    });
  });
});
