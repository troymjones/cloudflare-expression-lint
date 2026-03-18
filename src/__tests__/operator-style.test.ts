import { describe, it, expect } from 'vitest';
import { validate } from '../validator.js';

function codes(expr: string): string[] {
  return validate(expr, { expressionType: 'filter' }).diagnostics.map(d => d.code);
}

describe('Operator Style', () => {
  it('flags == and suggests eq', () => {
    expect(codes('(http.host == "test.com")')).toContain('prefer-english-operator');
  });

  it('flags != and suggests ne', () => {
    expect(codes('(http.host != "test.com")')).toContain('prefer-english-operator');
  });

  it('flags && and suggests and', () => {
    expect(codes('(http.host eq "a.com") && (http.request.method eq "POST")')).toContain('prefer-english-operator');
  });

  it('flags || and suggests or', () => {
    expect(codes('(http.host eq "a.com") || (http.host eq "b.com")')).toContain('prefer-english-operator');
  });

  it('does not flag English notation', () => {
    expect(codes('(http.host eq "test.com")')).not.toContain('prefer-english-operator');
  });

  it('does not flag and/or', () => {
    expect(codes('(http.host eq "a.com") and (http.host eq "b.com")')).not.toContain('prefer-english-operator');
  });

  it('is info severity', () => {
    const result = validate('(http.host == "test.com")', { expressionType: 'filter' });
    const d = result.diagnostics.find(d => d.code === 'prefer-english-operator');
    expect(d?.severity).toBe('info');
  });

  it('only reports each operator once per expression', () => {
    const result = validate('(http.host == "a.com") or (http.host == "b.com")', { expressionType: 'filter' });
    const count = result.diagnostics.filter(d => d.code === 'prefer-english-operator').length;
    expect(count).toBe(1); // == reported once, not twice
  });
});
