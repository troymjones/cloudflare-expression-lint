import { describe, it, expect } from 'vitest';
import { validate } from '../validator.js';
import type { Diagnostic } from '../types.js';

function diags(expr: string): Diagnostic[] {
  return validate(expr, { expressionType: 'filter' }).diagnostics;
}

function hasBuilderWarning(expr: string): boolean {
  return diags(expr).some(d => d.code === 'builder-incompatible');
}

function builderMsg(expr: string): string | undefined {
  return diags(expr).find(d => d.code === 'builder-incompatible')?.message;
}

describe('Expression Builder Compatibility', () => {
  // ── User-confirmed Builder-compatible examples ───────────────────
  // These are the exact patterns confirmed by testing in the Cloudflare
  // Expression Builder UI.

  describe('Builder-compatible (no warning)', () => {
    it('1. (A) — single comparison wrapped', () => {
      expect(hasBuilderWarning('(ip.src.country eq "AL")')).toBe(false);
    });

    it('2. (A) or (not B) — or-chain with not', () => {
      expect(hasBuilderWarning(
        '(ip.src.country eq "AL") or (not http.cookie contains "abc")'
      )).toBe(false);
    });

    it('3. (A) or (not B and C) — or with and-chain containing not', () => {
      expect(hasBuilderWarning(
        '(ip.src.country eq "AL") or (not http.cookie contains "abc" and http.host ne "abc.example.com")'
      )).toBe(false);
    });

    it('4. (A and B) or (not C) — and-groups in or-chain', () => {
      expect(hasBuilderWarning(
        '(ip.src.country eq "AL" and http.referer ne "abc.example.com") or (not http.user_agent matches r"abc.*")'
      )).toBe(false);
    });

    it('5. (A and B) — single and-chain wrapped', () => {
      expect(hasBuilderWarning(
        '(ip.src.country eq "AL" and http.referer ne "abc.example.com")'
      )).toBe(false);
    });

    it('6. (A and B) or (C and D) — or-chain of and-groups', () => {
      expect(hasBuilderWarning(
        '(ip.src.country eq "AL" and http.referer ne "abc.example.com") or (ip.src.country eq "US" and http.referer eq "abc.example.com")'
      )).toBe(false);
    });

    it('(not A) — not toggle on single condition', () => {
      expect(hasBuilderWarning('(not http.referer contains "abc.example.com")')).toBe(false);
    });

    it('(not A and not B) — multiple not toggles in group', () => {
      expect(hasBuilderWarning(
        '(not http.cookie contains "abc" and not http.cookie contains "troyj")'
      )).toBe(false);
    });

    it('(A and B and C) — three-way and-chain wrapped', () => {
      expect(hasBuilderWarning(
        '(http.cookie eq "abc" and ip.src.country eq "AL" and ip.src.continent eq "EU")'
      )).toBe(false);
    });

    it('(A) or (B) or (C) — simple three-way or', () => {
      expect(hasBuilderWarning(
        '(http.request.uri.path eq "/a") or (http.request.uri.path eq "/b") or (http.request.uri.path eq "/c")'
      )).toBe(false);
    });

    it('accepts bare true', () => {
      expect(hasBuilderWarning('true')).toBe(false);
    });

    it('accepts bare boolean field', () => {
      expect(hasBuilderWarning('ssl')).toBe(false);
    });

    it('accepts (ssl) wrapped boolean field', () => {
      expect(hasBuilderWarning('(ssl)')).toBe(false);
    });

    it('accepts (in-expression)', () => {
      expect(hasBuilderWarning('(ip.src.country in {"US" "JP"})')).toBe(false);
    });

    it('accepts (in named list)', () => {
      expect(hasBuilderWarning('(ip.src in $my_allowlist)')).toBe(false);
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

    it('accepts many or-branches all wrapped', () => {
      const branches = Array.from({ length: 10 }, (_, i) =>
        `(http.request.uri.path eq "/path${i}")`
      ).join(' or ');
      expect(hasBuilderWarning(branches)).toBe(false);
    });

    it('accepts not in and-chain inside group', () => {
      expect(hasBuilderWarning(
        '(ip.src in $list and not http.request.uri.path matches "^/auth/")'
      )).toBe(false);
    });

    it('accepts full complex example', () => {
      expect(hasBuilderWarning(
        '(http.cookie eq "abc" and ip.src.country eq "AL" and ip.src.continent eq "EU") or (ip.src.country ne "AF" and http.host wildcard "*.example.com") or (ip.src eq 192.0.2.1)'
      )).toBe(false);
    });
  });

  // ── User-confirmed NOT Builder-compatible ────────────────────────

  describe('NOT Builder-compatible (should warn)', () => {
    it('a. (A) and (B) — and between groups', () => {
      expect(hasBuilderWarning(
        '(ip.src.country eq "AL") and (http.referer ne "abc.example.com")'
      )).toBe(true);
      expect(builderMsg(
        '(ip.src.country eq "AL") and (http.referer ne "abc.example.com")'
      )).toContain('Merge');
    });

    it('b. A or B — bare or-chain, no wrapping', () => {
      expect(hasBuilderWarning(
        'ip.src.country eq "AL" or http.referer ne "abc.example.com"'
      )).toBe(true);
    });

    it('c. A and B — bare and-chain, no wrapping', () => {
      expect(hasBuilderWarning(
        'ip.src.country eq "AL" and http.referer ne "abc.example.com"'
      )).toBe(true);
    });

    it('d. (A or B) — or inside a single group', () => {
      expect(hasBuilderWarning(
        '(ip.src.country eq "AL" or http.referer ne "abc.example.com")'
      )).toBe(true);
    });

    it('e. (A and B) and (C and D) — and between groups', () => {
      expect(hasBuilderWarning(
        '(ip.src.country eq "AL" and http.referer ne "abc.example.com") and (ip.src.country eq "US" and http.referer eq "abc.example.com")'
      )).toBe(true);
    });

    it('f. (A or B) and (C or D) — and between or-groups', () => {
      expect(hasBuilderWarning(
        '(ip.src.country eq "AL" or http.referer ne "abc.example.com") and (ip.src.country eq "US" or http.referer eq "abc.example.com")'
      )).toBe(true);
    });

    it('not (A) — not outside the group', () => {
      expect(hasBuilderWarning(
        'not (http.referer contains "abc.example.com")'
      )).toBe(true);
      expect(builderMsg(
        'not (http.referer contains "abc.example.com")'
      )).toContain('not');
    });

    it('not (A or B) — suggests De Morgan rewrite', () => {
      expect(hasBuilderWarning(
        'not (http.cookie eq "troyj" or http.cookie eq "abc")'
      )).toBe(true);
      expect(builderMsg(
        'not (http.cookie eq "troyj" or http.cookie eq "abc")'
      )).toContain('De Morgan');
    });

    it('not (A and B) — suggests De Morgan rewrite', () => {
      expect(hasBuilderWarning(
        'not (http.cookie eq "troyj" and http.cookie eq "abc")'
      )).toBe(true);
      expect(builderMsg(
        'not (http.cookie eq "troyj" and http.cookie eq "abc")'
      )).toContain('De Morgan');
    });

    it('((A or B) and C and D) — nested or inside and-group', () => {
      expect(hasBuilderWarning(
        '((http.host eq "example.com" or http.host eq "www.example.com") and http.request.uri.path eq "/page" and ip.src.country eq "CA")'
      )).toBe(true);
    });

    it('((A) or (B)) — outer parens around or-chain', () => {
      expect(hasBuilderWarning(
        '((http.host eq "a.example.com") or (http.host eq "b.example.com"))'
      )).toBe(true);
    });

    it('bare unwrapped single comparison', () => {
      expect(hasBuilderWarning('http.host eq "test.com"')).toBe(true);
    });

    it('bare unwrapped in-expression', () => {
      expect(hasBuilderWarning('ip.src.country in {"US" "JP"}')).toBe(true);
    });

    it('bare not at top level', () => {
      expect(hasBuilderWarning('not ssl')).toBe(true);
    });

    it('bare not comparison at top level', () => {
      expect(hasBuilderWarning('not http.host eq "test"')).toBe(true);
    });

    it('mixed wrapped and unwrapped or-branches', () => {
      expect(hasBuilderWarning(
        '(http.host eq "test.com") or http.request.method eq "POST"'
      )).toBe(true);
    });

    it('flags many or-branches with some unwrapped', () => {
      const branches = [
        '(http.request.uri.path eq "/a")',
        'http.request.uri.path eq "/b"',
        '(http.request.uri.path eq "/c")',
      ].join(' or ');
      expect(hasBuilderWarning(branches)).toBe(true);
    });
  });

  // ── Complex expressions (functions etc — skipped) ────────────────

  describe('complex expressions skipped', () => {
    it('skips function calls at top level', () => {
      expect(hasBuilderWarning('starts_with(http.request.uri.path, "/admin")')).toBe(false);
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

    it('skips xor operator', () => {
      expect(hasBuilderWarning('http.host eq "a" xor http.host eq "b"')).toBe(false);
    });
  });

  // ── Severity and context ─────────────────────────────────────────

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

    it('checks filter part of account-level expressions', () => {
      // Wrapped filter + ENT — should pass
      const r1 = validate('(http.host eq "test.com") and (cf.zone.plan eq "ENT")', {
        expressionType: 'filter', accountLevel: true,
      });
      expect(r1.diagnostics.some(d => d.code === 'builder-incompatible')).toBe(false);

      // Unwrapped filter + ENT — should flag
      const r2 = validate('http.host eq "test.com" and (cf.zone.plan eq "ENT")', {
        expressionType: 'filter', accountLevel: true,
      });
      expect(r2.diagnostics.some(d => d.code === 'builder-incompatible')).toBe(true);

      // Standalone ENT — should pass
      const r3 = validate('(cf.zone.plan eq "ENT")', {
        expressionType: 'filter', accountLevel: true,
      });
      expect(r3.diagnostics.some(d => d.code === 'builder-incompatible')).toBe(false);

      // Wrapped and-chain + ENT — should pass
      const r4 = validate('(http.host eq "test.com" and http.request.method eq "POST") and (cf.zone.plan eq "ENT")', {
        expressionType: 'filter', accountLevel: true,
      });
      expect(r4.diagnostics.some(d => d.code === 'builder-incompatible')).toBe(false);
    });
  });
});
