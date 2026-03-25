import { describe, it, expect } from 'vitest';
import { substitutePlaceholders, restorePlaceholders, containsPlaceholders } from '../placeholders.js';
import { formatExpression } from '../formatter.js';
import { fixExpression } from '../fixer.js';

describe('containsPlaceholders', () => {
  it('detects __NAME__ pattern', () => {
    expect(containsPlaceholders('ip.src in {__BLOCKED_IPS__}')).toBe(true);
  });

  it('detects legacy UPPER_CASE pattern (backwards compat)', () => {
    expect(containsPlaceholders('ip.src in {BLOCKED_IPS}')).toBe(true);
  });

  it('ignores placeholders inside quoted strings', () => {
    expect(containsPlaceholders('http.host eq "__BLOCKED_IPS__"')).toBe(false);
    expect(containsPlaceholders('http.host eq "BLOCKED_IPS"')).toBe(false);
  });

  it('ignores short identifiers', () => {
    expect(containsPlaceholders('http.request.method eq "GET"')).toBe(false);
  });

  it('ignores identifiers without underscore', () => {
    expect(containsPlaceholders('http.host eq "ABCDEF"')).toBe(false);
  });

  it('ignores field access with uppercase (cf.BOT_MANAGEMENT)', () => {
    expect(containsPlaceholders('cf.bot_management.score lt 30')).toBe(false);
  });

  it('returns false for plain expressions', () => {
    expect(containsPlaceholders('(http.host eq "test.com")')).toBe(false);
  });
});

