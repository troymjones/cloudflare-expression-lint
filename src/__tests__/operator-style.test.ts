import { describe, it, expect } from 'vitest';
import { validate } from '../validator.js';

function codes(expr: string, operatorStyle?: 'english' | 'clike' | 'off'): string[] {
  return validate(expr, { expressionType: 'filter', operatorStyle }).diagnostics.map(d => d.code);
}

describe('Operator Style', () => {
  describe('english mode (default)', () => {
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

  describe('clike mode', () => {
    it('flags eq and suggests ==', () => {
      expect(codes('(http.host eq "test.com")', 'clike')).toContain('prefer-clike-operator');
    });

    it('flags ne and suggests !=', () => {
      expect(codes('(http.host ne "test.com")', 'clike')).toContain('prefer-clike-operator');
    });

    it('flags and and suggests &&', () => {
      expect(codes('(http.host == "a.com") and (http.request.method == "POST")', 'clike')).toContain('prefer-clike-operator');
    });

    it('flags or and suggests ||', () => {
      expect(codes('(http.host == "a.com") or (http.host == "b.com")', 'clike')).toContain('prefer-clike-operator');
    });

    it('does not flag C-like notation', () => {
      expect(codes('(http.host == "test.com")', 'clike')).not.toContain('prefer-clike-operator');
    });

    it('does not flag &&/||', () => {
      expect(codes('(http.host == "a.com") && (http.host == "b.com")', 'clike')).not.toContain('prefer-clike-operator');
    });

    it('is info severity', () => {
      const result = validate('(http.host eq "test.com")', { expressionType: 'filter', operatorStyle: 'clike' });
      const d = result.diagnostics.find(d => d.code === 'prefer-clike-operator');
      expect(d?.severity).toBe('info');
    });
  });

  describe('off mode', () => {
    it('does not flag C-like operators', () => {
      expect(codes('(http.host == "test.com")', 'off')).not.toContain('prefer-english-operator');
      expect(codes('(http.host == "test.com")', 'off')).not.toContain('prefer-clike-operator');
    });

    it('does not flag English operators', () => {
      expect(codes('(http.host eq "test.com")', 'off')).not.toContain('prefer-english-operator');
      expect(codes('(http.host eq "test.com")', 'off')).not.toContain('prefer-clike-operator');
    });
  });
});
