import { describe, it, expect } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { inlineScalar, rewriteExpressions } from '../rewriter.js';

/** Emit `expression: <scalar>`, parse it as YAML, and return what YAML read back. */
function roundTrip(value: string): unknown {
  return (parseYaml(`expression: ${inlineScalar(value)}\n`) as Record<string, unknown>).expression;
}

describe('inlineScalar', () => {
  // Anything that survives this is safe to write without a block scalar.
  const values = [
    '(http.host eq "example.com")',
    '(http.host eq r"api.example.com" and http.request.uri.path wildcard r"/*/bowl")',
    '(ip.src.country eq "T1")',
    '(http.request.uri.path matches "^/adminApi/feed/.*/uploadPosts$")',
    '(http.user_agent matches r"Some App \\d{1,2}\\.\\d$")',
    '(ip.src in {2601:445:200:68a0:a98a:8aee:2b8c:d207 71.191.182.13})',
    '(http.request.uri.path contains "a: b")',
    '(http.request.uri.path contains " #tag")',
    '(http.request.uri.path contains "it\'s")',
    '(http.request.uri.path contains "quote\\" and apostrophe\'")',
    'not http.host eq "example.com"',
    '(http.host in {"a.com" "b.com"})',
  ];

  for (const value of values) {
    it(`round-trips: ${value.slice(0, 52)}`, () => {
      expect(roundTrip(value)).toBe(value);
    });
  }

  it('prefers plain style when it is safe', () => {
    expect(inlineScalar('(http.host eq "a.com")')).toBe('(http.host eq "a.com")');
  });

  it('quotes a value containing a mapping separator', () => {
    expect(inlineScalar('(http.host eq "a: b")')).not.toBe('(http.host eq "a: b")');
  });

  it('keeps backslashes unescaped by using single quotes', () => {
    const value = '(http.user_agent matches r"\\d+")';
    const scalar = inlineScalar(value);
    expect(scalar).not.toContain('\\\\');
    expect(roundTrip(value)).toBe(value);
  });
});

describe('rewriter emits parseable inline scalars', () => {
  it('a wrapped expression reads back exactly', () => {
    const original = 'http.host eq r"api.example.com" and http.request.uri.path wildcard r"/*/bowl"';
    const content = `rules:\n  - expression: "${original.replace(/"/g, '\\"')}"\n`;

    const result = rewriteExpressions(content, [{ expression: original }], {
      maxWidth: 100,
      replacements: new Map([[original, `(${original})`]]),
      onlyReplacements: true,
    });

    expect(result.content).not.toContain('>-');
    const parsed = parseYaml(result.content) as { rules: { expression: string }[] };
    expect(parsed.rules[0].expression).toBe(`(${original})`);
  });
});
