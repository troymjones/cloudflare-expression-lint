import { describe, it, expect } from 'vitest';
import { fixExpression } from '../fixer.js';

function fix(expr: string, operatorStyle?: 'english' | 'clike' | 'off'): string {
  return fixExpression(expr, { operatorStyle }).expression;
}

function fixes(expr: string, operatorStyle?: 'english' | 'clike' | 'off'): string[] {
  return fixExpression(expr, { operatorStyle }).fixes;
}

describe('Auto-fixer', () => {
  describe('wrap bare expressions', () => {
    it('wraps bare comparison', () => {
      expect(fix('http.host eq "test.com"')).toBe('(http.host eq "test.com")');
    });

    it('wraps bare in-expression', () => {
      expect(fix('ip.src.country in {"US" "JP"}')).toBe('(ip.src.country in {"US" "JP"})');
    });

    it('wraps bare function call', () => {
      expect(fix('starts_with(http.request.uri.path, "/api")')).toBe(
        '(starts_with(http.request.uri.path, "/api"))'
      );
    });

    it('wraps bare not expression', () => {
      expect(fix('not http.host eq "test.com"')).toBe('(not http.host eq "test.com")');
    });

    it('does not wrap already-wrapped expression', () => {
      const expr = '(http.host eq "test.com")';
      expect(fix(expr)).toBe(expr);
    });
  });

  describe('wrap bare and-chain', () => {
    it('wraps A and B', () => {
      expect(fix('http.host eq "a.com" and ip.src.country eq "US"')).toBe(
        '(http.host eq "a.com" and ip.src.country eq "US")'
      );
    });

    it('does not wrap already-wrapped and-chain', () => {
      const expr = '(http.host eq "a.com" and ip.src.country eq "US")';
      expect(fix(expr)).toBe(expr);
    });
  });

  describe('merge and-groups: (A) and (B) → (A and B)', () => {
    it('merges two groups', () => {
      expect(fix('(http.host eq "test.com") and (http.request.method eq "POST")')).toBe(
        '(http.host eq "test.com" and http.request.method eq "POST")'
      );
    });

    it('merges three groups', () => {
      expect(fix('(http.host eq "a") and (http.host eq "b") and (http.host eq "c")')).toBe(
        '(http.host eq "a" and http.host eq "b" and http.host eq "c")'
      );
    });

    it('merges groups with not', () => {
      expect(fix('(http.host eq "test.com") and (not ip.src in $blocklist)')).toBe(
        '(http.host eq "test.com" and not ip.src in $blocklist)'
      );
    });
  });

  describe('wrap or-branches', () => {
    it('wraps bare or-branches', () => {
      expect(fix('http.host eq "a.com" or http.host eq "b.com"')).toBe(
        '(http.host eq "a.com") or (http.host eq "b.com")'
      );
    });

    it('wraps mixed wrapped/bare or-branches', () => {
      expect(fix('(http.host eq "a.com") or http.host eq "b.com"')).toBe(
        '(http.host eq "a.com") or (http.host eq "b.com")'
      );
    });
  });

  describe('remove outer parens from or-chain', () => {
    it('removes outer parens: ((A) or (B)) → (A) or (B)', () => {
      expect(fix('((http.host eq "a.com") or (http.host eq "b.com"))')).toBe(
        '(http.host eq "a.com") or (http.host eq "b.com")'
      );
    });
  });

  describe('unwrap individually-wrapped and-conditions', () => {
    it('unwraps ((A) and (B) and (C)) → (A and B and C)', () => {
      expect(fix('((http.host eq "a") and (http.host eq "b") and (http.host eq "c"))')).toBe(
        '(http.host eq "a" and http.host eq "b" and http.host eq "c")'
      );
    });

    it('unwraps in or-branch: (X) or ((A) and (B)) → (X) or (A and B)', () => {
      expect(fix('(http.host eq "x") or ((http.host eq "a") and (http.host eq "b"))')).toBe(
        '(http.host eq "x") or (http.host eq "a" and http.host eq "b")'
      );
    });
  });

  describe('De Morgan rewrites', () => {
    it('not (A or B) → (not A and not B)', () => {
      expect(fix('not (http.cookie eq "a" or http.cookie eq "b")')).toBe(
        '(not http.cookie eq "a" and not http.cookie eq "b")'
      );
    });

    it('not (A and B) → (not A) or (not B)', () => {
      expect(fix('not (http.cookie eq "a" and http.cookie eq "b")')).toBe(
        '(not http.cookie eq "a") or (not http.cookie eq "b")'
      );
    });

    it('preserves double negation: not (not A) → A', () => {
      // not wrapping not → operand comes through
      const result = fix('not (not http.host eq "test.com")');
      expect(result).toContain('http.host eq "test.com"');
      expect(result).not.toContain('not not');
    });
  });

  describe('operator style', () => {
    it('fixes C-like to English (default)', () => {
      expect(fix('(http.host == "test.com")')).toBe('(http.host eq "test.com")');
    });

    it('fixes multiple C-like operators', () => {
      expect(fix('(http.response.code >= 400) && (http.response.code < 500)')).toBe(
        '(http.response.code ge 400 and http.response.code lt 500)'
      );
    });

    it('fixes ~ to matches', () => {
      expect(fix('(http.request.uri.path ~ "^/api")')).toBe(
        '(http.request.uri.path matches "^/api")'
      );
    });

    it('preserves raw string r"" prefix', () => {
      expect(fix('http.request.uri.path wildcard r"*.jpg" or http.request.uri.path wildcard r"*.png"')).toBe(
        '(http.request.uri.path wildcard r"*.jpg") or (http.request.uri.path wildcard r"*.png")'
      );
    });

    it('preserves raw string in regex', () => {
      expect(fix('(http.user_agent matches r"Mozilla\\/5\\.0.*Chrome")')).toBe(
        '(http.user_agent matches r"Mozilla\\/5\\.0.*Chrome")'
      );
    });

    it('fixes English to C-like when configured', () => {
      expect(fix('(http.host eq "test.com")', 'clike')).toBe('(http.host == "test.com")');
    });

    it('skips operator style when off', () => {
      expect(fix('(http.host == "test.com")', 'off')).toBe('(http.host == "test.com")');
    });
  });

  describe('combined fixes', () => {
    it('fixes operator style and wraps', () => {
      expect(fix('http.host == "test.com"')).toBe('(http.host eq "test.com")');
    });

    it('fixes operator style and merges and-groups', () => {
      expect(fix('(http.host == "a") && (http.host != "b")')).toBe(
        '(http.host eq "a" and http.host ne "b")'
      );
    });

    it('De Morgan + operator style', () => {
      expect(fix('not (http.cookie == "a" || http.cookie == "b")')).toBe(
        '(not http.cookie eq "a" and not http.cookie eq "b")'
      );
    });
  });

  describe('no changes needed', () => {
    it('returns unchanged for already-correct expression', () => {
      const expr = '(http.host eq "test.com" and ip.src.country eq "US")';
      const result = fixExpression(expr);
      expect(result.changed).toBe(false);
      expect(result.fixes).toHaveLength(0);
    });

    it('returns unchanged for complex or-chain', () => {
      const expr = '(http.host eq "a.com") or (http.host eq "b.com" and ip.src.country eq "US")';
      const result = fixExpression(expr);
      expect(result.changed).toBe(false);
    });
  });

  describe('preserves unfixable expressions', () => {
    it('does not distribute or-inside-and', () => {
      const expr = '((http.host eq "a" or http.host eq "b") and http.request.uri.path eq "/api")';
      const result = fix(expr);
      // Should not be rewritten — distribution not applied
      expect(result).toContain('or');
      expect(result).toContain('and');
    });

    it('does not change unparseable expression', () => {
      expect(fix('this is not valid {')).toBe('this is not valid {');
    });
  });

  describe('fix descriptions', () => {
    it('reports operator fixes', () => {
      expect(fixes('(http.host == "test.com")')).toContain('operator: == → eq');
    });

    it('reports wrap fix', () => {
      expect(fixes('http.host eq "test.com"')).toContain('wrap bare expression in parentheses');
    });

    it('reports merge fix', () => {
      const f = fixes('(http.host eq "a") and (http.host eq "b")');
      expect(f.some(s => s.includes('merge'))).toBe(true);
    });

    it('reports De Morgan fix', () => {
      const f = fixes('not (http.cookie eq "a" or http.cookie eq "b")');
      expect(f.some(s => s.includes('De Morgan'))).toBe(true);
    });
  });
});
