import { describe, it, expect } from 'vitest';
import { fixExpression } from '../fixer.js';
import { formatExpression } from '../formatter.js';
import { parse } from '../parser.js';
import { validate } from '../validator.js';

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

    it('strips double parens and merges: ((A and B)) and (C) → (A and B and C)', () => {
      expect(fix('((http.host eq "a.com" and http.request.method eq "POST")) and (cf.zone.plan eq "ENT")')).toBe(
        '(http.host eq "a.com" and http.request.method eq "POST" and cf.zone.plan eq "ENT")'
      );
    });

    it('strips double parens with not conditions', () => {
      expect(fix('((not http.host contains "mail" and not cf.bot_management.static_resource)) and (cf.zone.plan eq "ENT")')).toBe(
        '(not http.host contains "mail" and not cf.bot_management.static_resource and cf.zone.plan eq "ENT")'
      );
    });

    it('strips triple parens and merges', () => {
      expect(fix('(((http.host eq "a.com"))) and (http.host eq "b.com")')).toBe(
        '(http.host eq "a.com" and http.host eq "b.com")'
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

  describe('idempotency', () => {
    it('fix(fix(expr)) === fix(expr) for all fixable patterns', () => {
      const expressions = [
        'http.host eq "test.com"',
        '(http.host eq "a") and (http.host eq "b")',
        'not (http.cookie eq "a" or http.cookie eq "b")',
        '((http.host eq "a") or (http.host eq "b"))',
        '(http.host == "test.com") && (http.request.method != "POST")',
        '((http.user_agent contains "Bot") and (ip.src.asnum eq 15169))',
        'http.host eq "a" or http.host eq "b"',
      ];
      for (const expr of expressions) {
        const first = fix(expr);
        const second = fix(first);
        expect(second).toBe(first);
      }
    });

    it('already-fixed expression reports changed=false', () => {
      const alreadyFixed = [
        '(http.host eq "test.com")',
        '(http.host eq "a" and ip.src.country eq "US")',
        '(http.host eq "a.com") or (http.host eq "b.com")',
        '(not http.cookie contains "abc" and not http.cookie contains "xyz")',
      ];
      for (const expr of alreadyFixed) {
        const result = fixExpression(expr);
        expect(result.changed).toBe(false);
        expect(result.fixes).toHaveLength(0);
      }
    });
  });

  describe('named lists and negated in-expressions', () => {
    it('wraps bare named list expression', () => {
      expect(fix('ip.src in $my_allowlist')).toBe('(ip.src in $my_allowlist)');
    });

    it('wraps bare negated in-expression', () => {
      expect(fix('not ip.src in $blocklist')).toBe('(not ip.src in $blocklist)');
    });
  });

  describe('complex combined fixes', () => {
    it('De Morgan + operator style + structural rewrite', () => {
      const result = fix('not (http.cookie == "a" || http.cookie == "b") && (http.host == "test.com")');
      // Should: De Morgan the not(), convert operators, merge the and-groups
      expect(result).toContain('not http.cookie eq "a"');
      expect(result).toContain('not http.cookie eq "b"');
      expect(result).toContain('http.host eq "test.com"');
      expect(result).not.toContain('==');
      expect(result).not.toContain('||');
      expect(result).not.toContain('&&');
    });
  });

  describe('raw string preservation', () => {
    it('De Morgan preserves raw strings', () => {
      const result = fix('not (http.user_agent matches r"Bot.*" or http.user_agent matches r"Spider.*")');
      expect(result).toContain('r"Bot.*"');
      expect(result).toContain('r"Spider.*"');
    });

    it('raw strings survive operator style fix', () => {
      const result = fix('(http.request.uri.path ~ r"^/api/v[0-9]+")');
      expect(result).toBe('(http.request.uri.path matches r"^/api/v[0-9]+")');
    });

    it('raw strings survive merge and-groups', () => {
      const result = fix('(http.user_agent matches r"Bot.*") and (http.host eq "test.com")');
      expect(result).toContain('r"Bot.*"');
      expect(result).toContain('http.host eq "test.com"');
    });

    it('raw strings survive wrap or-branches', () => {
      const result = fix('http.request.uri.path wildcard r"*.jpg" or http.request.uri.path wildcard r"*.png"');
      expect(result).toContain('r"*.jpg"');
      expect(result).toContain('r"*.png"');
    });
  });

  describe('round-trip parsing', () => {
    it('fixed output parses without error', () => {
      const expressions = [
        'http.host eq "test.com"',
        '(http.host eq "a") and (http.host eq "b")',
        'not (http.cookie eq "a" or http.cookie eq "b")',
        '((http.host eq "a") or (http.host eq "b"))',
        '(http.host == "test.com") && (http.request.method != "POST")',
        '((http.user_agent contains "Bot") and (ip.src.asnum eq 15169))',
      ];
      for (const expr of expressions) {
        const fixed = fix(expr);
        expect(() => parse(fixed)).not.toThrow();
      }
    });

    it('fixed output validates without parse errors', () => {
      const expressions = [
        'http.host eq "test.com" and http.request.method eq "POST"',
        'not (http.cookie eq "a" or http.cookie eq "b") and http.host eq "test.com"',
        '(http.host == "a") || (http.host == "b")',
      ];
      for (const expr of expressions) {
        const fixed = fix(expr);
        const result = validate(fixed, { expressionType: 'filter' });
        expect(result.valid).toBe(true);
      }
    });
  });

  describe('rewrite expressions — no Builder wrapping', () => {
    it('does not wrap rewrite_url function calls', () => {
      const result = fixExpression('concat("/m", http.request.uri.path)', { expressionType: 'rewrite_url' });
      expect(result.expression).toBe('concat("/m", http.request.uri.path)');
      expect(result.changed).toBe(false);
    });

    it('does not wrap rewrite_header expressions', () => {
      const result = fixExpression('http.host', { expressionType: 'rewrite_header' });
      expect(result.expression).toBe('http.host');
      expect(result.changed).toBe(false);
    });

    it('does not wrap redirect_target expressions', () => {
      const result = fixExpression('concat("https://example.com", http.request.uri.path)', { expressionType: 'redirect_target' });
      expect(result.expression).toBe('concat("https://example.com", http.request.uri.path)');
      expect(result.changed).toBe(false);
    });

    it('still fixes operator style in rewrite expressions', () => {
      const result = fixExpression('regex_replace(http.request.uri.path, "^/old/", "/new/")', { expressionType: 'rewrite_url', operatorStyle: 'english' });
      // No operator to fix, but should not wrap
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

  describe('idempotency', () => {
    // Every expression that the fixer changes must be stable on re-fix.
    // If fix(fix(expr)) !== fix(expr), the convergence check will never pass.
    const expressions = [
      // Merge and-groups
      '(http.host eq "test.com") and (http.request.method eq "POST")',
      // Wrap bare expression
      'http.host eq "test.com"',
      // De Morgan
      'not (http.cookie eq "a" or http.cookie eq "b")',
      // De Morgan and-to-or
      'not (http.host eq "a" and http.host eq "b")',
      // Double-paren merge
      '((not http.host contains "mail" and any(http.request.headers["accept"][*] contains "text/html") and not cf.bot_management.static_resource)) and (cf.zone.plan eq "ENT")',
      // Triple-paren merge
      '(((http.host eq "a.com"))) and (http.host eq "b.com")',
      // Or-chain with bare branches
      'http.host eq "a.com" or http.host eq "b.com"',
      // Outer parens on or-chain
      '((http.host eq "a.com") or (http.host eq "b.com"))',
      // Unwrap individually-wrapped in and-group
      '((http.host eq "a.com") and (http.request.method eq "POST"))',
      // Bare and-chain
      'http.host eq "a.com" and http.request.method eq "POST"',
    ];

    for (const expr of expressions) {
      it(`fix is idempotent: ${expr.substring(0, 60)}${expr.length > 60 ? '...' : ''}`, () => {
        const first = fixExpression(expr).expression;
        const second = fixExpression(first).expression;
        expect(second).toBe(first);
      });
    }
  });

  describe('fix + format pipeline stability', () => {
    // After fix → format → re-parse (simulating >- round-trip) → fix,
    // the fixer must report no changes. This is the convergence contract.
    const expressions = [
      '(http.host eq "test.com") and (http.request.method eq "POST")',
      '((not http.host contains "mail" and not cf.bot_management.static_resource)) and (cf.zone.plan eq "ENT")',
      'not (http.cookie eq "a" or http.cookie eq "b")',
      '((http.host eq "a.com") or (http.host eq "b.com"))',
      'http.host eq "a.com" and http.request.method eq "POST" and http.request.uri.path eq "/api"',
    ];

    for (const expr of expressions) {
      it(`converges: ${expr.substring(0, 60)}${expr.length > 60 ? '...' : ''}`, () => {
        // Step 1: fix
        const fixed = fixExpression(expr).expression;
        // Step 2: format (simulates what --prettify/rewriteExpressions does)
        const formatted = formatExpression(fixed, { maxWidth: 120 });
        // Step 3: re-join lines (simulates YAML >- round-trip through scanner)
        const rejoined = formatted.split('\n').map((l: string) => l.trim()).join(' ');
        // Step 4: re-fix should report no changes
        const refixed = fixExpression(rejoined);
        expect(refixed.changed).toBe(false);
      });
    }
  });
});
