import { describe, it, expect } from 'vitest';
import { fixExpression } from '../fixer.js';
import { validate } from '../validator.js';

const UNWRAPPED_AND = 'http.host eq "a.com" and http.request.method eq "POST"';
const DE_MORGAN = 'not (http.host eq "a.com" and http.request.method eq "POST")';
const CLIKE = 'http.host == "a.com" and http.request.method == "POST"';

function fix(expr: string, fixOnly?: string[]) {
  return fixExpression(expr, fixOnly ? { fixOnly } : undefined);
}

describe('fixOnly', () => {
  describe('scoping', () => {
    it('applies every fix when omitted', () => {
      const r = fix(DE_MORGAN);
      expect(r.changed).toBe(true);
      expect(r.fixes.join()).toContain('De Morgan');
    });

    it('treats an empty array as unrestricted', () => {
      expect(fix(DE_MORGAN, []).changed).toBe(true);
    });

    it('skips De Morgan when only builder-unwrapped is requested', () => {
      const r = fix(DE_MORGAN, ['builder-unwrapped']);
      expect(r.changed).toBe(false);
      expect(r.expression).toBe(DE_MORGAN);
    });

    it('still wraps an unwrapped and-chain', () => {
      const r = fix(UNWRAPPED_AND, ['builder-unwrapped']);
      expect(r.expression).toBe(`(${UNWRAPPED_AND})`);
      expect(r.fixes).toEqual(['wrap and-chain in parentheses']);
    });

    it('still wraps a bare comparison', () => {
      expect(fix('http.host eq "a.com"', ['builder-unwrapped']).expression)
        .toBe('(http.host eq "a.com")');
    });

    it('still wraps a bare not condition', () => {
      expect(fix('not http.host eq "a.com"', ['builder-unwrapped']).expression)
        .toBe('(not http.host eq "a.com")');
    });

    it('leaves operator style alone when only builder-unwrapped is requested', () => {
      const r = fix(CLIKE, ['builder-unwrapped']);
      expect(r.expression).toContain('==');
      expect(r.fixes.join()).not.toContain('operator');
    });

    it('normalises operators when that code is requested', () => {
      const r = fix(CLIKE, ['prefer-english-operator']);
      expect(r.expression).toContain(' eq ');
      expect(r.expression).not.toContain('==');
    });

    it('accepts multiple codes', () => {
      const r = fix(CLIKE, ['prefer-english-operator', 'builder-unwrapped']);
      expect(r.expression).toBe(`(${UNWRAPPED_AND})`);
    });

    it('does not remove outer parens from an or-chain', () => {
      const expr = '((http.host eq "a.com") or (http.host eq "b.com"))';
      expect(fix(expr, ['builder-unwrapped']).changed).toBe(false);
    });

    it('does not merge (A) and (B)', () => {
      const expr = '(http.host eq "a.com") and (http.request.method eq "POST")';
      expect(fix(expr, ['builder-unwrapped']).changed).toBe(false);
    });

    it('does not collapse an or-eq chain to an in-list', () => {
      const expr = '(http.host eq "a") or (http.host eq "b") or (http.host eq "c")';
      expect(fix(expr, ['builder-unwrapped']).changed).toBe(false);
    });

    it('does not rewrite not ... eq to ne', () => {
      const expr = '(http.host eq "a.com" and not (http.request.uri.path eq "/x"))';
      expect(fix(expr, ['builder-unwrapped']).changed).toBe(false);
    });
  });

  // A scoped run that touches an expression the linter never flagged with that
  // code would fail a --check gate for no reportable reason.
  describe('agrees with the diagnostics it names', () => {
    function unwrappedCount(expr: string): number {
      return validate(expr, { expressionType: 'filter' })
        .diagnostics.filter(d => d.code === 'builder-unwrapped').length;
    }

    const cases = [
      'concat(http.host, http.request.uri.path) wildcard r"*/login"',
      'lower(http.host) eq "a.com"',
      'not (http.request.uri.path eq "/a" or http.request.uri.path eq "/b") and http.host eq "a.com"',
      'ssl',
      'true',
      '(http.host eq "a.com")',
    ];

    for (const expr of cases) {
      it(`does not touch: ${expr.slice(0, 48)}`, () => {
        expect(unwrappedCount(expr)).toBe(0);
        expect(fix(expr, ['builder-unwrapped']).changed).toBe(false);
      });
    }

    for (const expr of [UNWRAPPED_AND, 'http.host eq "a.com"', 'not http.host eq "a.com"']) {
      it(`does touch: ${expr.slice(0, 48)}`, () => {
        expect(unwrappedCount(expr)).toBe(1);
        expect(fix(expr, ['builder-unwrapped']).changed).toBe(true);
      });
    }
  });
});
