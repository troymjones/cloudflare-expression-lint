import { describe, it, expect } from 'vitest';
import { analyzeDirectives, isLineSuppressed } from '../directives.js';

const KEYS = new Set(['expression']);

function suppressedCodesAt(content: string, line: number, candidateCodes: string[]): string[] {
  const { ranges } = analyzeDirectives(content, KEYS);
  return candidateCodes.filter(c => isLineSuppressed(ranges, line, c));
}

describe('directives — disable-file', () => {
  it('suppresses every code on every line', () => {
    const yaml = `# cf-expr-lint-disable-file
rules:
  - expression: 'http.host eq "x"'
`;
    const codes = suppressedCodesAt(yaml, 3, ['anything', 'something-else']);
    expect(codes).toEqual(['anything', 'something-else']);
  });

  it('limits to listed codes when codes are given', () => {
    const yaml = `# cf-expr-lint-disable-file foo,bar
rules:
  - expression: 'http.host eq "x"'
`;
    const codes = suppressedCodesAt(yaml, 3, ['foo', 'bar', 'baz']);
    expect(codes).toEqual(['foo', 'bar']);
  });

  it('accepts whitespace-separated code lists', () => {
    const yaml = `# cf-expr-lint-disable-file foo bar
rules:
  - expression: 'http.host eq "x"'
`;
    const codes = suppressedCodesAt(yaml, 3, ['foo', 'bar', 'baz']);
    expect(codes).toEqual(['foo', 'bar']);
  });
});

describe('directives — disable / enable block', () => {
  it('suppresses lines between disable and enable', () => {
    const yaml = `rules:
  - expression: 'http.host eq "a"'
# cf-expr-lint-disable
  - expression: 'http.host eq "b"'
  - expression: 'http.host eq "c"'
# cf-expr-lint-enable
  - expression: 'http.host eq "d"'
`;
    const { ranges } = analyzeDirectives(yaml, KEYS);
    expect(isLineSuppressed(ranges, 2, 'x')).toBe(false);
    expect(isLineSuppressed(ranges, 4, 'x')).toBe(true);
    expect(isLineSuppressed(ranges, 5, 'x')).toBe(true);
    expect(isLineSuppressed(ranges, 7, 'x')).toBe(false);
  });

  it('extends to end of file when enable is missing', () => {
    const yaml = `# cf-expr-lint-disable
  - expression: 'http.host eq "a"'
  - expression: 'http.host eq "b"'
`;
    const { ranges } = analyzeDirectives(yaml, KEYS);
    expect(isLineSuppressed(ranges, 2, 'x')).toBe(true);
    expect(isLineSuppressed(ranges, 3, 'x')).toBe(true);
  });

  it('honors code list on the disable directive', () => {
    const yaml = `# cf-expr-lint-disable foo
  - expression: 'http.host eq "a"'
# cf-expr-lint-enable
`;
    const { ranges } = analyzeDirectives(yaml, KEYS);
    expect(isLineSuppressed(ranges, 2, 'foo')).toBe(true);
    expect(isLineSuppressed(ranges, 2, 'bar')).toBe(false);
  });
});

describe('directives — disable-next-line (anchor mode)', () => {
  it('suppresses all lines of a >- block scalar when the next line is the key', () => {
    const yaml = `rules:
  # cf-expr-lint-disable-next-line foo
  - expression: >-
      (http.host eq "a")
      and (http.request.uri.path eq "/x")
    description: hi
`;
    const { ranges } = analyzeDirectives(yaml, KEYS);
    // Line 3 is the `- expression: >-` line; lines 4–5 are block content.
    expect(isLineSuppressed(ranges, 3, 'foo')).toBe(true);
    expect(isLineSuppressed(ranges, 4, 'foo')).toBe(true);
    expect(isLineSuppressed(ranges, 5, 'foo')).toBe(true);
    // Line 6 is `description:` — outside the expression range.
    expect(isLineSuppressed(ranges, 6, 'foo')).toBe(false);
  });

  it('suppresses only the literal next line when it is not an expression key', () => {
    const yaml = `# cf-expr-lint-disable-next-line foo
  some_other_key: 1
  expression: 'http.host eq "x"'
`;
    const { ranges } = analyzeDirectives(yaml, KEYS);
    expect(isLineSuppressed(ranges, 2, 'foo')).toBe(true);
    expect(isLineSuppressed(ranges, 3, 'foo')).toBe(false);
  });

  it('skips blank lines and comment lines when finding the next target', () => {
    const yaml = `# cf-expr-lint-disable-next-line foo

# another comment
  - expression: 'http.host eq "x"'
`;
    const { ranges } = analyzeDirectives(yaml, KEYS);
    expect(isLineSuppressed(ranges, 4, 'foo')).toBe(true);
  });

  it('without codes, suppresses all codes on the anchored expression', () => {
    const yaml = `# cf-expr-lint-disable-next-line
  - expression: >-
      (http.host eq "a")
      and (http.request.uri.path eq "/x")
`;
    const { ranges } = analyzeDirectives(yaml, KEYS);
    expect(isLineSuppressed(ranges, 2, 'any-code')).toBe(true);
    expect(isLineSuppressed(ranges, 3, 'another')).toBe(true);
  });
});

describe('directives — disable-line', () => {
  it('suppresses only the same line as the directive', () => {
    const yaml = `rules:
  - expression: 'http.host eq "x"'  # cf-expr-lint-disable-line foo
  - expression: 'http.host eq "y"'
`;
    const { ranges } = analyzeDirectives(yaml, KEYS);
    expect(isLineSuppressed(ranges, 2, 'foo')).toBe(true);
    expect(isLineSuppressed(ranges, 3, 'foo')).toBe(false);
  });
});

describe('directives — block-scalar safety', () => {
  it('ignores directive-shaped strings inside block scalar content', () => {
    const yaml = `rules:
  - description: >-
      this looks like # cf-expr-lint-disable-file but is YAML content
  - expression: 'http.host eq "x"'
`;
    const { ranges } = analyzeDirectives(yaml, KEYS);
    expect(ranges.length).toBe(0);
    expect(isLineSuppressed(ranges, 4, 'foo')).toBe(false);
  });
});

describe('directives — expression key tracking', () => {
  it('maps each expression to its key line in source order', () => {
    const yaml = `rules:
  - expression: 'http.host eq "a"'
  - expression: >-
      (http.host eq "b")
      and (http.request.uri.path eq "/x")
  - expression: 'http.host eq "c"'
`;
    const { expressionKeyLines } = analyzeDirectives(yaml, KEYS);
    expect(expressionKeyLines.map(k => k.keyLine)).toEqual([2, 3, 6]);
    // The middle expression has a multi-line range.
    expect(expressionKeyLines[1].rangeEnd).toBeGreaterThanOrEqual(5);
  });
});
