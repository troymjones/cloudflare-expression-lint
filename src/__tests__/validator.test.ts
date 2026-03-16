import { describe, it, expect } from 'vitest';
import { validate } from '../validator.js';
import type { ValidationContext, Diagnostic } from '../types.js';

/** Helper: validate and return just the diagnostic codes */
function codes(expr: string, ctx?: Partial<ValidationContext>): string[] {
  const result = validate(expr, {
    expressionType: 'filter',
    ...ctx,
  });
  return result.diagnostics.map(d => d.code);
}

/** Helper: validate and return diagnostics */
function diags(expr: string, ctx?: Partial<ValidationContext>): Diagnostic[] {
  return validate(expr, {
    expressionType: 'filter',
    ...ctx,
  }).diagnostics;
}

/** Helper: check expression is valid (no errors) */
function isValid(expr: string, ctx?: Partial<ValidationContext>): boolean {
  return validate(expr, {
    expressionType: 'filter',
    ...ctx,
  }).valid;
}

describe('Validator', () => {
  // ── Valid Expressions (should produce no errors) ────────────────────

  describe('valid filter expressions', () => {
    const validExpressions = [
      'true',
      'false',
      'ssl',
      'not ssl',
      '(http.host eq "example.com")',
      'http.request.uri.path eq "/admin"',
      'http.request.method ne "GET"',
      'cf.bot_management.score gt 30',
      'cf.bot_management.score lt 10',
      'cf.waf.score ge 1',
      'http.host contains "example.com"',
      'http.request.uri.path matches "^/api/"',
      'http.host wildcard "*.example.com"',
      'ip.src.country in {"US" "JP" "DE"}',
      'not ip.src.country in {"US"}',
      'ip.src in $allow_ips_auto_merged',
      '(ip.src in $cf.malware) or (ip.src in $cf.botnetcc)',
      'http.host eq "a.com" and http.request.method eq "POST"',
      'http.host eq "a.com" or http.host eq "b.com"',
      'cf.bot_management.verified_bot and not http.user_agent contains "Amazonbot"',
      'starts_with(http.request.uri.path, "/admin/")',
      'ends_with(http.request.uri.path, ".php")',
      'len(http.request.uri.query) gt 0',
      'lower(http.host) eq "test.com"',
      'lower(http.request.uri.path) contains "/wp-login.php"',
      '(http.host == "secure.example.com" || http.host == "api.qa.example.net") && http.request.method == "POST"',
      'url_decode(http.request.body.form["authType"][0]) == "pw"',
      'any(lower(http.request.headers.names[*])[*] eq "x-custom-header")',
      'cf.zone.plan eq "ENT"',
      'cf.zone.name eq "example.com"',
      'http.request.full_uri wildcard "*example.com/*"',
      'cf.threat_score gt 10',
      'cf.tls_client_auth.cert_verified',
      'http.request.body.mime eq "application/json"',
      'raw.http.request.uri.path eq "/original"',
    ];

    for (const expr of validExpressions) {
      it(`accepts: ${expr.substring(0, 80)}${expr.length > 80 ? '...' : ''}`, () => {
        expect(isValid(expr)).toBe(true);
      });
    }
  });

  // ── Deprecated Field Warnings ──────────────────────────────────────

  describe('deprecated field warnings', () => {
    it('warns on ip.geoip.country', () => {
      const diagnostics = diags('ip.geoip.country eq "US"');
      expect(diagnostics.some(d => d.code === 'deprecated-field')).toBe(true);
      expect(diagnostics.some(d => d.message.includes('ip.src.country'))).toBe(true);
    });

    it('warns on ip.geoip.asnum', () => {
      const diagnostics = diags('ip.geoip.asnum eq 36666');
      expect(diagnostics.some(d => d.code === 'deprecated-field')).toBe(true);
      expect(diagnostics.some(d => d.message.includes('ip.src.asnum'))).toBe(true);
    });

    it('warns on ip.geoip.continent', () => {
      const diagnostics = diags('ip.geoip.continent eq "EU"');
      expect(diagnostics.some(d => d.code === 'deprecated-field')).toBe(true);
    });

    it('deprecated fields are still valid (warnings, not errors)', () => {
      expect(isValid('ip.geoip.country eq "US"')).toBe(true);
    });

    it('multiple deprecated fields produce multiple warnings', () => {
      const diagnostics = diags(
        'ip.geoip.country eq "US" and ip.geoip.asnum eq 12345'
      );
      const deprecationWarnings = diagnostics.filter(d => d.code === 'deprecated-field');
      expect(deprecationWarnings.length).toBe(2);
    });
  });

  // ── Unknown Field Errors ───────────────────────────────────────────

  describe('unknown field errors', () => {
    it('errors on completely unknown field', () => {
      const diagnostics = diags('http.request.foo eq "bar"');
      expect(diagnostics.some(d => d.code === 'unknown-field')).toBe(true);
    });

    it('errors on misspelled field', () => {
      const diagnostics = diags('http.requets.uri.path eq "/"');
      expect(diagnostics.some(d => d.code === 'unknown-field')).toBe(true);
    });

    it('errors on non-existent cf field', () => {
      const diagnostics = diags('cf.nonexistent eq "test"');
      expect(diagnostics.some(d => d.code === 'unknown-field')).toBe(true);
    });

    it('does not error on map key access of known map field', () => {
      expect(isValid('http.request.headers["host"] eq "test.com"')).toBe(true);
    });
  });

  // ── Unknown Function Errors ────────────────────────────────────────

  describe('unknown function errors', () => {
    it('errors on unknown function', () => {
      const diagnostics = diags('nonexistent_func(http.host) eq "test"');
      expect(diagnostics.some(d => d.code === 'unknown-function')).toBe(true);
    });
  });

  // ── Phase-Specific Field Validation ────────────────────────────────

  describe('phase-specific field validation', () => {
    it('errors when using response field in request phase', () => {
      const diagnostics = diags('http.response.code eq 200', {
        phase: 'http_request_firewall_custom',
      });
      expect(diagnostics.some(d => d.code === 'field-not-in-phase')).toBe(true);
    });

    it('allows response field in response phase', () => {
      const result = validate('http.response.code eq 200', {
        expressionType: 'filter',
        phase: 'http_response_headers_transform',
      });
      expect(result.diagnostics.filter(d => d.severity === 'error').length).toBe(0);
    });

    it('allows request fields in any phase', () => {
      expect(isValid('http.host eq "test.com"', {
        phase: 'http_request_firewall_custom',
      })).toBe(true);
    });

    it('skips phase validation when phase is not specified', () => {
      // When no phase is given, we can't validate phase-specific restrictions
      expect(isValid('http.response.code eq 200')).toBe(true);
    });
  });

  // ── Function Context Validation ────────────────────────────────────

  describe('function context validation', () => {
    it('errors when using regex_replace in filter context', () => {
      const diagnostics = diags(
        'regex_replace(http.request.uri.path, "^/old/", "/new/") eq "/new/"'
      );
      expect(diagnostics.some(d => d.code === 'function-not-in-context')).toBe(true);
    });

    it('allows regex_replace in rewrite_url context', () => {
      const result = validate(
        'regex_replace(http.request.uri.path, "^/ads/", "/")',
        { expressionType: 'rewrite_url' }
      );
      expect(result.diagnostics.filter(d => d.severity === 'error').length).toBe(0);
    });

    it('allows lower() in filter context', () => {
      expect(isValid('lower(http.host) eq "test"')).toBe(true);
    });

    it('allows concat() in rewrite context', () => {
      const result = validate(
        'concat("/m", http.request.uri.path)',
        { expressionType: 'rewrite_url' }
      );
      expect(result.diagnostics.filter(d => d.severity === 'error').length).toBe(0);
    });

    it('allows starts_with in filter context', () => {
      expect(isValid('starts_with(http.request.uri.path, "/admin/")')).toBe(true);
    });

    it('errors when using to_string in filter context', () => {
      const diagnostics = diags('to_string(cf.bot_management.score) eq "30"');
      expect(diagnostics.some(d => d.code === 'function-not-in-context')).toBe(true);
    });

    it('allows to_string in rewrite_header context', () => {
      const result = validate(
        'to_string(cf.bot_management.score)',
        { expressionType: 'rewrite_header' }
      );
      expect(result.diagnostics.filter(d => d.severity === 'error').length).toBe(0);
    });
  });

  // ── Function Usage Limits ──────────────────────────────────────────

  describe('function usage limits', () => {
    it('errors when regex_replace is used more than once', () => {
      const diagnostics = diags(
        'concat(regex_replace(http.request.uri.path, "a", "b"), regex_replace(http.referer, "c", "d"))',
        { expressionType: 'rewrite_url' }
      );
      expect(diagnostics.some(d => d.code === 'function-max-exceeded')).toBe(true);
    });

    it('allows regex_replace used exactly once', () => {
      const result = validate(
        'regex_replace(http.request.uri.path, "^/ads/", "/")',
        { expressionType: 'rewrite_url' }
      );
      expect(result.diagnostics.filter(d => d.code === 'function-max-exceeded').length).toBe(0);
    });

    it('errors when wildcard_replace is used more than once', () => {
      const diagnostics = diags(
        'concat(wildcard_replace(http.request.uri.path, "/a/*", "/b/${1}"), wildcard_replace(http.referer, "/c/*", "/d/${1}"))',
        { expressionType: 'rewrite_url' }
      );
      expect(diagnostics.some(d => d.code === 'function-max-exceeded')).toBe(true);
    });
  });

  // ── Expression Length ──────────────────────────────────────────────

  describe('expression length validation', () => {
    it('warns when expression exceeds 4096 characters', () => {
      const longExpr = 'http.host eq "' + 'a'.repeat(4100) + '"';
      const diagnostics = diags(longExpr);
      expect(diagnostics.some(d => d.code === 'expression-too-long')).toBe(true);
    });

    it('does not warn for expressions under 4096 characters', () => {
      const normalExpr = 'http.host eq "test.com"';
      expect(codes(normalExpr)).not.toContain('expression-too-long');
    });
  });

  // ── Syntax Errors ──────────────────────────────────────────────────

  describe('syntax error handling', () => {
    it('reports parse errors gracefully', () => {
      const result = validate('http.host eq', {
        expressionType: 'filter',
      });
      expect(result.valid).toBe(false);
      expect(result.diagnostics.some(d => d.code === 'parse-error')).toBe(true);
    });

    it('reports unmatched parentheses', () => {
      const result = validate('(http.host eq "test"', {
        expressionType: 'filter',
      });
      expect(result.valid).toBe(false);
    });

    it('reports unterminated string', () => {
      const result = validate('http.host eq "unterminated', {
        expressionType: 'filter',
      });
      expect(result.valid).toBe(false);
    });
  });

  // ── Complex Real-World Expressions ──────────────────────────────────

  describe('complex real-world expressions', () => {
    it('validates sanctions compliance rule', () => {
      expect(isValid('(ip.geoip.country in {"CU" "IR" "KP" "SY" "RU" "BY"})')).toBe(true);
      // But should have deprecation warning
      const diagnostics = diags('(ip.geoip.country in {"CU" "IR" "KP" "SY" "RU" "BY"})');
      expect(diagnostics.some(d => d.code === 'deprecated-field')).toBe(true);
    });

    it('validates bot management verified_bot expression', () => {
      expect(isValid('(cf.bot_management.verified_bot and not http.user_agent contains "Amazonbot")')).toBe(true);
    });

    it('validates WAF score expression', () => {
      expect(isValid('(cf.waf.score gt 40)')).toBe(true);
    });

    it('validates complex compound expression with named lists', () => {
      expect(isValid(
        '((http.request.uri.path contains "/private/") or (http.request.uri.path matches "^/.*private;.*")) and (not ip.src in $allow_ips_auto_merged)'
      )).toBe(true);
    });

    it('validates rewrite expression with regex_replace', () => {
      const result = validate(
        'regex_replace(http.request.uri.path, "^/ads/", "/")',
        { expressionType: 'rewrite_url' }
      );
      expect(result.valid).toBe(true);
    });

    it('validates concat rewrite expression', () => {
      const result = validate(
        'concat("/m", http.request.uri.path)',
        { expressionType: 'rewrite_url' }
      );
      expect(result.valid).toBe(true);
    });

    it('validates complex rewrite with concat+regex_replace', () => {
      const result = validate(
        'concat(regex_replace(http.referer, ".*(/portal/[a-zA-Z-]+).*", "${1}"), http.request.uri.path)',
        { expressionType: 'rewrite_url' }
      );
      expect(result.valid).toBe(true);
    });

    it('validates sitemap rewrite with concat+substring+map access', () => {
      const result = validate(
        'concat("/", http.request.headers["host"][0], substring(http.request.uri.path, 8))',
        { expressionType: 'rewrite_url' }
      );
      expect(result.valid).toBe(true);
    });

    it('validates C-like syntax exposed credential check', () => {
      expect(isValid(
        '(http.host == "secure.example.com" || http.host == "api.qa.example.net") && http.request.uri == "/auth" && http.request.method == "POST" && url_decode(http.request.body.form["authType"][0]) == "pw"'
      )).toBe(true);
    });

    it('validates expression with any() and array unpack', () => {
      expect(isValid(
        'http.request.uri.path eq "/graphql" and http.request.method eq "POST" and any(lower(http.request.headers.names[*])[*] eq "x-custom-header")'
      )).toBe(true);
    });

    it('validates origin rules expression', () => {
      expect(isValid(
        '(http.host eq "media.shop.example.org")'
      )).toBe(true);
    });

    it('validates expression with multiple or-chains', () => {
      expect(isValid(
        '(http.user_agent contains "Java") or (http.user_agent contains "ScraperBot") or (http.user_agent contains "Go-http") or (http.user_agent contains "Fuzz")'
      )).toBe(true);
    });

    it('validates transform header "true" expression', () => {
      expect(isValid('true')).toBe(true);
    });

    it('validates ASN-based expression', () => {
      expect(isValid(
        '((ip.geoip.asnum eq 14061) or (ip.geoip.asnum eq 203020) or (ip.geoip.asnum eq 55286))'
      )).toBe(true);
    });

    it('validates expression with lower() in operator', () => {
      expect(isValid(
        'lower(http.request.uri.path) in {"/m" "/m/"}'
      )).toBe(true);
    });
  });
});
