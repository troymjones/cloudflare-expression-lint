/**
 * Convergence tests.
 *
 * Validates that fix → prettify → check is stable (idempotent) across
 * all expression formats and fix types. These tests exercise the full
 * pipeline that CI runs: scan → fix → rewrite → prettify → check.
 */

import { describe, it, expect } from 'vitest';
import { fixExpression } from '../fixer.js';
import { formatExpression } from '../formatter.js';
import { rewriteExpressions } from '../rewriter.js';
import { scanYaml } from '../yaml-scanner.js';

// ── Fixer idempotency ────────────────────────────────────────────────

describe('fixer idempotency: fix(fix(expr)) === fix(expr)', () => {
  const expressions = [
    // Wrap bare expression
    'http.host eq "test.com"',
    // Merge and-groups
    '(http.host eq "test.com") and (http.request.method eq "POST")',
    // De Morgan or-to-and
    'not (http.cookie eq "a" or http.cookie eq "b")',
    // De Morgan and-to-or (must wrap result)
    'not (http.host eq "a" and http.host eq "b")',
    // De Morgan inside and-chain (the SHOE/SOCK bug pattern)
    '(http.host eq "test.com" and not (http.cookie contains "A" and http.cookie contains "B") and not http.cookie contains "C")',
    // Double-paren merge
    '(((http.host eq "a.com"))) and (http.host eq "b.com")',
    // Or-chain with bare branches
    'http.host eq "a.com" or http.host eq "b.com"',
    // Outer parens on or-chain
    '((http.host eq "a.com") or (http.host eq "b.com"))',
    // Unwrap individually-wrapped in and-group
    '((http.host eq "a.com") and (http.request.method eq "POST"))',
    // Or-eq to in-list
    '(http.host eq "a.com") or (http.host eq "b.com") or (http.host eq "c.com")',
    // Account-level double-wrap
    '((http.host eq "test.com")) and (cf.zone.plan eq "ENT")',
    '(http.host eq "a.com") and (http.request.method eq "POST") and (cf.zone.plan eq "ENT")',
    // Account-level with or-chain
    '((http.host eq "a.com") or (http.host eq "b.com")) and (cf.zone.plan eq "ENT")',
    // Placeholder in set literal
    '(ip.src in {__BLOCKED_IPS__})',
    '(http.host eq "test.com") and (ip.src in {__ALLOWED_IPS__})',
    // Complex: De Morgan + merge + account-level
    '((not (http.cookie eq "a" or http.cookie eq "b"))) and (cf.zone.plan eq "ENT")',
  ];

  for (const expr of expressions) {
    it(`idempotent: ${expr.substring(0, 60)}${expr.length > 60 ? '...' : ''}`, () => {
      const first = fixExpression(expr).expression;
      const second = fixExpression(first);
      expect(second.changed).toBe(false);
      expect(second.expression).toBe(first);
    });
  }
});

// ── Formatter idempotency ────────────────────────────────────────────

describe('formatter idempotency: format(format(expr)) === format(expr)', () => {
  const expressions = [
    '(http.host eq "test.com")',
    '(http.host eq "api.example.com" and http.request.method eq "POST" and http.request.uri.path eq "/webhook" and not ip.src in $internal)',
    '(http.host eq "a.com") or (http.host eq "b.com") or (http.host eq "c.com")',
    '((not http.host contains "mail" and not cf.bot_management.static_resource)) and (cf.zone.plan eq "ENT")',
    '(ip.src in {"1.2.3.4" "5.6.7.8" "9.10.11.12" "13.14.15.16" "17.18.19.20" "21.22.23.24"})',
    '(ip.src in {__BLOCKED_IPS__})',
  ];

  for (const expr of expressions) {
    it(`idempotent: ${expr.substring(0, 60)}${expr.length > 60 ? '...' : ''}`, () => {
      const first = formatExpression(expr);
      const rejoined = first.split('\n').map(l => l.trim()).join(' ');
      const second = formatExpression(rejoined);
      const rejoined2 = second.split('\n').map(l => l.trim()).join(' ');
      expect(rejoined2).toBe(rejoined);
    });
  }
});

// ── Pipeline convergence: fix → format → rejoin → refix ─────────────

describe('pipeline convergence: fix → format → rejoin → refix is stable', () => {
  const expressions = [
    '(http.host eq "test.com") and (http.request.method eq "POST")',
    '((not http.host contains "mail" and not cf.bot_management.static_resource)) and (cf.zone.plan eq "ENT")',
    'not (http.cookie eq "a" or http.cookie eq "b")',
    '((http.host eq "a.com") or (http.host eq "b.com"))',
    'http.host eq "a.com" and http.request.method eq "POST" and http.request.uri.path eq "/api"',
    '(ip.src in {__BLOCKED_IPS__}) and (cf.zone.plan eq "ENT")',
    '(http.host eq "a.com") or (http.host eq "b.com") or (http.host eq "c.com")',
    '(http.host eq "test.com" and not (http.cookie contains "A" and http.cookie contains "B") and not http.cookie contains "C")',
  ];

  for (const expr of expressions) {
    it(`converges: ${expr.substring(0, 60)}${expr.length > 60 ? '...' : ''}`, () => {
      const fixed = fixExpression(expr).expression;
      const formatted = formatExpression(fixed);
      const rejoined = formatted.split('\n').map(l => l.trim()).join(' ');
      const refixed = fixExpression(rejoined);
      expect(refixed.changed).toBe(false);
    });
  }
});

