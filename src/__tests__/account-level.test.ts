import { describe, it, expect } from 'vitest';
import { validate } from '../validator.js';
import type { Diagnostic } from '../types.js';

function diags(expr: string, accountLevel = true): Diagnostic[] {
  return validate(expr, { expressionType: 'filter', accountLevel }).diagnostics;
}

function codes(expr: string, accountLevel = true): string[] {
  return diags(expr, accountLevel).map(d => d.code);
}

describe('Account-Level Zone Plan Filter', () => {
  describe('requires zone plan suffix', () => {
    it('accepts standalone (cf.zone.plan eq "ENT")', () => {
      expect(codes('(cf.zone.plan eq "ENT")')).not.toContain('missing-zone-plan-filter');
    });

    it('accepts expression with zone plan suffix', () => {
      expect(codes('(http.host eq "test.com") and (cf.zone.plan eq "ENT")')).not.toContain('missing-zone-plan-filter');
    });

    it('accepts complex expression with zone plan suffix', () => {
      expect(codes(
        '((http.host in {"secure.example.com" "api.example.net"} and http.request.uri.path eq "/auth")) and (cf.zone.plan eq "ENT")'
      )).not.toContain('missing-zone-plan-filter');
    });

    it('warns when zone plan suffix is missing', () => {
      expect(codes('(http.host eq "test.com")')).toContain('missing-zone-plan-filter');
    });

    it('does not warn when not account level', () => {
      expect(codes('(http.host eq "test.com")', false)).not.toContain('missing-zone-plan-filter');
    });
  });

  describe('outer parens with zone plan suffix', () => {
    it('does not flag no-outer-parens on the overall expression', () => {
      // The overall expression is (A) and (cf.zone.plan eq "ENT") — not wrapped in outer parens
      expect(codes(
        '(http.host eq "test.com") and (cf.zone.plan eq "ENT")'
      )).not.toContain('no-outer-parens');
    });

    it('flags no-outer-parens on the filter part if unwrapped', () => {
      expect(codes(
        'http.host eq "test.com" and (cf.zone.plan eq "ENT")'
      )).toContain('no-outer-parens');
    });

    it('does not flag when filter part is wrapped', () => {
      expect(codes(
        '(http.host eq "test.com") and (cf.zone.plan eq "ENT")'
      )).not.toContain('no-outer-parens');
    });

    it('does not flag standalone plan filter', () => {
      expect(codes('(cf.zone.plan eq "ENT")')).not.toContain('no-outer-parens');
    });
  });
});
