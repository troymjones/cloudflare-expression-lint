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

  describe('already Builder-compatible', () => {
    it('accepts (single comparison)', () => {
      expect(hasBuilderWarning('(http.host eq "test.com")')).toBe(false);
    });

    it('accepts (single in-expression)', () => {
      expect(hasBuilderWarning('(ip.src.country in {"US" "JP"})')).toBe(false);
    });

    it('accepts (A and B and C) — all-and in one group', () => {
      expect(hasBuilderWarning(
        '(http.cookie eq "abc" and ip.src.country eq "AL" and ip.src.continent eq "EU")'
      )).toBe(false);
    });

    it('accepts (A and B) or (C and D) or (E) — or-branches wrapped', () => {
      expect(hasBuilderWarning(
        '(http.cookie eq "abc" and ip.src.country eq "AL") or (ip.src.country ne "AF" and http.host wildcard "*.example.com") or (ip.src eq 192.0.2.1)'
      )).toBe(false);
    });

    it('accepts (A) or (B) or (C) — simple or-chain wrapped', () => {
      expect(hasBuilderWarning(
        '(http.request.uri.path eq "/my") or (http.request.uri.path eq "/myjobs") or (http.request.uri.path eq "/my/myjobs")'
      )).toBe(false);
    });

    it('accepts bare true', () => {
      expect(hasBuilderWarning('true')).toBe(false);
    });

    it('accepts bare boolean field', () => {
      expect(hasBuilderWarning('ssl')).toBe(false);
    });
  });

  // ── Simple but needs formatting (should warn) ──────────────────────

  describe('simple expressions needing Builder formatting', () => {
    it('flags unwrapped single comparison', () => {
      expect(hasBuilderWarning('http.host eq "test.com"')).toBe(true);
    });

    it('flags unwrapped in-expression', () => {
      expect(hasBuilderWarning('ip.src.country in {"US" "JP"}')).toBe(true);
    });

    it('flags unwrapped all-and chain', () => {
      expect(hasBuilderWarning(
        'http.host eq "test.com" and http.request.method eq "POST"'
      )).toBe(true);
    });

    it('flags or-chain where some branches lack parens', () => {
      expect(hasBuilderWarning(
        'http.request.uri.path eq "/my" or http.request.uri.path eq "/myjobs"'
      )).toBe(true);
    });

    it('flags mixed wrapped and unwrapped or-branches', () => {
      expect(hasBuilderWarning(
        '(http.host eq "test.com") or http.request.method eq "POST"'
      )).toBe(true);
    });

    it('flags unwrapped and-group in or-chain', () => {
      expect(hasBuilderWarning(
        'http.host eq "a.com" and ip.src.country eq "US" or (http.host eq "b.com")'
      )).toBe(true);
    });
  });

  // ── Complex expressions (silently skipped) ─────────────────────────

  describe('complex expressions skipped', () => {
    it('skips function calls', () => {
      expect(hasBuilderWarning('starts_with(http.request.uri.path, "/admin")')).toBe(false);
    });

    it('skips not expressions', () => {
      expect(hasBuilderWarning('not ssl')).toBe(false);
    });

    it('skips expressions with function calls in comparisons', () => {
      expect(hasBuilderWarning('lower(http.host) eq "test.com"')).toBe(false);
    });

    it('skips expressions with array unpack', () => {
      expect(hasBuilderWarning(
        'any(http.request.headers["accept"][*] contains "text/html")'
      )).toBe(false);
    });

    it('skips and-chain with function calls', () => {
      expect(hasBuilderWarning(
        'starts_with(http.request.uri.path, "/admin") and http.host eq "test.com"'
      )).toBe(false);
    });

    it('skips or-branch containing function call', () => {
      expect(hasBuilderWarning(
        '(http.host eq "test.com") or starts_with(http.request.uri.path, "/admin")'
      )).toBe(false);
    });
  });

  // ── Edge cases ─────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('skips not inside a branch', () => {
      // not is not Builder-compatible
      expect(hasBuilderWarning('(not ssl) or (http.host eq "test")')).toBe(false);
    });

    it('skips xor operator', () => {
      expect(hasBuilderWarning('http.host eq "a" xor http.host eq "b"')).toBe(false);
    });

    it('accepts in-expression with named list wrapped', () => {
      expect(hasBuilderWarning('(ip.src in $my_allowlist)')).toBe(false);
    });

    it('accepts many or-branches all wrapped', () => {
      const branches = Array.from({ length: 10 }, (_, i) =>
        `(http.request.uri.path eq "/path${i}")`
      ).join(' or ');
      expect(hasBuilderWarning(branches)).toBe(false);
    });

    it('flags many or-branches with some unwrapped', () => {
      const branches = [
        '(http.request.uri.path eq "/a")',
        'http.request.uri.path eq "/b"',
        '(http.request.uri.path eq "/c")',
      ].join(' or ');
      expect(hasBuilderWarning(branches)).toBe(true);
    });

    it('accepts boolean field wrapped', () => {
      expect(hasBuilderWarning('(ssl)')).toBe(false);
    });

    it('accepts wildcard operator wrapped', () => {
      expect(hasBuilderWarning('(http.host wildcard "*.example.com")')).toBe(false);
    });

    it('accepts matches operator wrapped', () => {
      expect(hasBuilderWarning('(http.request.uri.path matches "^/api/")')).toBe(false);
    });

    it('accepts raw string in comparison', () => {
      expect(hasBuilderWarning('(http.request.uri.path matches r"^/api/")')).toBe(false);
    });

    it('accepts the full example from docs', () => {
      expect(hasBuilderWarning(
        '(http.cookie eq "abc" and ip.src.country eq "AL" and ip.src.continent eq "EU") or (ip.src.country ne "AF" and http.host wildcard "*.example.com") or (ip.src eq 192.0.2.1)'
      )).toBe(false);
    });

    it('flags or-chain inside outer parens where clauses are unwrapped', () => {
      // ( A or B or C ) — outer group with unwrapped or-clauses inside
      expect(hasBuilderWarning(
        '(http.host eq "a" or http.host eq "b" or http.host eq "c")'
      )).toBe(true);
    });

    it('skips not at top level', () => {
      expect(hasBuilderWarning('not http.host eq "test"')).toBe(false);
    });

    it('skips expression with not in and-chain', () => {
      expect(hasBuilderWarning(
        '(ip.src in $list and not http.request.uri.path matches "^/auth/")'
      )).toBe(false);
    });
  });

  // ── Severity and context ───────────────────────────────────────────

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

    it('skips account-level expressions', () => {
      const result = validate('(http.host eq "test.com") and (cf.zone.plan eq "ENT")', {
        expressionType: 'filter',
        accountLevel: true,
      });
      expect(result.diagnostics.some(d => d.code === 'builder-incompatible')).toBe(false);
    });
  });
});
