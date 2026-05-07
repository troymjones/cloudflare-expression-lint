import { describe, it, expect } from 'vitest';
import { scanYaml, getDefaultExpressionKeys } from '../yaml-scanner.js';
import { analyzeDirectives, isLineSuppressed } from '../directives.js';

const KEYS = new Set(Object.keys(getDefaultExpressionKeys()));

/** Filter scanResult diagnostics through the directive index. */
function filtered(yaml: string) {
  const scan = scanYaml(yaml, 'test.yaml');
  const { ranges, expressionKeyLines } = analyzeDirectives(yaml, KEYS);
  return scan.expressions.map((expr, i) => {
    const keyLine = expressionKeyLines[i]?.keyLine;
    const remaining = keyLine === undefined
      ? expr.result.diagnostics
      : expr.result.diagnostics.filter(d => !isLineSuppressed(ranges, keyLine, d.code));
    return { keyLine, expression: expr.expression, remaining };
  });
}

describe('directive integration with scanYaml', () => {
  it('disable-next-line removes a real diagnostic from a >- block scalar', () => {
    // `unknown-field` is a definite error when the field doesn't exist.
    const yaml = `rules:
  # cf-expr-lint-disable-next-line unknown-field
  - expression: >-
      (http.totally_made_up_field eq "x")
`;
    const baseline = scanYaml(yaml, 'test.yaml').expressions[0].result.diagnostics;
    expect(baseline.some(d => d.code === 'unknown-field')).toBe(true);

    const out = filtered(yaml);
    expect(out[0].remaining.some(d => d.code === 'unknown-field')).toBe(false);
  });

  it('bare disable-next-line strips all diagnostics', () => {
    const yaml = `rules:
  # cf-expr-lint-disable-next-line
  - expression: '(http.totally_made_up_field eq "x")'
`;
    const out = filtered(yaml);
    expect(out[0].remaining).toEqual([]);
  });

  it('disable-line on a trailing comment suppresses the inline expression', () => {
    const yaml = `rules:
  - expression: '(http.totally_made_up_field eq "x")'  # cf-expr-lint-disable-line unknown-field
`;
    const out = filtered(yaml);
    expect(out[0].remaining.some(d => d.code === 'unknown-field')).toBe(false);
  });

  it('disable-file affects every expression in the file', () => {
    const yaml = `# cf-expr-lint-disable-file unknown-field
rules:
  - expression: '(http.totally_made_up_field eq "a")'
  - expression: '(http.another_made_up_field eq "b")'
`;
    const out = filtered(yaml);
    expect(out[0].remaining.some(d => d.code === 'unknown-field')).toBe(false);
    expect(out[1].remaining.some(d => d.code === 'unknown-field')).toBe(false);
  });

  it('disable / enable bracket only the wrapped expressions', () => {
    const yaml = `rules:
  - expression: '(http.totally_made_up_field eq "outside-1")'
# cf-expr-lint-disable unknown-field
  - expression: '(http.totally_made_up_field eq "inside")'
# cf-expr-lint-enable
  - expression: '(http.totally_made_up_field eq "outside-2")'
`;
    const out = filtered(yaml);
    expect(out[0].remaining.some(d => d.code === 'unknown-field')).toBe(true);
    expect(out[1].remaining.some(d => d.code === 'unknown-field')).toBe(false);
    expect(out[2].remaining.some(d => d.code === 'unknown-field')).toBe(true);
  });

  it('directive with a non-matching code does not suppress real diagnostics', () => {
    const yaml = `rules:
  # cf-expr-lint-disable-next-line some-other-code
  - expression: '(http.totally_made_up_field eq "x")'
`;
    const out = filtered(yaml);
    expect(out[0].remaining.some(d => d.code === 'unknown-field')).toBe(true);
  });
});