describe('substitutePlaceholders', () => {
  it('substitutes __NAME__ placeholder in set literal', () => {
    const result = substitutePlaceholders('ip.src in {__BLOCKED_IPS__}');
    expect(result.expression).toMatch(/"ph\d/);
    expect(result.expression).not.toContain('__BLOCKED_IPS__');
    expect(result.map.size).toBe(1);
    expect([...result.map.values()][0]).toBe('__BLOCKED_IPS__');
  });

  it('substitutes legacy UPPER_CASE pattern (backwards compat)', () => {
    const result = substitutePlaceholders('ip.src in {BLOCKED_IPS}');
    expect(result.expression).toMatch(/"ph\d/);
    expect(result.map.size).toBe(1);
  });

  it('handles multiple different placeholders', () => {
    const result = substitutePlaceholders('ip.src in {__ALLOWED_IPS__} and http.host in {__ALLOWED_HOSTS__}');
    expect(result.map.size).toBe(2);
  });

  it('uses same synthetic for duplicate placeholders', () => {
    const result = substitutePlaceholders('ip.src in {__BLOCKED_IPS__} or ip.dst in {__BLOCKED_IPS__}');
    expect(result.map.size).toBe(1);
    const synthetic = [...result.map.keys()][0];
    const matches = result.expression.match(new RegExp(synthetic.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'));
    expect(matches).toHaveLength(2);
  });

  it('does not substitute inside quoted strings', () => {
    const result = substitutePlaceholders('http.host eq "__BLOCKED_IPS__"');
    expect(result.map.size).toBe(0);
    expect(result.expression).toBe('http.host eq "__BLOCKED_IPS__"');
  });

  it('returns unchanged expression when no placeholders', () => {
    const expr = '(http.host eq "test.com")';
    const result = substitutePlaceholders(expr);
    expect(result.expression).toBe(expr);
    expect(result.map.size).toBe(0);
  });

  it('does not match field access after dot', () => {
    const result = substitutePlaceholders('cf.BOT_MANAGEMENT eq true');
    expect(result.map.size).toBe(0);
  });
});

describe('restorePlaceholders', () => {
  it('round-trips __NAME__ through substitute and restore', () => {
    const expr = 'ip.src in {__BLOCKED_IPS__}';
    const { expression: substituted, map } = substitutePlaceholders(expr);
    expect(restorePlaceholders(substituted, map)).toBe(expr);
  });

  it('round-trips multiple placeholders', () => {
    const expr = 'ip.src in {__ALLOWED_IPS__} and http.host in {__ALLOWED_HOSTS__}';
    const { expression: substituted, map } = substitutePlaceholders(expr);
    expect(restorePlaceholders(substituted, map)).toBe(expr);
  });

  it('round-trips duplicate occurrences', () => {
    const expr = 'ip.src in {__BLOCKED_IPS__} or ip.dst in {__BLOCKED_IPS__}';
    const { expression: substituted, map } = substitutePlaceholders(expr);
    expect(restorePlaceholders(substituted, map)).toBe(expr);
  });

  it('round-trips legacy UPPER_CASE pattern (backwards compat)', () => {
    const expr = 'ip.src in {BLOCKED_IPS}';
    const { expression: substituted, map } = substitutePlaceholders(expr);
    expect(restorePlaceholders(substituted, map)).toBe(expr);
  });

  it('returns unchanged when map is empty', () => {
    expect(restorePlaceholders('(http.host eq "test.com")', new Map())).toBe('(http.host eq "test.com")');
  });
});

describe('formatExpression with placeholders', () => {
  it('formats expression with __NAME__ placeholder in set literal', () => {
    const expr = '(http.request.uri.path eq "/api" and http.request.method eq "POST" and any(http.request.headers["x-app"][*] in {__ALLOWED_APPS__}))';
    const result = formatExpression(expr, { maxWidth: 80 });
    expect(result).toContain('__ALLOWED_APPS__');
    expect(result).toContain('\n');
    expect(result).not.toContain('"__ALLOWED_APPS__"');
  });

  it('preserves multiple __NAME__ placeholders through formatting', () => {
    const expr = '(ip.src in {__ALLOWED_IPS__} and http.host in {__ALLOWED_HOSTS__})';
    const result = formatExpression(expr, { maxWidth: 40 });
    expect(result).toContain('__ALLOWED_IPS__');
    expect(result).toContain('__ALLOWED_HOSTS__');
  });

  it('handles short expression with placeholder (stays inline)', () => {
    const expr = '(ip.src in {__BLOCKED_IPS__})';
    const result = formatExpression(expr, { maxWidth: 120 });
    expect(result).toBe('(ip.src in {__BLOCKED_IPS__})');
  });

  it('formats legacy UPPER_CASE placeholder (backwards compat)', () => {
    const expr = '(http.request.uri.path eq "/api" and any(http.request.headers["x-app"][*] in {ALLOWED_APPS}))';
    const result = formatExpression(expr, { maxWidth: 80 });
    expect(result).toContain('ALLOWED_APPS');
    expect(result).not.toContain('"ALLOWED_APPS"');
  });
});

describe('fixExpression with placeholders', () => {
  it('wraps bare expression with __NAME__ placeholder', () => {
    const result = fixExpression('ip.src in {__BLOCKED_IPS__}');
    expect(result.expression).toBe('(ip.src in {__BLOCKED_IPS__})');
    expect(result.changed).toBe(true);
  });

  it('merges and-groups with __NAME__ placeholder', () => {
    const result = fixExpression('(http.host eq "test.com") and (ip.src in {__ALLOWED_IPS__})');
    expect(result.expression).toBe('(http.host eq "test.com" and ip.src in {__ALLOWED_IPS__})');
    expect(result.changed).toBe(true);
  });

  it('fix is idempotent with __NAME__ placeholders', () => {
    const first = fixExpression('(http.host eq "test.com") and (ip.src in {__BLOCKED_IPS__})');
    const second = fixExpression(first.expression);
    expect(second.changed).toBe(false);
    expect(second.expression).toBe(first.expression);
  });

  it('fixes legacy UPPER_CASE placeholder (backwards compat)', () => {
    const result = fixExpression('ip.src in {BLOCKED_IPS}');
    expect(result.expression).toBe('(ip.src in {BLOCKED_IPS})');
  });
});

describe('fix + format pipeline with placeholders', () => {
  it('converges with __NAME__ placeholder', () => {
    const expr = '(http.host eq "test.com") and (ip.src in {__BLOCKED_IPS__})';
    const fixed = fixExpression(expr).expression;
    const formatted = formatExpression(fixed, { maxWidth: 120 });
    const rejoined = formatted.split('\n').map(l => l.trim()).join(' ');
    const refixed = fixExpression(rejoined);
    expect(refixed.changed).toBe(false);
  });

  it('placeholder survives full pipeline', () => {
    const expr = '(http.request.uri.path eq "/api" and http.request.method eq "POST" and any(http.request.headers["x-app"][*] in {__ALLOWED_APPS__}))';
    const fixed = fixExpression(expr).expression;
    const formatted = formatExpression(fixed, { maxWidth: 80 });
    expect(formatted).toContain('__ALLOWED_APPS__');
    expect(formatted).not.toContain('"__ALLOWED_APPS__"');
    expect(formatted).not.toContain('ph0');
  });
});
