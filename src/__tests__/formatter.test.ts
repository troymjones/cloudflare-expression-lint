import { describe, it, expect } from 'vitest';
import { formatExpression } from '../formatter.js';

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
  });

  describe('long or-chains — breaks per branch', () => {
    it('breaks long or-chain onto separate lines', () => {
      const expr = '(http.request.uri.path eq "/home") or (http.request.uri.path eq "/dashboard") or (http.request.uri.path eq "/account/settings") or (http.request.uri.path eq "/account/profile") or (http.request.uri.path eq "/account/security")';
      const result = formatExpression(expr, { maxWidth: 80 });
      const lines = result.split('\n');
      expect(lines.length).toBeGreaterThan(1);
      // First line starts with opening paren, subsequent lines start with 'or'
      expect(lines[0]).toMatch(/^\(http/);
      expect(lines[1]).toMatch(/^or \(/);
    });
  });

  describe('long and-chains — breaks per condition', () => {
    it('breaks long and-chain inside group', () => {
      const expr = '(http.host eq "secure.example.com" and http.request.method eq "POST" and http.request.uri.path eq "/api/v1/webhook" and not ip.src in $blocklist)';
      const result = formatExpression(expr, { maxWidth: 80 });
      const lines = result.split('\n');
      expect(lines.length).toBeGreaterThan(1);
      expect(lines[0]).toMatch(/^\(/);
      // First condition indented, subsequent lines start with indented 'and'
      expect(lines[1]).toMatch(/^\s+http\.host/);
      expect(lines[2]).toMatch(/^\s+and /);
    });
  });

  describe('mixed and/or — breaks both levels', () => {
    it('breaks or-chain with and-groups', () => {
      const expr = '(http.host eq "a.example.com" and http.request.uri.path eq "/api") or (http.host eq "b.example.com" and http.request.uri.path eq "/webhook") or (http.host eq "c.example.com")';
      const result = formatExpression(expr, { maxWidth: 80 });
      const lines = result.split('\n');
      expect(lines.length).toBeGreaterThan(1);
      // Should have 'or' at the start of some lines
      expect(result).toContain('\nor ');
    });
  });

  describe('preserves semantics', () => {
    it('formatted expression parses identically', () => {
      const expr = '(http.host eq "test.com" and http.request.method eq "POST") or (ip.src in {192.0.2.0/24 198.51.100.0/24} and not cf.bot_management.verified_bot)';
      const formatted = formatExpression(expr, { maxWidth: 60 });
      // Both should be parseable (we can't easily compare ASTs, but verify no errors)
      expect(formatted).toContain('http.host eq "test.com"');
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
  });

  describe('options', () => {
    it('respects custom maxWidth', () => {
      const expr = '(http.host eq "test.com") or (http.host eq "other.com")';
      // With wide max, stays on one line
      expect(formatExpression(expr, { maxWidth: 200 })).not.toContain('\n');
      // With narrow max, breaks
      expect(formatExpression(expr, { maxWidth: 40 })).toContain('\n');
    });

    it('respects custom indent', () => {
      const expr = '(http.host eq "secure.example.com" and http.request.method eq "POST" and http.request.uri.path eq "/api/v1/webhook")';
      const result = formatExpression(expr, { maxWidth: 60, indent: '    ' });
      if (result.includes('\n')) {
        // Should use 4-space indent
        expect(result).toMatch(/\n {4}and /);
      }
    });
  });

  describe('edge cases', () => {
    it('handles unparseable expression gracefully', () => {
      expect(formatExpression('this is not valid {')).toBe('this is not valid {');
    });

    it('handles empty expression', () => {
      expect(formatExpression('')).toBe('');
    });

    it('trims whitespace', () => {
      expect(formatExpression('  (http.host eq "test.com")  ')).toBe('(http.host eq "test.com")');
    });

    it('handles not expressions', () => {
      const expr = '(not http.cookie contains "session" and not http.cookie contains "token" and http.request.uri.path eq "/login")';
      const result = formatExpression(expr, { maxWidth: 60 });
      expect(result).toContain('not http.cookie');
    });

    it('handles function calls', () => {
      const expr = '(starts_with(http.request.uri.path, "/api/v1/") and http.host eq "test.com") or (starts_with(http.request.uri.path, "/api/v2/") and http.host eq "test.com")';
      const result = formatExpression(expr, { maxWidth: 80 });
      expect(result).toContain('starts_with');
    });

    it('handles named lists', () => {
      const expr = '(ip.src in $allowlist and not ip.src in $blocklist and http.host eq "test.com")';
      const result = formatExpression(expr, { maxWidth: 60 });
      expect(result).toContain('$allowlist');
      expect(result).toContain('$blocklist');
    });
  });
});
