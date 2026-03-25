/**
 * Error handling and recovery tests.
 *
 * Tests that the linter handles malformed input gracefully:
 * parse failures, truncated expressions, invalid syntax, and
 * edge cases that could cause crashes.
 */

import { describe, it, expect } from 'vitest';
import { parse } from '../parser.js';
import { validate } from '../validator.js';
import { fixExpression } from '../fixer.js';
import { formatExpression } from '../formatter.js';
import { rewriteExpressions } from '../rewriter.js';

describe('parser error handling', () => {
  it('throws on empty string', () => {
    expect(() => parse('')).toThrow();
  });

  it('throws on unclosed parenthesis', () => {
    expect(() => parse('(http.host eq "test.com"')).toThrow();
  });

  it('throws on unclosed string', () => {
    expect(() => parse('(http.host eq "test.com)')).toThrow();
  });

  it('throws on incomplete expression', () => {
    expect(() => parse('http.host eq')).toThrow();
  });

  it('throws on double operator', () => {
    expect(() => parse('(http.host eq eq "test.com")')).toThrow();
  });

  it('throws on trailing operator', () => {
    expect(() => parse('(http.host eq "test.com") and')).toThrow();
  });

  it('throws on empty group', () => {
    expect(() => parse('()')).toThrow();
  });

  it('throws on bare operator', () => {
    expect(() => parse('and')).toThrow();
  });
});

describe('validator error handling', () => {
  it('returns parse error diagnostic for unparseable expression', () => {
    const result = validate('(http.host eq', { expressionType: 'filter' });
    const parseErrors = result.diagnostics.filter(d => d.code === 'parse-error');
    expect(parseErrors.length).toBeGreaterThan(0);
    expect(result.valid).toBe(false);
  });

  it('handles empty expression', () => {
    const result = validate('', { expressionType: 'filter' });
    expect(result.valid).toBe(false);
  });

  it('handles whitespace-only expression', () => {
    const result = validate('   ', { expressionType: 'filter' });
    expect(result.valid).toBe(false);
  });

  it('demotes parse error to warning for placeholder expressions', () => {
    const result = validate('(http.host eq __PLACEHOLDER__)', { expressionType: 'filter' });
    // Should not be a hard error since it has placeholders
    const hardErrors = result.diagnostics.filter(d => d.severity === 'error' && d.code === 'parse-error');
    expect(hardErrors).toHaveLength(0);
  });
});

describe('fixer error handling', () => {
  it('returns unchanged for unparseable expression', () => {
    const result = fixExpression('(http.host eq');
    expect(result.changed).toBe(false);
    expect(result.expression).toBe('(http.host eq');
  });

  it('returns unchanged for empty expression', () => {
    const result = fixExpression('');
    expect(result.changed).toBe(false);
  });

  it('handles expression with only whitespace', () => {
    const result = fixExpression('   ');
    expect(result.changed).toBe(false);
  });

  it('does not crash on deeply nested parentheses', () => {
    const deep = '('.repeat(50) + 'http.host eq "test.com"' + ')'.repeat(50);
    const result = fixExpression(deep);
    // Should not crash, may or may not change
    expect(typeof result.expression).toBe('string');
  });
});

describe('formatter error handling', () => {
  it('returns trimmed input for unparseable expression', () => {
    const result = formatExpression('  (http.host eq  ');
    expect(result).toBe('(http.host eq');
  });

  it('returns empty string for empty input', () => {
    const result = formatExpression('');
    expect(result).toBe('');
  });

  it('handles expression with only whitespace', () => {
    const result = formatExpression('   ');
    expect(result).toBe('');
  });

  it('does not crash on very long expression', () => {
    const conditions = Array.from({ length: 100 }, (_, i) =>
      `http.host eq "host${i}.com"`
    ).join(' and ');
    const expr = `(${conditions})`;
    const result = formatExpression(expr, { maxWidth: 100 });
    expect(result).toContain('host0.com');
    expect(result).toContain('host99.com');
  });
});

describe('rewriter error handling', () => {
  it('handles empty content', () => {
    const result = rewriteExpressions('', [], { maxWidth: 100 });
    expect(result.content).toBe('');
    expect(result.count).toBe(0);
  });

  it('handles empty expressions list', () => {
    const content = 'zone:\n  expression: (http.host eq "test.com")\n';
    const result = rewriteExpressions(content, [], { maxWidth: 100 });
    expect(result.content).toBe(content);
    expect(result.count).toBe(0);
  });

  it('handles expression not found in content', () => {
    const content = 'zone:\n  expression: (http.host eq "a.com")\n';
    const result = rewriteExpressions(content, [{ expression: '(http.host eq "b.com")' }], { maxWidth: 100 });
    expect(result.count).toBe(0);
  });

  it('does not crash on binary-like content', () => {
    const content = 'expression: \x00\x01\x02\n';
    const result = rewriteExpressions(content, [{ expression: '\x00\x01\x02' }], { maxWidth: 100 });
    // Should not crash
    expect(typeof result.content).toBe('string');
  });
});
