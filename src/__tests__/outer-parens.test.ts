import { describe, it, expect } from 'vitest';
import { validate } from '../validator.js';
import type { Diagnostic } from '../types.js';

function diags(expr: string): Diagnostic[] {
  return validate(expr, { expressionType: 'filter' }).diagnostics;
}

function hasParen(expr: string): boolean {
  return diags(expr).some(d => d.code === 'no-outer-parens');
}

describe('Outer Parentheses Check (Expression Builder Compatibility)', () => {
  // ── Should NOT flag (already compatible) ───────────────────────────

  describe('expressions that are already Builder-compatible', () => {
    it('does not flag wrapped simple comparison', () => {
      expect(hasParen('(http.request.uri eq "/content")')).toBe(false);
    });

    it('does not flag wrapped compound expression', () => {
      expect(hasParen('(http.request.uri eq "/content" and http.host eq "example.com")')).toBe(false);
    });

    it('does not flag wrapped in-expression', () => {
      expect(hasParen('(ip.src.country in {"US" "JP"})')).toBe(false);
    });

    it('does not flag bare "true"', () => {
      expect(hasParen('true')).toBe(false);
    });

    it('does not flag bare "false"', () => {
      expect(hasParen('false')).toBe(false);
    });

    it('does not flag bare boolean field', () => {
      expect(hasParen('ssl')).toBe(false);
    });

    it('does not flag bare cf.bot_management.verified_bot', () => {
      expect(hasParen('cf.bot_management.verified_bot')).toBe(false);
    });

    it('does not flag negated boolean field', () => {
      expect(hasParen('not ssl')).toBe(false);
    });

    it('does not flag top-level function call', () => {
      expect(hasParen('starts_with(http.request.uri.path, "/admin")')).toBe(false);
    });

    it('does not flag nested groups', () => {
      expect(hasParen('((http.host eq "a.com") or (http.host eq "b.com"))')).toBe(false);
    });
  });

  // ── Should flag (not Builder-compatible) ───────────────────────────

  describe('expressions missing outer parentheses', () => {
    it('flags unwrapped simple comparison', () => {
      expect(hasParen('http.request.uri eq "/content"')).toBe(true);
    });

    it('flags unwrapped compound expression', () => {
      expect(hasParen('http.host eq "a.com" and http.request.method eq "POST"')).toBe(true);
    });

    it('flags unwrapped in-expression', () => {
      expect(hasParen('ip.src.country in {"US" "JP"}')).toBe(true);
    });

    it('flags unwrapped or-chain', () => {
      expect(hasParen('http.host eq "a.com" or http.host eq "b.com"')).toBe(true);
    });

    it('flags unwrapped negated comparison', () => {
      expect(hasParen('not ip.src.country in {"US"}')).toBe(true);
    });
  });

  // ── Severity and validity ──────────────────────────────────────────

  describe('diagnostic properties', () => {
    it('is info severity (not error or warning)', () => {
      const d = diags('http.host eq "test"').find(d => d.code === 'no-outer-parens');
      expect(d?.severity).toBe('info');
    });

    it('does not affect validity', () => {
      const result = validate('http.host eq "test.com"', { expressionType: 'filter' });
      expect(result.valid).toBe(true);
    });
  });

  // ── requireOuterParentheses opt-in error mode ──────────────────────

  describe('requireOuterParentheses option', () => {
    it('makes missing parens an error when enabled', () => {
      const result = validate('http.host eq "test.com"', {
        expressionType: 'filter',
        requireOuterParentheses: true,
      });
      const d = result.diagnostics.find(d => d.code === 'no-outer-parens');
      expect(d?.severity).toBe('error');
      expect(result.valid).toBe(false);
    });

    it('passes when parens are present and option is enabled', () => {
      const result = validate('(http.host eq "test.com")', {
        expressionType: 'filter',
        requireOuterParentheses: true,
      });
      expect(result.diagnostics.some(d => d.code === 'no-outer-parens')).toBe(false);
      expect(result.valid).toBe(true);
    });

    it('defaults to info when option is not set', () => {
      const result = validate('http.host eq "test.com"', {
        expressionType: 'filter',
      });
      const d = result.diagnostics.find(d => d.code === 'no-outer-parens');
      expect(d?.severity).toBe('info');
      expect(result.valid).toBe(true);
    });
  });

  // ── Only applies to filter expressions ─────────────────────────────

  describe('context restriction', () => {
    it('does not flag rewrite expressions', () => {
      const result = validate('concat("/m", http.request.uri.path)', { expressionType: 'rewrite_url' });
      expect(result.diagnostics.some(d => d.code === 'no-outer-parens')).toBe(false);
    });

    it('does not flag redirect target expressions', () => {
      const result = validate('concat("https://example.com", http.request.uri.path)', { expressionType: 'redirect_target' });
      expect(result.diagnostics.some(d => d.code === 'no-outer-parens')).toBe(false);
    });
  });
});
