import { describe, it, expect } from 'vitest';
import { validate } from '../validator.js';
import { fixExpression } from '../fixer.js';

function lint(expr: string, code: string): string[] {
  const result = validate(expr, { expressionType: 'filter' });
  return result.diagnostics.filter(d => d.code === code).map(d => d.message);
}

describe('illogical-condition', () => {
  it('flags A eq X and A eq Y with different literals', () => {
    const msgs = lint('http.host eq "a.com" and http.host eq "b.com"', 'illogical-condition');
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toContain('always false');
  });

  it('flags A ne X or A ne Y with different literals', () => {
    const msgs = lint('http.host ne "a.com" or http.host ne "b.com"', 'illogical-condition');
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toContain('always true');
  });

  it('does not flag A eq X or A eq Y (collapsible to `in`)', () => {
    expect(lint('http.host eq "a.com" or http.host eq "b.com"', 'illogical-condition')).toHaveLength(0);
  });

  it('does not flag A eq X and B eq Y (different fields)', () => {
    expect(lint('http.host eq "a.com" and http.request.uri.path eq "/foo"', 'illogical-condition')).toHaveLength(0);
  });

  it('does not flag A eq X and A ne Y (different ops)', () => {
    expect(lint('http.host eq "a.com" and http.host ne "b.com"', 'illogical-condition')).toHaveLength(0);
  });

  it('does not flag A eq X and A eq X (redundant, not illogical)', () => {
    expect(lint('http.host eq "a.com" and http.host eq "a.com"', 'illogical-condition')).toHaveLength(0);
  });

  it('reports once per chain, not per pair', () => {
    const msgs = lint('http.host eq "a" and http.host eq "b" and http.host eq "c"', 'illogical-condition');
    expect(msgs).toHaveLength(1);
  });

  it('treats grouped sub-expressions as opaque (does not cross group boundary)', () => {
    const msgs = lint('http.host eq "a" and (http.host eq "b" or http.host eq "c")', 'illogical-condition');
    // outer `and` pairs `http.host eq "a"` with a Group, not a sibling eq — no flag
    expect(msgs).toHaveLength(0);
  });

  it('works with C-like operators', () => {
    const msgs = lint('http.host == "a" && http.host == "b"', 'illogical-condition');
    expect(msgs).toHaveLength(1);
  });

  it('skips when LHS is a function call', () => {
    expect(lint('lower(http.host) eq "a" and lower(http.host) eq "b"', 'illogical-condition')).toHaveLength(0);
  });
});

describe('duplicate-list-entries', () => {
  it('flags duplicate IP literals', () => {
    const msgs = lint('ip.src in {1.2.3.4 1.2.3.4 5.6.7.8}', 'duplicate-list-entries');
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toContain('1.2.3.4');
  });

  it('flags duplicate string literals', () => {
    const msgs = lint('http.host in {"a.com" "b.com" "a.com"}', 'duplicate-list-entries');
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toContain('"a.com"');
  });

  it('flags duplicate integer literals', () => {
    const msgs = lint('ip.src.asnum in {100 200 100}', 'duplicate-list-entries');
    expect(msgs).toHaveLength(1);
  });

  it('does not flag unique values', () => {
    expect(lint('ip.src in {1.2.3.4 5.6.7.8}', 'duplicate-list-entries')).toHaveLength(0);
  });

  it('does not flag single-element list', () => {
    expect(lint('ip.src in {1.2.3.4}', 'duplicate-list-entries')).toHaveLength(0);
  });

  it('does not flag empty list (covered by empty-in-list)', () => {
    expect(lint('ip.src in {}', 'duplicate-list-entries')).toHaveLength(0);
  });

  it('summarizes multiple distinct duplicates', () => {
    const msgs = lint('ip.src in {1.1.1.1 1.1.1.1 2.2.2.2 2.2.2.2}', 'duplicate-list-entries');
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toContain('1.1.1.1');
    expect(msgs[0]).toContain('2.2.2.2');
  });
});

describe('negated-comparison', () => {
  it('flags not X eq Y', () => {
    expect(lint('not http.host eq "a.com"', 'negated-comparison')).toHaveLength(1);
  });

  it('flags not X ne Y', () => {
    expect(lint('not http.host ne "a.com"', 'negated-comparison')).toHaveLength(1);
  });

  it('flags not (X eq Y) with group', () => {
    expect(lint('not (http.host eq "a.com")', 'negated-comparison')).toHaveLength(1);
  });

  it('does not flag not (A or B) — De Morgan territory', () => {
    expect(lint('not (http.host eq "a" or http.host eq "b")', 'negated-comparison')).toHaveLength(0);
  });

  it('does not flag X ne Y (already correct)', () => {
    expect(lint('http.host ne "a.com"', 'negated-comparison')).toHaveLength(0);
  });

  it('skips function-call LHS (no clean inverse)', () => {
    expect(lint('not lower(http.host) eq "a.com"', 'negated-comparison')).toHaveLength(0);
  });

  it('skips any(field[*] eq value) idioms', () => {
    expect(lint('not any(http.request.headers["x-foo"][*] eq "bar")', 'negated-comparison')).toHaveLength(0);
  });

  it('suggested rewrite preserves field and value', () => {
    const msgs = lint('not ip.src.asnum eq 15169', 'negated-comparison');
    expect(msgs[0]).toContain('ip.src.asnum ne 15169');
  });
});

