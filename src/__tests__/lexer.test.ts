import { describe, it, expect } from 'vitest';
import { tokenize } from '../lexer.js';
import { TokenType } from '../types.js';

/** Helper: extract just types and values from tokens (excluding EOF) */
function tv(expr: string) {
  return tokenize(expr)
    .filter(t => t.type !== TokenType.EOF)
    .map(t => [t.type, t.value]);
}

describe('Lexer', () => {
  // ── Basic Literals ─────────────────────────────────────────────────

  describe('string literals', () => {
    it('tokenizes double-quoted strings', () => {
      const tokens = tv('"hello"');
      expect(tokens).toEqual([[TokenType.String, 'hello']]);
    });

    it('tokenizes strings with escaped quotes', () => {
      const tokens = tv('"he said \\"hi\\""');
      expect(tokens).toEqual([[TokenType.String, 'he said "hi"']]);
    });

    it('tokenizes strings with escaped backslashes', () => {
      const tokens = tv('"path\\\\to"');
      expect(tokens).toEqual([[TokenType.String, 'path\\to']]);
    });

    it('tokenizes empty strings', () => {
      const tokens = tv('""');
      expect(tokens).toEqual([[TokenType.String, '']]);
    });
  });

  describe('integer literals', () => {
    it('tokenizes positive integers', () => {
      expect(tv('42')).toEqual([[TokenType.Integer, '42']]);
    });

    it('tokenizes zero', () => {
      expect(tv('0')).toEqual([[TokenType.Integer, '0']]);
    });

    it('tokenizes large integers', () => {
      expect(tv('396507')).toEqual([[TokenType.Integer, '396507']]);
    });
  });

  describe('boolean literals', () => {
    it('tokenizes true', () => {
      expect(tv('true')).toEqual([[TokenType.Boolean, 'true']]);
    });

    it('tokenizes false', () => {
      expect(tv('false')).toEqual([[TokenType.Boolean, 'false']]);
    });
  });

  // ── Fields ─────────────────────────────────────────────────────────

  describe('field names', () => {
    it('tokenizes simple dotted fields', () => {
      expect(tv('http.host')).toEqual([[TokenType.Field, 'http.host']]);
    });

    it('tokenizes deeply nested fields', () => {
      expect(tv('http.request.uri.path')).toEqual([
        [TokenType.Field, 'http.request.uri.path'],
      ]);
    });

    it('tokenizes cf.* fields', () => {
      expect(tv('cf.bot_management.score')).toEqual([
        [TokenType.Field, 'cf.bot_management.score'],
      ]);
    });

    it('tokenizes ip.src fields', () => {
      expect(tv('ip.src.country')).toEqual([
        [TokenType.Field, 'ip.src.country'],
      ]);
    });

    it('tokenizes ip.geoip deprecated fields', () => {
      expect(tv('ip.geoip.country')).toEqual([
        [TokenType.Field, 'ip.geoip.country'],
      ]);
    });

    it('tokenizes raw.* fields', () => {
      expect(tv('raw.http.request.uri.path')).toEqual([
        [TokenType.Field, 'raw.http.request.uri.path'],
      ]);
    });

    it('tokenizes ssl boolean field', () => {
      expect(tv('ssl')).toEqual([[TokenType.Field, 'ssl']]);
    });

    it('tokenizes fields with underscores and numbers', () => {
      expect(tv('cf.response.1xxx_code')).toEqual([
        [TokenType.Field, 'cf.response.1xxx_code'],
      ]);
    });
  });

  // ── Map/Array Access ───────────────────────────────────────────────

  describe('map and array access', () => {
    it('tokenizes map key access with bracket notation', () => {
      const tokens = tv('http.request.headers["host"]');
      expect(tokens).toEqual([
        [TokenType.Field, 'http.request.headers'],
        [TokenType.LeftBracket, '['],
        [TokenType.String, 'host'],
        [TokenType.RightBracket, ']'],
      ]);
    });

    it('tokenizes array index access', () => {
      const tokens = tv('http.request.headers["host"][0]');
      expect(tokens).toEqual([
        [TokenType.Field, 'http.request.headers'],
        [TokenType.LeftBracket, '['],
        [TokenType.String, 'host'],
        [TokenType.RightBracket, ']'],
        [TokenType.LeftBracket, '['],
        [TokenType.Integer, '0'],
        [TokenType.RightBracket, ']'],
      ]);
    });

    it('tokenizes array unpack [*]', () => {
      const tokens = tv('http.request.headers.names[*]');
      expect(tokens).toEqual([
        [TokenType.Field, 'http.request.headers.names'],
        [TokenType.ArrayUnpack, '[*]'],
      ]);
    });
  });

  // ── Named Lists ────────────────────────────────────────────────────

  describe('named lists', () => {
    it('tokenizes $ prefixed named lists', () => {
      expect(tv('$allow_ips_auto_merged')).toEqual([
        [TokenType.NamedList, '$allow_ips_auto_merged'],
      ]);
    });

    it('tokenizes cf.* named lists', () => {
      expect(tv('$cf.malware')).toEqual([
        [TokenType.NamedList, '$cf.malware'],
      ]);
    });
  });

  // ── Comparison Operators ───────────────────────────────────────────

  describe('comparison operators', () => {
    it('tokenizes english-form operators', () => {
      for (const op of ['eq', 'ne', 'lt', 'le', 'gt', 'ge', 'contains', 'matches', 'in']) {
        const tokens = tv(`http.host ${op} "test"`);
        expect(tokens[1]).toEqual([TokenType.ComparisonOp, op]);
      }
    });

    it('tokenizes symbol-form operators', () => {
      for (const op of ['==', '!=', '<', '<=', '>', '>=', '~']) {
        const tokens = tv(`http.host ${op} "test"`);
        expect(tokens[1]).toEqual([TokenType.ComparisonOp, op]);
      }
    });

    it('tokenizes wildcard operator', () => {
      const tokens = tv('http.host wildcard "*.example.com"');
      expect(tokens[1]).toEqual([TokenType.ComparisonOp, 'wildcard']);
    });

    it('tokenizes "strict wildcard" as a two-word operator', () => {
      const tokens = tv('http.host strict wildcard "*.example.com"');
      // Should combine into a single operator
      expect(tokens[1]).toEqual([TokenType.ComparisonOp, 'strict wildcard']);
    });
  });

  // ── Logical Operators ──────────────────────────────────────────────

  describe('logical operators', () => {
    it('tokenizes english-form logical operators', () => {
      for (const op of ['and', 'or', 'not', 'xor']) {
        const tokens = tv(`true ${op} false`);
        const logicals = tokens.filter(([type]) => type === TokenType.LogicalOp);
        expect(logicals.length).toBeGreaterThanOrEqual(1);
        expect(logicals[0][1]).toBe(op);
      }
    });

    it('tokenizes symbol-form logical operators', () => {
      for (const op of ['&&', '||', '^^']) {
        const tokens = tv(`true ${op} false`);
        const logicals = tokens.filter(([type]) => type === TokenType.LogicalOp);
        expect(logicals[0][1]).toBe(op);
      }
    });

    it('tokenizes ! as not', () => {
      const tokens = tv('!ssl');
      expect(tokens[0]).toEqual([TokenType.LogicalOp, '!']);
    });
  });

  // ── Functions ──────────────────────────────────────────────────────

  describe('functions', () => {
    it('tokenizes function calls', () => {
      const tokens = tv('lower(http.host)');
      expect(tokens[0]).toEqual([TokenType.Function, 'lower']);
      expect(tokens[1]).toEqual([TokenType.LeftParen, '(']);
      expect(tokens[2]).toEqual([TokenType.Field, 'http.host']);
      expect(tokens[3]).toEqual([TokenType.RightParen, ')']);
    });

    it('tokenizes nested function calls', () => {
      const tokens = tv('len(lower(http.host))');
      expect(tokens[0]).toEqual([TokenType.Function, 'len']);
      expect(tokens[2]).toEqual([TokenType.Function, 'lower']);
    });

    it('tokenizes functions with multiple args', () => {
      const tokens = tv('starts_with(http.request.uri.path, "/admin")');
      expect(tokens[0]).toEqual([TokenType.Function, 'starts_with']);
      expect(tokens.some(([type]) => type === TokenType.Comma)).toBe(true);
    });

    it('tokenizes regex_replace', () => {
      const tokens = tv('regex_replace(http.request.uri.path, "^/old/(.*)", "/new/${1}")');
      expect(tokens[0]).toEqual([TokenType.Function, 'regex_replace']);
    });

    it('tokenizes concat with multiple args', () => {
      const tokens = tv('concat("/m", http.request.uri.path)');
      expect(tokens[0]).toEqual([TokenType.Function, 'concat']);
    });
  });

  // ── Grouping ───────────────────────────────────────────────────────

  describe('grouping', () => {
    it('tokenizes parentheses', () => {
      const tokens = tv('(http.host eq "test")');
      expect(tokens[0]).toEqual([TokenType.LeftParen, '(']);
      expect(tokens[tokens.length - 1]).toEqual([TokenType.RightParen, ')']);
    });

    it('tokenizes curly braces for in-lists', () => {
      const tokens = tv('ip.src in {1.2.3.0/24}');
      expect(tokens.some(([type]) => type === TokenType.LeftBrace)).toBe(true);
      expect(tokens.some(([type]) => type === TokenType.RightBrace)).toBe(true);
    });
  });

  // ── In-List Values ─────────────────────────────────────────────────

  describe('in-list values', () => {
    it('tokenizes string lists', () => {
      const tokens = tv('{"US" "JP" "DE"}');
      const strings = tokens.filter(([type]) => type === TokenType.String);
      expect(strings.length).toBe(3);
    });

    it('tokenizes integer ranges with ..', () => {
      const tokens = tv('{8000..8009}');
      expect(tokens.some(([type]) => type === TokenType.DotDot)).toBe(true);
    });

    it('tokenizes CIDR notation in lists', () => {
      const tokens = tv('{192.168.0.0/16 10.0.0.0/8}');
      expect(tokens.some(([type]) => type === TokenType.Slash)).toBe(true);
    });
  });

  // ── Complex Real-World Expressions ─────────────────────────────────

  describe('complex real-world expressions', () => {
    it('tokenizes country-based filter', () => {
      const expr = '(ip.src.country in {"DK" "EG" "GH" "GT"})';
      const tokens = tokenize(expr);
      expect(tokens[0].type).toBe(TokenType.LeftParen);
      expect(tokens.find(t => t.type === TokenType.EOF)).toBeTruthy();
    });

    it('tokenizes compound WAF rule', () => {
      const expr = '(http.host eq "secure.example.com") and http.request.uri.path eq "/account/settings" and ip.geoip.country eq "RU"';
      const tokens = tokenize(expr);
      const ands = tokens.filter(t => t.type === TokenType.LogicalOp && t.value === 'and');
      expect(ands.length).toBe(2);
    });

    it('tokenizes bot management expression', () => {
      const expr = '(cf.bot_management.verified_bot and not http.user_agent contains "Amazonbot")';
      const tokens = tokenize(expr);
      expect(tokens.some(t => t.type === TokenType.Field && t.value === 'cf.bot_management.verified_bot')).toBe(true);
    });

    it('tokenizes expression with named list', () => {
      const expr = '(ip.src in $allow_ips_auto_merged)';
      const tokens = tokenize(expr);
      expect(tokens.some(t => t.type === TokenType.NamedList && t.value === '$allow_ips_auto_merged')).toBe(true);
    });

    it('tokenizes C-like syntax expression', () => {
      const expr = '(http.host == "secure.example.com" || http.host == "api.qa.example.net") && http.request.method == "POST"';
      const tokens = tokenize(expr);
      const ors = tokens.filter(t => t.value === '||');
      const ands = tokens.filter(t => t.value === '&&');
      expect(ors.length).toBe(1);
      expect(ands.length).toBe(1);
    });

    it('tokenizes multi-line expression', () => {
      const expr = `(
        http.host eq "test.com"
        and http.request.method eq "POST"
      )`;
      const tokens = tokenize(expr);
      expect(tokens.filter(t => t.type === TokenType.EOF).length).toBe(1);
    });

    it('tokenizes regex_replace rewrite expression', () => {
      const expr = 'regex_replace(http.request.uri.path, "^/ads/", "/")';
      const tokens = tokenize(expr);
      expect(tokens[0].type).toBe(TokenType.Function);
      expect(tokens[0].value).toBe('regex_replace');
    });

    it('tokenizes concat with regex_replace', () => {
      const expr = 'concat(regex_replace(http.referer, ".*(/portal/[a-zA-Z-]+).*", "${1}"), http.request.uri.path)';
      const tokens = tokenize(expr);
      const funcs = tokens.filter(t => t.type === TokenType.Function);
      expect(funcs.map(f => f.value)).toEqual(['concat', 'regex_replace']);
    });

    it('tokenizes expression with array unpack and any()', () => {
      const expr = 'any(lower(http.request.headers.names[*])[*] eq "x-custom-header")';
      const tokens = tokenize(expr);
      expect(tokens[0].type).toBe(TokenType.Function);
      expect(tokens[0].value).toBe('any');
    });

    it('tokenizes url_decode function in expression', () => {
      const expr = 'url_decode(http.request.body.form["authType"][0]) == "pw"';
      const tokens = tokenize(expr);
      expect(tokens[0].type).toBe(TokenType.Function);
      expect(tokens[0].value).toBe('url_decode');
    });

    it('tokenizes expression with cf.zone.plan', () => {
      const expr = '(cf.zone.plan eq "ENT")';
      const tokens = tokenize(expr);
      expect(tokens.some(t => t.type === TokenType.Field && t.value === 'cf.zone.plan')).toBe(true);
    });

    it('tokenizes expression with $cf.malware named list', () => {
      const expr = '(ip.src in $cf.malware) or (ip.src in $cf.botnetcc)';
      const tokens = tokenize(expr);
      const lists = tokens.filter(t => t.type === TokenType.NamedList);
      expect(lists.map(l => l.value)).toEqual(['$cf.malware', '$cf.botnetcc']);
    });
  });

  // ── Edge Cases ─────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('tokenizes bare "true" expression', () => {
      expect(tv('true')).toEqual([[TokenType.Boolean, 'true']]);
    });

    it('handles extra whitespace', () => {
      const tokens = tv('  http.host   eq   "test"  ');
      expect(tokens.length).toBe(3);
    });

    it('handles tab characters', () => {
      const tokens = tv('http.host\teq\t"test"');
      expect(tokens.length).toBe(3);
    });

    it('handles newlines in multi-line expressions', () => {
      const tokens = tv('http.host eq\n"test"');
      expect(tokens.length).toBe(3);
    });

    it('returns error token for unterminated string', () => {
      expect(() => tokenize('"unterminated')).toThrow();
    });

    it('returns EOF for empty input', () => {
      const tokens = tokenize('');
      expect(tokens.length).toBe(1);
      expect(tokens[0].type).toBe(TokenType.EOF);
    });
  });

  // ── Position Tracking ──────────────────────────────────────────────

  describe('position tracking', () => {
    it('tracks token positions', () => {
      const tokens = tokenize('http.host eq "test"');
      expect(tokens[0].position).toBe(0);
      expect(tokens[0].column).toBe(1);
    });

    it('tracks positions across lines', () => {
      const tokens = tokenize('http.host\neq "test"');
      const eqToken = tokens.find(t => t.value === 'eq')!;
      expect(eqToken.line).toBe(2);
    });
  });
});