// ── YAML round-trip convergence ──────────────────────────────────────

describe('YAML round-trip: rewrite → rescan → rewrite is stable', () => {
  function makeYaml(expr: string): string {
    return `zone:\n  waf_rules:\n    rules:\n      - expression: ${expr}\n        enabled: true\n`;
  }

  const yamlCases = [
    // Inline short expression
    '(http.host eq "test.com")',
    // Inline long expression (will become >-)
    '(http.host eq "api.example.com" and http.request.method eq "POST" and http.request.uri.path eq "/webhook" and not ip.src in $internal)',
    // Expression with placeholder
    '(ip.src in {__BLOCKED_IPS__} and http.host eq "test.com")',
  ];

  for (const expr of yamlCases) {
    it(`stable: ${expr.substring(0, 60)}${expr.length > 60 ? '...' : ''}`, () => {
      const content = makeYaml(expr);

      // Pass 1
      const scan1 = scanYaml(content, 'test.yaml');
      const r1 = rewriteExpressions(content, scan1.expressions, { maxWidth: 100, convertBlockScalars: true });

      // Pass 2 on the result
      const scan2 = scanYaml(r1.content, 'test.yaml');
      const r2 = rewriteExpressions(r1.content, scan2.expressions, { maxWidth: 100, convertBlockScalars: true });

      expect(r2.count).toBe(0);
      expect(r2.content).toBe(r1.content);
    });
  }

  it('stable with CRLF line endings', () => {
    const content = `zone:\r\n  waf_rules:\r\n    rules:\r\n      - expression: (http.host eq "test.com" and http.request.method eq "POST")\r\n        enabled: true\r\n`;
    const scan1 = scanYaml(content, 'test.yaml');
    const r1 = rewriteExpressions(content, scan1.expressions, { maxWidth: 100, convertBlockScalars: true });
    const scan2 = scanYaml(r1.content, 'test.yaml');
    const r2 = rewriteExpressions(r1.content, scan2.expressions, { maxWidth: 100, convertBlockScalars: true });
    expect(r2.count).toBe(0);
  });

  it('stable with >- block scalar', () => {
    const content = [
      'zone:',
      '  waf_rules:',
      '    rules:',
      '      - expression: >-',
      '          (http.host eq "test.com"',
      '          and http.request.method eq "POST")',
      '        enabled: true',
      '',
    ].join('\n');
    const scan1 = scanYaml(content, 'test.yaml');
    const r1 = rewriteExpressions(content, scan1.expressions, { maxWidth: 100, convertBlockScalars: true });
    const scan2 = scanYaml(r1.content, 'test.yaml');
    const r2 = rewriteExpressions(r1.content, scan2.expressions, { maxWidth: 100, convertBlockScalars: true });
    expect(r2.count).toBe(0);
  });

  it('stable with | block scalar converted to >-', () => {
    const content = [
      'zone:',
      '  waf_rules:',
      '    rules:',
      '      - expression: |',
      '          (http.host eq "test.com"',
      '          and http.request.method eq "POST")',
      '        enabled: true',
      '',
    ].join('\n');
    const scan1 = scanYaml(content, 'test.yaml');
    const r1 = rewriteExpressions(content, scan1.expressions, { maxWidth: 100, convertBlockScalars: true });
    // After conversion to >-, rescan should be stable
    const scan2 = scanYaml(r1.content, 'test.yaml');
    const r2 = rewriteExpressions(r1.content, scan2.expressions, { maxWidth: 100, convertBlockScalars: true });
    expect(r2.count).toBe(0);
  });
});

// ── maxWidth guarantee ───────────────────────────────────────────────

describe('maxWidth guarantee: no formatted line exceeds maxWidth', () => {
  const expressions = [
    '((not http.host contains "mail" and any(http.request.headers["accept"][*] contains "text/html") and not cf.bot_management.static_resource)) and (cf.zone.plan eq "ENT")',
    '((http.host eq "a.example.com" and http.request.uri.path eq "/path1") or (http.host eq "b.example.com" and http.request.uri.path eq "/path2")) and (cf.zone.plan eq "ENT")',
    '(ip.src in {"1.2.3.4" "5.6.7.8" "9.10.11.12" "13.14.15.16" "17.18.19.20" "21.22.23.24"})',
    '(http.host eq "api.example.com" and http.request.method eq "POST" and http.request.uri.path eq "/webhook" and not ip.src in $internal)',
  ];

  for (const expr of expressions) {
    it(`within maxWidth: ${expr.substring(0, 50)}...`, () => {
      const formatted = formatExpression(expr, { maxWidth: 100 });
      for (const line of formatted.split('\n')) {
        expect(line.length).toBeLessThanOrEqual(100);
      }
    });
  }
});
