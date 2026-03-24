import { describe, it, expect } from 'vitest';
import { formatExpression } from '../formatter.js';
import { parse } from '../parser.js';

describe('Expression Formatter', () => {
  describe('short expressions — no change', () => {
    it('leaves short single comparison alone', () => {
      expect(formatExpression('(http.host eq "test.com")')).toBe('(http.host eq "test.com")');
    });

    it('leaves short or-chain alone', () => {
      expect(formatExpression('(http.host eq "a.com") or (http.host eq "b.com")')).toBe(
        '(http.host eq "a.com") or (http.host eq "b.com")'
      );
    });

    it('leaves bare true alone', () => {
      expect(formatExpression('true')).toBe('true');
    });

    it('leaves short and-chain alone', () => {
      expect(formatExpression('(http.host eq "a.com" and ip.src.country eq "US")')).toBe(
        '(http.host eq "a.com" and ip.src.country eq "US")'
      );
    });

    it('leaves expression exactly at maxWidth alone', () => {
      const expr = '(http.host eq "test.com")';
      expect(formatExpression(expr, { maxWidth: expr.length })).toBe(expr);
    });
  });

  describe('long or-chains — breaks per branch', () => {
    it('breaks long or-chain onto separate lines', () => {
      const expr = '(http.request.uri.path eq "/home") or (http.request.uri.path eq "/dashboard") or (http.request.uri.path eq "/account/settings") or (http.request.uri.path eq "/account/profile") or (http.request.uri.path eq "/account/security")';
      const result = formatExpression(expr, { maxWidth: 80 });
      const lines = result.split('\n');
      expect(lines.length).toBeGreaterThan(1);
      expect(lines[0]).toMatch(/^\(http/);
      expect(lines[1]).toMatch(/^or \(/);
    });

    it('each or-branch is on its own line', () => {
      const expr = '(ip.src.country eq "AL") or (ip.src.country eq "US") or (ip.src.country eq "GB") or (ip.src.country eq "DE") or (ip.src.country eq "FR")';
      const result = formatExpression(expr, { maxWidth: 60 });
      const orCount = (result.match(/\nor /g) || []).length;
      expect(orCount).toBe(4); // 5 branches = 4 'or' joins
    });
  });

  describe('long and-chains — breaks per condition', () => {
    it('breaks long and-chain inside group', () => {
      const expr = '(http.host eq "secure.example.com" and http.request.method eq "POST" and http.request.uri.path eq "/api/v1/webhook" and not ip.src in $blocklist)';
      const result = formatExpression(expr, { maxWidth: 80 });
      const lines = result.split('\n');
      expect(lines.length).toBeGreaterThan(1);
      expect(lines[0]).toMatch(/^\(/);
      expect(lines[1]).toMatch(/^\s+http\.host/);
      expect(lines[2]).toMatch(/^\s+and /);
    });

    it('breaks bare and-chain (no wrapping group)', () => {
      const expr = 'http.host eq "secure.example.com" and http.request.method eq "POST" and http.request.uri.path eq "/api/v1/webhook"';
      const result = formatExpression(expr, { maxWidth: 60 });
      expect(result).toContain('\nand ');
    });
  });

  describe('mixed and/or — breaks both levels', () => {
    it('breaks or-chain with and-groups', () => {
      const expr = '(http.host eq "a.example.com" and http.request.uri.path eq "/api") or (http.host eq "b.example.com" and http.request.uri.path eq "/webhook") or (http.host eq "c.example.com")';
      const result = formatExpression(expr, { maxWidth: 80 });
      const lines = result.split('\n');
      expect(lines.length).toBeGreaterThan(1);
      expect(result).toContain('\nor ');
    });

    it('handles nested or inside and group', () => {
      const expr = '((http.host eq "a.example.com" or http.host eq "b.example.com") and http.request.uri.path eq "/api" and not ip.src in $blocklist)';
      const result = formatExpression(expr, { maxWidth: 80 });
      expect(result).toContain('http.host eq "a.example.com"');
      expect(result).toContain('http.request.uri.path eq "/api"');
    });
  });

  describe('operator normalization', () => {
    it('normalizes && to and', () => {
      const expr = '(http.host eq "a.com") && (http.host eq "b.com") && (http.host eq "c.com") && (http.host eq "d.com") && (http.host eq "e.com")';
      const result = formatExpression(expr, { maxWidth: 60 });
      expect(result).toContain('and');
      expect(result).not.toContain('&&');
    });

    it('normalizes || to or', () => {
      const expr = '(http.host eq "a.com") || (http.host eq "b.com") || (http.host eq "c.com") || (http.host eq "d.com") || (http.host eq "e.com")';
      const result = formatExpression(expr, { maxWidth: 60 });
      expect(result).toContain('or');
      expect(result).not.toContain('||');
    });
  });

  describe('preserves semantics', () => {
    it('formatted expression parses without error', () => {
      const expr = '(http.host eq "test.com" and http.request.method eq "POST") or (ip.src in {192.0.2.0/24 198.51.100.0/24} and not cf.bot_management.verified_bot)';
      const formatted = formatExpression(expr, { maxWidth: 60 });
      // The formatted version should still parse
      // (collapsed back to one line by joining with spaces)
      const collapsed = formatted.replace(/\n\s*/g, ' ').trim();
      expect(() => parse(collapsed)).not.toThrow();
    });

    it('preserves all fields and values', () => {
      const expr = '(http.host eq "test.com" and http.request.method eq "POST") or (ip.src in {192.0.2.0/24 198.51.100.0/24} and not cf.bot_management.verified_bot)';
      const formatted = formatExpression(expr, { maxWidth: 60 });
      expect(formatted).toContain('http.host eq "test.com"');
      expect(formatted).toContain('http.request.method eq "POST"');
      expect(formatted).toContain('192.0.2.0/24');
      expect(formatted).toContain('198.51.100.0/24');
      expect(formatted).toContain('cf.bot_management.verified_bot');
    });
  });

  describe('in-lists', () => {
    it('breaks long in-list across lines', () => {
      const expr = '(ip.src in {192.0.2.1 192.0.2.2 198.51.100.1 198.51.100.2 203.0.113.1 203.0.113.2 10.0.0.1 10.0.0.2 172.16.0.1 172.16.0.2})';
      const result = formatExpression(expr, { maxWidth: 80 });
      if (result.includes('\n')) {
        expect(result).toContain('ip.src in {');
      }
    });

    it('keeps short in-list on one line', () => {
      const expr = '(ip.src in {192.0.2.1 198.51.100.1})';
      const result = formatExpression(expr, { maxWidth: 120 });
      expect(result).not.toContain('\n');
    });

    it('handles named list without braces', () => {
      const result = formatExpression('(ip.src in $allowlist)');
      expect(result).toBe('(ip.src in $allowlist)');
      expect(result).not.toContain('{');
    });

    it('handles negated in-expression', () => {
      const result = formatExpression('(not ip.src in $blocklist)');
      expect(result).toBe('(not ip.src in $blocklist)');
    });
  });

  describe('not expressions', () => {
    it('formats not at top of and-chain', () => {
      const expr = '(not http.cookie contains "session" and not http.cookie contains "token" and http.request.uri.path eq "/login" and http.request.method eq "GET")';
      const result = formatExpression(expr, { maxWidth: 60 });
      expect(result).toContain('not http.cookie contains "session"');
      expect(result).toContain('not http.cookie contains "token"');
    });

    it('formats not in or-branches', () => {
      const expr = '(not http.cookie contains "a") or (not http.cookie contains "b") or (not http.cookie contains "c") or (not http.cookie contains "d")';
      const result = formatExpression(expr, { maxWidth: 60 });
      const orCount = (result.match(/\nor /g) || []).length;
      expect(orCount).toBe(3);
    });
  });

  describe('function calls', () => {
    it('formats starts_with in or-chain', () => {
      const expr = '(starts_with(http.request.uri.path, "/api/v1/")) or (starts_with(http.request.uri.path, "/api/v2/")) or (starts_with(http.request.uri.path, "/api/v3/"))';
      const result = formatExpression(expr, { maxWidth: 60 });
      expect(result).toContain('starts_with');
      expect(result).toContain('\nor ');
    });

    it('formats starts_with in and-group', () => {
      const expr = '(starts_with(http.request.uri.path, "/api/v1/long-path-name/") and http.host eq "api.example.com" and http.request.method eq "POST")';
      const result = formatExpression(expr, { maxWidth: 80 });
      expect(result).toContain('starts_with');
    });

    it('preserves raw string r"" prefix', () => {
      const expr = '(http.user_agent matches r"Mozilla\\/5\\.0.*Chrome" and http.host eq "test.com")';
      const result = formatExpression(expr, { maxWidth: 80 });
      expect(result).toContain('r"Mozilla\\/5\\.0.*Chrome"');
    });

    it('preserves backslash escapes in regular strings', () => {
      expect(formatExpression('(http.request.uri.path matches "^/test/\\d{1,10}/foo")')).toBe(
        '(http.request.uri.path matches "^/test/\\d{1,10}/foo")'
      );
    });

    it('preserves \\. and \\& in regex patterns', () => {
      expect(formatExpression('(http.user_agent matches "Chrome/13[0-9]\\..*")')).toBe(
        '(http.user_agent matches "Chrome/13[0-9]\\..*")'
      );
    });

    it('preserves double backslash (literal backslash)', () => {
      expect(formatExpression('(http.request.uri.path matches "path\\\\value")')).toBe(
        '(http.request.uri.path matches "path\\\\value")'
      );
    });

    it('preserves raw strings in wildcard', () => {
      const expr = '(http.request.uri.path wildcard r"*.jpg") or (http.request.uri.path wildcard r"*.png")';
      const result = formatExpression(expr);
      expect(result).toContain('r"*.jpg"');
      expect(result).toContain('r"*.png"');
    });
  });

  describe('real-world expressions', () => {
    it('formats a complex WAF skip rule', () => {
      const expr = '(((http.host eq "employers.example.com") or (http.host eq "apply.example.com") or (http.host eq "apis.example.com")) and ((http.request.uri.path matches "^/api") or (http.request.uri.path matches "^/graphql") or (http.request.uri.path matches "^/rpc/")))';
      const result = formatExpression(expr, { maxWidth: 80 });
      expect(result).toContain('employers.example.com');
      expect(result).toContain('apis.example.com');
      expect(result).toContain('/graphql');
    });

    it('formats a rate limit expression', () => {
      const expr = '(starts_with(http.request.uri.path, "/integrations/api/v1/time/flex/flex_uk/worker/") and http.host eq "pay.example.com") or (starts_with(http.request.uri.path, "/integrations/api/v1/time/flex/flex_us/worker/") and http.host eq "pay.example.com")';
      const result = formatExpression(expr, { maxWidth: 100 });
      expect(result).toContain('flex_uk');
      expect(result).toContain('flex_us');
      expect(result).toContain('\nor ');
    });

    it('formats a bot score expression', () => {
      const expr = '(cf.bot_management.score gt 1 and cf.bot_management.score le 5 and not cf.bot_management.verified_bot and not http.request.uri.path contains "log" and not http.request.uri.path contains "/static")';
      const result = formatExpression(expr, { maxWidth: 80 });
      const lines = result.split('\n');
      expect(lines.length).toBeGreaterThan(1);
      expect(result).toContain('cf.bot_management.score gt 1');
      expect(result).toContain('cf.bot_management.score le 5');
    });
  });

  describe('options', () => {
    it('respects custom maxWidth', () => {
      const expr = '(http.host eq "test.com") or (http.host eq "other.com")';
      expect(formatExpression(expr, { maxWidth: 200 })).not.toContain('\n');
      expect(formatExpression(expr, { maxWidth: 40 })).toContain('\n');
    });

    it('respects custom indent', () => {
      const expr = '(http.host eq "secure.example.com" and http.request.method eq "POST" and http.request.uri.path eq "/api/v1/webhook")';
      const result = formatExpression(expr, { maxWidth: 60, indent: '    ' });
      if (result.includes('\n')) {
        expect(result).toMatch(/\n {4}and /);
      }
    });

    it('one-character-over maxWidth triggers breaking', () => {
      const expr = '(http.host eq "test.com") or (http.host eq "other.com")';
      const oneLine = formatExpression(expr, { maxWidth: 200 });
      // Set maxWidth to one less than the single-line length
      const result = formatExpression(expr, { maxWidth: oneLine.length - 1 });
      expect(result).toContain('\n');
    });
  });

  describe('never breaks mid-condition', () => {
    it('keeps long string value on one line', () => {
      const expr = '(http.user_agent eq "Mozilla/5.0 (Linux; Android 9; SM-G960F Build/PPR1.180610.011; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/74.0.3729.157 Mobile Safari/537.36")';
      const result = formatExpression(expr, { maxWidth: 40 });
      // The condition must stay on one line even though it exceeds maxWidth
      for (const line of result.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('http.user_agent')) {
          expect(trimmed).toContain('eq "Mozilla');
          expect(trimmed).toContain('Safari/537.36"');
        }
      }
    });

    it('keeps long field name with map key on one line', () => {
      const expr = '(any(http.request.headers["x-custom-header"][*] eq "value") and http.host eq "test.com")';
      const result = formatExpression(expr, { maxWidth: 40 });
      const lines = result.split('\n');
      // The any() condition must be on one line
      const anyLine = lines.find(l => l.includes('any('));
      expect(anyLine).toContain('eq "value"');
    });

    it('keeps long regex on one line', () => {
      const expr = '(http.user_agent matches r"^Mozilla\\/5\\.0.*AppleWebKit\\/537\\.36.*Chrome\\/1[0-9][0-9]\\.0\\.0\\.0 Safari\\/537\\.36$" and http.host eq "test.com")';
      const result = formatExpression(expr, { maxWidth: 40 });
      const matchesLine = result.split('\n').find(l => l.includes('matches'));
      expect(matchesLine).toContain('r"^Mozilla');
      expect(matchesLine).toContain('537\\.36$"');
    });

    it('keeps long starts_with on one line', () => {
      const expr = '(starts_with(http.request.uri.path, "/very/long/path/prefix/that/exceeds/width") and http.host eq "test.com")';
      const result = formatExpression(expr, { maxWidth: 40 });
      const swLine = result.split('\n').find(l => l.includes('starts_with'));
      expect(swLine).toContain('/very/long/path');
      expect(swLine).toContain('/width"');
    });
  });

  describe('idempotency', () => {
    it('second prettify produces no change', () => {
      const expr = '(http.host eq "secure.example.com" and http.request.method eq "POST" and http.request.uri.path eq "/api/webhook" and not ip.src in $blocklist)';
      const first = formatExpression(expr, { maxWidth: 80 });
      const second = formatExpression(first, { maxWidth: 80 });
      expect(second).toBe(first);
    });

    it('idempotent for or-chains', () => {
      const expr = '(http.host eq "a.example.com") or (http.host eq "b.example.com") or (http.host eq "c.example.com") or (http.host eq "d.example.com")';
      const first = formatExpression(expr, { maxWidth: 80 });
      const second = formatExpression(first, { maxWidth: 80 });
      expect(second).toBe(first);
    });

    it('idempotent for expressions with raw strings', () => {
      const expr = '(http.user_agent matches r"Safari\\/537\\.36" and http.host eq "test.com" and ip.src.country eq "US")';
      const first = formatExpression(expr, { maxWidth: 80 });
      const second = formatExpression(first, { maxWidth: 80 });
      expect(second).toBe(first);
    });

    it('idempotent for mixed and/or', () => {
      const expr = '(http.host eq "a.example.com" and http.request.method eq "POST") or (http.host eq "b.example.com" and http.request.uri.path eq "/webhook") or (http.host eq "c.example.com")';
      const first = formatExpression(expr, { maxWidth: 80 });
      const second = formatExpression(first, { maxWidth: 80 });
      expect(second).toBe(first);
    });
  });

  describe('edge cases', () => {
    it('adds space when operator is glued to closing quote', () => {
      const expr = '(http.host eq "a"or http.host eq "b")';
      const result = formatExpression(expr);
      // The formatter re-prints from AST, so "or should get proper spacing
      expect(result).not.toContain('"or');
      // Either single-line with space or multi-line with or on new line
      expect(result).toMatch(/"\s+or\s|"\nor/);
    });

    it('in-list with spaces round-trips correctly', () => {
      const expr = '(ip.src in {1.2.3.4 5.6.7.8 9.10.11.12 13.14.15.16 17.18.19.20 21.22.23.24 25.26.27.28 29.30.31.32})';
      const first = formatExpression(expr, { maxWidth: 80 });
      const second = formatExpression(first, { maxWidth: 80 });
      expect(second).toBe(first);
    });

    it('handles bare not ssl', () => {
      expect(formatExpression('not ssl')).toBe('not ssl');
    });

    it('handles (not ssl) — negated boolean in group', () => {
      expect(formatExpression('(not ssl)')).toBe('(not ssl)');
    });

    it('handles deeply nested expressions', () => {
      const expr = '(((http.host eq "a.example.com" or http.host eq "b.example.com") and http.request.uri.path eq "/api") or ((http.host eq "c.example.com" and http.request.method eq "POST") and (http.request.uri.path eq "/webhook" or http.request.uri.path eq "/callback")))';
      const result = formatExpression(expr, { maxWidth: 60 });
      expect(result).toContain('a.example.com');
      expect(result).toContain('c.example.com');
      expect(result).toContain('/webhook');
    });
    it('handles unparseable expression gracefully', () => {
      expect(formatExpression('this is not valid {')).toBe('this is not valid {');
    });

    it('handles empty expression', () => {
      expect(formatExpression('')).toBe('');
    });

    it('trims whitespace', () => {
      expect(formatExpression('  (http.host eq "test.com")  ')).toBe('(http.host eq "test.com")');
    });

    it('handles single field', () => {
      expect(formatExpression('ssl')).toBe('ssl');
    });

    it('handles single wrapped field', () => {
      expect(formatExpression('(ssl)')).toBe('(ssl)');
    });

    it('handles map key access', () => {
      const result = formatExpression('(http.request.headers["host"] eq "test.com")');
      expect(result).toContain('http.request.headers["host"]');
    });

    it('handles IP with CIDR', () => {
      const result = formatExpression('(ip.src in {192.0.2.0/24})');
      expect(result).toContain('192.0.2.0/24');
    });

    it('handles string escaping', () => {
      const result = formatExpression('(http.request.uri.path eq "/path with \\"quotes\\"")');
      expect(result).toContain('"');
    });
  });

  describe('nested group breaking', () => {
    it('breaks double-parens group containing or-chain', () => {
      const expr = '((http.host eq "a.example.com" and http.request.uri.path eq "/very-long-path/that-exceeds-width") or (http.host eq "b.example.com" and http.request.uri.path eq "/another-long-path"))';
      const result = formatExpression(expr, { maxWidth: 120 });
      expect(result).toContain('\n');
      const maxLine = Math.max(...result.split('\n').map(l => l.length));
      expect(maxLine).toBeLessThanOrEqual(120);
    });

    it('breaks group containing not with long operand', () => {
      const expr = '(not (http.host eq "a.example.com" and http.request.method eq "POST" and http.request.uri.path eq "/api/v1/very-long-endpoint"))';
      const result = formatExpression(expr, { maxWidth: 80 });
      expect(result).toContain('\n');
      const maxLine = Math.max(...result.split('\n').map(l => l.length));
      expect(maxLine).toBeLessThanOrEqual(80);
    });

    it('does not break nested group that fits within maxWidth', () => {
      const expr = '((http.host eq "a.com"))';
      const result = formatExpression(expr, { maxWidth: 120 });
      expect(result).not.toContain('\n');
    });
  });
});
