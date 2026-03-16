import { describe, it, expect } from 'vitest';
import { validate } from '../validator.js';
import type { ValidationContext, Diagnostic } from '../types.js';

/** Helper: validate filter expression and return diagnostics */
function diags(expr: string, ctx?: Partial<ValidationContext>): Diagnostic[] {
  return validate(expr, { expressionType: 'filter', ...ctx }).diagnostics;
}

function codes(expr: string, ctx?: Partial<ValidationContext>): string[] {
  return diags(expr, ctx).map(d => d.code);
}

function isValid(expr: string, ctx?: Partial<ValidationContext>): boolean {
  return validate(expr, { expressionType: 'filter', ...ctx }).valid;
}

describe('Operator Type Checking', () => {
  // ── String operators on non-String fields ──────────────────────────

  describe('contains operator type constraints', () => {
    it('allows contains on String fields', () => {
      expect(isValid('http.host contains "example"')).toBe(true);
      expect(isValid('http.user_agent contains "Bot"')).toBe(true);
      expect(isValid('http.request.uri.path contains "/admin"')).toBe(true);
    });

    it('errors on contains with IP field', () => {
      expect(codes('ip.src contains "1.2.3"')).toContain('operator-type-mismatch');
    });

    it('errors on contains with Integer field', () => {
      expect(codes('cf.bot_management.score contains "30"')).toContain('operator-type-mismatch');
    });

    it('errors on contains with Boolean field', () => {
      expect(codes('ssl contains "true"')).toContain('operator-type-mismatch');
    });
  });

  describe('matches operator type constraints', () => {
    it('allows matches on String fields', () => {
      expect(isValid('http.request.uri.path matches "^/api/"')).toBe(true);
    });

    it('errors on matches with IP field', () => {
      expect(codes('ip.src matches "1\\.2\\..*"')).toContain('operator-type-mismatch');
    });

    it('errors on matches with Integer field', () => {
      expect(codes('cf.waf.score matches "[0-9]+"')).toContain('operator-type-mismatch');
    });
  });

  describe('wildcard operator type constraints', () => {
    it('allows wildcard on String fields', () => {
      expect(isValid('http.host wildcard "*.example.com"')).toBe(true);
    });

    it('errors on wildcard with IP field', () => {
      expect(codes('ip.src wildcard "1.2.*"')).toContain('operator-type-mismatch');
    });

    it('errors on wildcard with Integer field', () => {
      expect(codes('cf.edge.server_port wildcard "80*"')).toContain('operator-type-mismatch');
    });
  });

  // ── Ordering operators on unsupported types ────────────────────────

  describe('ordering operator type constraints', () => {
    it('allows lt/gt/le/ge on Integer fields', () => {
      expect(isValid('cf.bot_management.score gt 30')).toBe(true);
      expect(isValid('cf.bot_management.score lt 10')).toBe(true);
      expect(isValid('cf.waf.score ge 1')).toBe(true);
      expect(isValid('cf.waf.score le 99')).toBe(true);
    });

    it('allows lt/gt/le/ge on String fields', () => {
      expect(isValid('http.request.uri.path gt "/a"')).toBe(true);
    });

    it('errors on lt/gt with IP field', () => {
      expect(codes('ip.src gt "1.2.3.4"')).toContain('operator-type-mismatch');
    });

    it('errors on lt/gt with Boolean field', () => {
      expect(codes('ssl gt 0')).toContain('operator-type-mismatch');
    });

    it('errors on le/ge with IP field', () => {
      expect(codes('ip.src le "10.0.0.0"')).toContain('operator-type-mismatch');
    });

    it('errors on < > with Boolean field', () => {
      expect(codes('ssl < 1')).toContain('operator-type-mismatch');
    });
  });

  // ── Equality operators (broad compatibility) ───────────────────────

  describe('equality operator type constraints', () => {
    it('allows eq/== on all field types', () => {
      expect(isValid('http.host eq "example.com"')).toBe(true);
      expect(isValid('cf.bot_management.score eq 30')).toBe(true);
      expect(isValid('ip.src == 1.2.3.4')).toBe(true);
    });
  });

  // ── In operator constraints ────────────────────────────────────────

  describe('in operator type constraints', () => {
    it('allows in on String fields', () => {
      expect(isValid('http.host in {"a.com" "b.com"}')).toBe(true);
    });

    it('allows in on Integer fields', () => {
      expect(isValid('cf.edge.server_port in {80 443 8080}')).toBe(true);
    });

    it('allows in on IP fields', () => {
      expect(isValid('ip.src in {1.2.3.0/24}')).toBe(true);
    });

    it('allows in with named lists', () => {
      expect(isValid('ip.src in $my_allowlist')).toBe(true);
    });
  });
});

