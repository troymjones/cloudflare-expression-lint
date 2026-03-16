import { describe, it, expect } from 'vitest';
import { parse } from '../parser.js';
import type { ASTNode } from '../types.js';

/** Helper: parse and return the AST node kind */
function kind(expr: string): string {
  return parse(expr).kind;
}

describe('Parser', () => {
  // ── Literals ───────────────────────────────────────────────────────

  describe('literals', () => {
    it('parses "true" as a boolean literal', () => {
      const ast = parse('true');
      expect(ast.kind).toBe('BooleanLiteral');
      if (ast.kind === 'BooleanLiteral') {
        expect(ast.value).toBe(true);
      }
    });

    it('parses "false" as a boolean literal', () => {
      const ast = parse('false');
      expect(ast.kind).toBe('BooleanLiteral');
    });
  });

  // ── Simple Comparisons ─────────────────────────────────────────────

  describe('simple comparisons', () => {
    it('parses field eq string', () => {
      const ast = parse('http.host eq "example.com"');
      expect(ast.kind).toBe('Comparison');
      if (ast.kind === 'Comparison') {
        expect(ast.operator).toBe('eq');
        expect(ast.left.kind).toBe('FieldAccess');
        expect(ast.right.kind).toBe('StringLiteral');
      }
    });

    it('parses field == string (C-like)', () => {
      const ast = parse('http.host == "example.com"');
      expect(ast.kind).toBe('Comparison');
      if (ast.kind === 'Comparison') {
        expect(ast.operator).toBe('==');
      }
    });

    it('parses field ne string', () => {
      const ast = parse('http.request.method ne "GET"');
      expect(ast.kind).toBe('Comparison');
    });

    it('parses field gt integer', () => {
      const ast = parse('cf.bot_management.score gt 30');
      expect(ast.kind).toBe('Comparison');
      if (ast.kind === 'Comparison') {
        expect(ast.operator).toBe('gt');
        expect(ast.right.kind).toBe('IntegerLiteral');
      }
    });

    it('parses field contains string', () => {
      const ast = parse('http.user_agent contains "Googlebot"');
      expect(ast.kind).toBe('Comparison');
      if (ast.kind === 'Comparison') {
        expect(ast.operator).toBe('contains');
      }
    });

    it('parses field matches regex', () => {
      const ast = parse('http.request.uri.path matches "^/api/v[0-9]+/"');
      expect(ast.kind).toBe('Comparison');
    });

    it('parses field wildcard pattern', () => {
      const ast = parse('http.host wildcard "*.example.com"');
      expect(ast.kind).toBe('Comparison');
      if (ast.kind === 'Comparison') {
        expect(ast.operator).toBe('wildcard');
      }
    });

    it('parses field strict wildcard pattern', () => {
      const ast = parse('http.host strict wildcard "*.Example.com"');
      expect(ast.kind).toBe('Comparison');
      if (ast.kind === 'Comparison') {
        expect(ast.operator).toBe('strict wildcard');
      }
    });
  });

  // ── Boolean Field Expressions ──────────────────────────────────────

  describe('boolean field expressions', () => {
    it('parses bare boolean field (ssl)', () => {
      const ast = parse('ssl');
      expect(ast.kind).toBe('FieldAccess');
    });

    it('parses bare boolean field (cf.bot_management.verified_bot)', () => {
      const ast = parse('cf.bot_management.verified_bot');
      expect(ast.kind).toBe('FieldAccess');
    });
  });

  // ── In Expressions ─────────────────────────────────────────────────

  describe('in expressions', () => {
    it('parses field in string list', () => {
      const ast = parse('ip.src.country in {"US" "JP" "DE"}');
      expect(ast.kind).toBe('InExpression');
      if (ast.kind === 'InExpression') {
        expect(ast.negated).toBe(false);
        expect(ast.values.length).toBe(3);
      }
    });

    it('parses not field in list', () => {
      const ast = parse('not ip.src.country in {"US" "JP"}');
      expect(ast.kind).toBe('InExpression');
      if (ast.kind === 'InExpression') {
        expect(ast.negated).toBe(true);
      }
    });

    it('parses field in named list', () => {
      const ast = parse('ip.src in $allow_ips_auto_merged');
      expect(ast.kind).toBe('InExpression');
      if (ast.kind === 'InExpression') {
        expect(ast.values.length).toBe(1);
        expect(ast.values[0].kind).toBe('NamedList');
      }
    });

    it('parses field in list with CIDR notation', () => {
      const ast = parse('ip.src in {192.168.0.0/16 10.0.0.0/8}');
      expect(ast.kind).toBe('InExpression');
    });

    it('parses field in list with integer range', () => {
      const ast = parse('cf.edge.server_port in {8000..8009}');
      expect(ast.kind).toBe('InExpression');
    });
  });

  // ── Logical Expressions ────────────────────────────────────────────

  describe('logical expressions', () => {
    it('parses A and B', () => {
      const ast = parse('http.host eq "a.com" and http.request.method eq "POST"');
      expect(ast.kind).toBe('Logical');
      if (ast.kind === 'Logical') {
        expect(ast.operator).toBe('and');
      }
    });

    it('parses A or B', () => {
      const ast = parse('http.host eq "a.com" or http.host eq "b.com"');
      expect(ast.kind).toBe('Logical');
      if (ast.kind === 'Logical') {
        expect(ast.operator).toBe('or');
      }
    });

    it('parses A && B', () => {
      const ast = parse('http.host == "a.com" && http.request.method == "POST"');
      expect(ast.kind).toBe('Logical');
    });

    it('parses not expression', () => {
      const ast = parse('not ssl');
      expect(ast.kind).toBe('Not');
    });

    it('parses ! expression', () => {
      const ast = parse('!ssl');
      expect(ast.kind).toBe('Not');
    });

    it('respects operator precedence (and binds tighter than or)', () => {
      // "A or B and C" should parse as "A or (B and C)"
      const ast = parse('ssl or http.host eq "a.com" and http.request.method eq "POST"');
      expect(ast.kind).toBe('Logical');
      if (ast.kind === 'Logical') {
        expect(ast.operator).toBe('or');
        expect(ast.right.kind).toBe('Logical');
        if (ast.right.kind === 'Logical') {
          expect(ast.right.operator).toBe('and');
        }
      }
    });

    it('respects parentheses over precedence', () => {
      const ast = parse('(ssl or http.host eq "a.com") and http.request.method eq "POST"');
      expect(ast.kind).toBe('Logical');
      if (ast.kind === 'Logical') {
        expect(ast.operator).toBe('and');
        expect(ast.left.kind).toBe('Group');
      }
    });
  });

  // ── Function Calls ─────────────────────────────────────────────────

  describe('function calls', () => {
    it('parses lower(field)', () => {
      const ast = parse('lower(http.host) eq "test"');
      expect(ast.kind).toBe('Comparison');
      if (ast.kind === 'Comparison') {
        expect(ast.left.kind).toBe('FunctionCall');
        if (ast.left.kind === 'FunctionCall') {
          expect(ast.left.name).toBe('lower');
          expect(ast.left.args.length).toBe(1);
        }
      }
    });

    it('parses starts_with(field, string)', () => {
      const ast = parse('starts_with(http.request.uri.path, "/admin")');
      expect(ast.kind).toBe('FunctionCall');
      if (ast.kind === 'FunctionCall') {
        expect(ast.name).toBe('starts_with');
        expect(ast.args.length).toBe(2);
      }
    });

    it('parses len(field)', () => {
      const ast = parse('len(http.host) gt 0');
      expect(ast.kind).toBe('Comparison');
    });

    it('parses nested concat(regex_replace(...),...)', () => {
      const ast = parse('concat(regex_replace(http.referer, "pattern", "${1}"), http.request.uri.path)');
      expect(ast.kind).toBe('FunctionCall');
      if (ast.kind === 'FunctionCall') {
        expect(ast.name).toBe('concat');
        expect(ast.args[0].kind).toBe('FunctionCall');
      }
    });

    it('parses any() with array unpack', () => {
      const ast = parse('any(lower(http.request.headers.names[*])[*] eq "test")');
      expect(ast.kind).toBe('FunctionCall');
      if (ast.kind === 'FunctionCall') {
        expect(ast.name).toBe('any');
      }
    });

    it('parses url_decode with map access', () => {
      const ast = parse('url_decode(http.request.body.form["authType"][0])');
      expect(ast.kind).toBe('FunctionCall');
    });

    it('parses regex_replace rewrite expression', () => {
      const ast = parse('regex_replace(http.request.uri.path, "^/ads/", "/")');
      expect(ast.kind).toBe('FunctionCall');
      if (ast.kind === 'FunctionCall') {
        expect(ast.name).toBe('regex_replace');
        expect(ast.args.length).toBe(3);
      }
    });

    it('parses substring function', () => {
      const ast = parse('substring(raw.http.request.uri.path, 8)');
      expect(ast.kind).toBe('FunctionCall');
    });
  });

  // ── Grouped Expressions ────────────────────────────────────────────

  describe('grouped expressions', () => {
    it('parses parenthesized expression', () => {
      const ast = parse('(http.host eq "test.com")');
      expect(ast.kind).toBe('Group');
      if (ast.kind === 'Group') {
        expect(ast.expression.kind).toBe('Comparison');
      }
    });

    it('parses nested groups', () => {
      const ast = parse('((http.host eq "a.com") or (http.host eq "b.com"))');
      expect(ast.kind).toBe('Group');
    });
  });

  // ── Complex Real-World Expressions ─────────────────────────────────

  describe('real-world expressions', () => {
    it('parses sanctions compliance rule', () => {
      const ast = parse('(ip.geoip.country in {"CU" "IR" "KP" "SY" "RU" "BY"})');
      expect(ast.kind).toBe('Group');
    });

    it('parses multi-condition WAF rule', () => {
      const ast = parse(
        '(http.host eq "secure.example.com") and http.request.uri.path eq "/account/settings" and ip.geoip.country eq "RU"'
      );
      expect(ast.kind).toBe('Logical');
    });

    it('parses exposed credential check', () => {
      const ast = parse(
        '(http.host == "secure.example.com" || http.host == "api.qa.example.net") && http.request.uri == "/auth" && http.request.method == "POST" && url_decode(http.request.body.form["authType"][0]) == "pw"'
      );
      expect(ast.kind).toBe('Logical');
    });

    it('parses bot management skip rule', () => {
      const ast = parse(
        '(cf.bot_management.verified_bot and not http.user_agent contains "Amazonbot")'
      );
      expect(ast.kind).toBe('Group');
    });

    it('parses complex rewrite expression with concat and regex_replace', () => {
      const ast = parse(
        'concat(regex_replace(http.referer, ".*(/portal/[a-zA-Z-]+).*", "${1}"), http.request.uri.path)'
      );
      expect(ast.kind).toBe('FunctionCall');
    });

    it('parses sitemap rewrite expression', () => {
      const ast = parse(
        'concat("/", http.request.headers["host"][0], substring(http.request.uri.path, 8))'
      );
      expect(ast.kind).toBe('FunctionCall');
    });

    it('parses expression with many or-chained user agent checks', () => {
      const ast = parse(
        '(http.user_agent contains "Java") or (http.user_agent contains "ScraperBot") or (http.user_agent contains "Go-http") or (http.user_agent contains "Fuzz")'
      );
      expect(ast.kind).toBe('Logical');
    });

    it('parses WAF score expression', () => {
      const ast = parse('(cf.waf.score gt 40)');
      expect(ast.kind).toBe('Group');
    });

    it('parses expression with named list $cf.malware', () => {
      const ast = parse('(ip.src in $cf.malware) or (ip.src in $cf.botnetcc)');
      expect(ast.kind).toBe('Logical');
    });

    it('parses expression with in-list of paths', () => {
      const ast = parse(
        'http.request.uri.path in {"/graphql" "/graphql/e2eqa"} and http.request.method eq "POST"'
      );
      expect(ast.kind).toBe('Logical');
    });
  });

  // ── Error Cases ────────────────────────────────────────────────────

  describe('error handling', () => {
    it('throws on empty expression', () => {
      expect(() => parse('')).toThrow();
    });

    it('throws on unmatched parenthesis', () => {
      expect(() => parse('(http.host eq "test"')).toThrow();
    });

    it('throws on missing operator', () => {
      expect(() => parse('http.host "test"')).toThrow();
    });

    it('throws on missing right-hand value', () => {
      expect(() => parse('http.host eq')).toThrow();
    });

    it('throws on invalid token sequence', () => {
      expect(() => parse('eq eq eq')).toThrow();
    });
  });
});