describe('negated-comparison auto-fix', () => {
  it('fixes not X eq Y to X ne Y', () => {
    expect(fixExpression('not http.host eq "a.com"').expression).toBe('(http.host ne "a.com")');
  });

  it('fixes not X ne Y to X eq Y', () => {
    expect(fixExpression('not http.host ne "a.com"').expression).toBe('(http.host eq "a.com")');
  });

  it('cascades through De Morgan', () => {
    expect(fixExpression('not (http.host eq "a" or http.host eq "b")').expression)
      .toBe('(http.host ne "a" and http.host ne "b")');
  });

  it('does not rewrite function-call LHS', () => {
    const result = fixExpression('not lower(http.host) eq "a.com"').expression;
    // The fixer still wraps in parens for Builder compat but keeps "not ... eq"
    expect(result).toContain('not lower(http.host) eq "a.com"');
  });
});

describe('value-domain: http.request.method', () => {
  it('flags lowercase method', () => {
    expect(lint('http.request.method eq "get"', 'value-domain-method')).toHaveLength(1);
  });

  it('flags mixed-case method', () => {
    expect(lint('http.request.method eq "Get"', 'value-domain-method')).toHaveLength(1);
  });

  it('does not flag uppercase method', () => {
    expect(lint('http.request.method eq "GET"', 'value-domain-method')).toHaveLength(0);
  });

  it('flags in-list with lowercase', () => {
    expect(lint('http.request.method in {"GET" "post"}', 'value-domain-method')).toHaveLength(1);
  });
});

describe('value-domain: ip.src.country', () => {
  it('flags lowercase country code', () => {
    expect(lint('ip.src.country eq "us"', 'value-domain-country')).toHaveLength(1);
  });

  it('flags wrong-length country code', () => {
    expect(lint('ip.src.country eq "USA"', 'value-domain-country')).toHaveLength(1);
  });

  it('accepts valid ISO-3166 code', () => {
    expect(lint('ip.src.country eq "US"', 'value-domain-country')).toHaveLength(0);
  });

  it('accepts Tor pseudo-country T1', () => {
    expect(lint('ip.src.country eq "T1"', 'value-domain-country')).toHaveLength(0);
  });

  it('accepts unknown XX', () => {
    expect(lint('ip.src.country eq "XX"', 'value-domain-country')).toHaveLength(0);
  });

  it('flags each bad element in a list', () => {
    const msgs = lint('ip.src.country in {"US" "gb" "FR"}', 'value-domain-country');
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toContain('"gb"');
  });
});

describe('value-domain: ip.src.continent', () => {
  it('flags invalid continent code', () => {
    expect(lint('ip.src.continent eq "US"', 'value-domain-continent')).toHaveLength(1);
  });

  it('flags lowercase continent', () => {
    expect(lint('ip.src.continent eq "eu"', 'value-domain-continent')).toHaveLength(1);
  });

  it('accepts all valid continents', () => {
    for (const c of ['AF', 'AN', 'AS', 'EU', 'NA', 'OC', 'SA', 'T1']) {
      expect(lint(`ip.src.continent eq "${c}"`, 'value-domain-continent')).toHaveLength(0);
    }
  });
});

describe('value-domain: http.request.uri.path', () => {
  it('flags path without leading slash', () => {
    expect(lint('http.request.uri.path eq "admin"', 'value-domain-path')).toHaveLength(1);
  });

  it('accepts path with leading slash', () => {
    expect(lint('http.request.uri.path eq "/admin"', 'value-domain-path')).toHaveLength(0);
  });

  it('flags regex-shaped literal (^/api.*) as regex-as-literal mistake', () => {
    expect(lint('http.request.uri.path ne "^/api.*"', 'value-domain-path-regex')).toHaveLength(1);
  });

  it('flags literal ending in $ as regex-as-literal', () => {
    expect(lint('http.request.uri.path eq ".*.htm$"', 'value-domain-path-regex')).toHaveLength(1);
  });

  it('does not flag raw string used with `matches`', () => {
    expect(lint('http.request.uri.path matches r"^/api.*"', 'value-domain-path-regex')).toHaveLength(0);
  });

  it('does not flag raw string used with eq', () => {
    expect(lint('http.request.uri.path eq r"^/api.*"', 'value-domain-path-regex')).toHaveLength(0);
  });

  it('flags each in-list element that does not start with /', () => {
    const msgs = lint('http.request.uri.path in {"/admin" "login"}', 'value-domain-path');
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toContain('"login"');
  });

  it('does not flag on `matches` operator with plain string', () => {
    expect(lint('http.request.uri.path matches "^/api.*"', 'value-domain-path-regex')).toHaveLength(0);
  });
});

describe('value-domain: ports', () => {
  it('flags port above 65535', () => {
    expect(lint('cf.edge.server_port eq 99999', 'value-domain-port')).toHaveLength(1);
  });

  it('accepts port in valid range', () => {
    expect(lint('cf.edge.server_port eq 443', 'value-domain-port')).toHaveLength(0);
  });
});