describe('Header Key Casing Warning', () => {
  it('warns on uppercase header key', () => {
    const diagnostics = diags('http.request.headers["Content-Type"] eq "text/html"');
    expect(diagnostics.some(d => d.code === 'header-key-not-lowercase')).toBe(true);
  });

  it('does not warn on lowercase header key', () => {
    const diagnostics = diags('http.request.headers["content-type"] eq "text/html"');
    expect(diagnostics.some(d => d.code === 'header-key-not-lowercase')).toBe(false);
  });

  it('warns on mixed-case header key', () => {
    const diagnostics = diags('http.request.headers["X-Forwarded-For"] eq "1.2.3.4"');
    expect(diagnostics.some(d => d.code === 'header-key-not-lowercase')).toBe(true);
  });

  it('header key warning is a warning not an error', () => {
    const result = validate('http.request.headers["Content-Type"] eq "text/html"', { expressionType: 'filter' });
    expect(result.valid).toBe(true); // warnings don't make it invalid
    expect(result.diagnostics.some(d => d.severity === 'warning' && d.code === 'header-key-not-lowercase')).toBe(true);
  });
});

describe('CIDR with Equality Operator', () => {
  it('errors when using CIDR notation with eq', () => {
    // ip.src eq 1.2.3.0/24 is NOT valid — must use `in`
    // This is hard to catch at AST level since the parser would need to
    // recognize CIDR in equality context. For now, we test the validator
    // catches it if we can parse it.
    // Note: This may be caught as a parse error instead, which is also acceptable.
    const result = validate('ip.src == 1.2.3.0/24', { expressionType: 'filter' });
    expect(result.valid).toBe(false);
  });
});

describe('Boolean Field Style Hints', () => {
  it('suggests bare form over explicit == true', () => {
    const diagnostics = diags('ssl == true');
    expect(diagnostics.some(d => d.code === 'prefer-bare-boolean')).toBe(true);
  });

  it('suggests bare form over explicit eq true', () => {
    const diagnostics = diags('ssl eq true');
    expect(diagnostics.some(d => d.code === 'prefer-bare-boolean')).toBe(true);
  });

  it('does not flag bare boolean usage', () => {
    expect(codes('ssl')).not.toContain('prefer-bare-boolean');
  });

  it('does not flag negated boolean', () => {
    expect(codes('not ssl')).not.toContain('prefer-bare-boolean');
  });

  it('does not flag == false (different semantics than not)', () => {
    // ssl == false is not the same as "not ssl" in edge cases
    // so we don't flag this
    expect(codes('ssl == false')).not.toContain('prefer-bare-boolean');
  });

  it('flags cf.bot_management.verified_bot == true', () => {
    const diagnostics = diags('cf.bot_management.verified_bot == true');
    expect(diagnostics.some(d => d.code === 'prefer-bare-boolean')).toBe(true);
  });

  it('boolean style hint is info severity', () => {
    const diagnostics = diags('ssl eq true');
    const hint = diagnostics.find(d => d.code === 'prefer-bare-boolean');
    expect(hint?.severity).toBe('info');
  });
});
