import { describe, it, expect } from 'vitest';
import { validate } from '../validator.js';

describe('Expression Whitespace', () => {
  it('warns on trailing whitespace', () => {
    const result = validate('(http.host eq "test.com") ', { expressionType: 'filter' });
    expect(result.diagnostics.some(d => d.code === 'expression-whitespace')).toBe(true);
  });

  it('warns on leading whitespace', () => {
    const result = validate(' (http.host eq "test.com")', { expressionType: 'filter' });
    expect(result.diagnostics.some(d => d.code === 'expression-whitespace')).toBe(true);
  });

  it('does not warn on clean expression', () => {
    const result = validate('(http.host eq "test.com")', { expressionType: 'filter' });
    expect(result.diagnostics.some(d => d.code === 'expression-whitespace')).toBe(false);
  });

  it('is warning severity', () => {
    const result = validate('(http.host eq "test.com") ', { expressionType: 'filter' });
    const d = result.diagnostics.find(d => d.code === 'expression-whitespace');
    expect(d?.severity).toBe('warning');
  });
});
