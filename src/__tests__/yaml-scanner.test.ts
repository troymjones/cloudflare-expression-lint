import { describe, it, expect } from 'vitest';
import { scanYaml } from '../yaml-scanner.js';

describe('YAML Scanner', () => {
  // ── Expression Detection ───────────────────────────────────────────

  describe('expression detection', () => {
    it('detects filter expressions in YAML', () => {
      const yaml = `
configuration_rules:
  - description: Test rule
    expression: (http.host eq "test.com")
    security_level: medium
`;
      const result = scanYaml(yaml, 'test.yaml');
      expect(result.expressions.length).toBe(1);
      expect(result.expressions[0].expressionType).toBe('filter');
      expect(result.expressions[0].expression).toBe('(http.host eq "test.com")');
    });

    it('detects rewrite expressions', () => {
      const yaml = `
transform_url_rewrite_rules:
  - description: Rewrite ads path
    expression: (starts_with(http.request.uri.path, "/ads/"))
    rewrite_expression: 'regex_replace(http.request.uri.path, "^/ads/", "/")'
`;
      const result = scanYaml(yaml, 'test.yaml');
      // Should find both the filter expression and the rewrite expression
      expect(result.expressions.length).toBe(2);
      const rewrite = result.expressions.find(e => e.expressionType === 'rewrite_url');
      expect(rewrite).toBeDefined();
      expect(rewrite!.phase).toBe('http_request_transform');
    });

    it('detects redirect expressions', () => {
      const yaml = `
single_redirects:
  - description: Redirect to dashboard
    source_url_expression: (http.host contains "conference.example.org")
    target_url_value: https://www.shop.example.org/dashboard/
`;
      const result = scanYaml(yaml, 'test.yaml');
      expect(result.expressions.length).toBeGreaterThanOrEqual(1);
    });

    it('detects "true" as a valid expression', () => {
      const yaml = `
configuration_rules:
  - description: Apply to all
    expression: "true"
    cache: false
`;
      const result = scanYaml(yaml, 'test.yaml');
      expect(result.expressions.length).toBe(1);
      expect(result.expressions[0].result.valid).toBe(true);
    });
  });

  // ── Phase Inference ────────────────────────────────────────────────

  describe('phase inference', () => {
    it('infers http_request_firewall_custom for waf_rules', () => {
      const yaml = `
waf_rules:
  - name: Test ruleset
    rules:
      - description: Block bad IPs
        expression: (ip.src in $bad_ips)
        action: block
`;
      const result = scanYaml(yaml, 'test.yaml');
      const expr = result.expressions.find(e => e.expression.includes('bad_ips'));
      expect(expr?.phase).toBe('http_request_firewall_custom');
    });

    it('infers http_request_cache_settings for cache_rules', () => {
      const yaml = `
cache_rules:
  - rules:
    - description: Cache everything
      expression: (http.host eq "cdn.example.com")
      cache: true
`;
      const result = scanYaml(yaml, 'test.yaml');
      const expr = result.expressions.find(e => e.expression.includes('cdn'));
      expect(expr?.phase).toBe('http_request_cache_settings');
    });

    it('infers http_request_late_transform for transform_request_header_rules', () => {
      const yaml = `
transform_request_header_rules:
  - name: Default headers
    rules:
      - description: Set header
        expression: "true"
        headers:
          - name: X-Custom
            operation: set
            static: "value"
`;
      const result = scanYaml(yaml, 'test.yaml');
      expect(result.expressions[0].phase).toBe('http_request_late_transform');
    });
  });

  // ── Validation Integration ─────────────────────────────────────────

  describe('validation integration', () => {
    it('flags deprecated fields in YAML expressions', () => {
      const yaml = `
waf_rules:
  - name: Test
    rules:
      - description: Country block
        expression: (ip.geoip.country eq "RU")
        action: block
`;
      const result = scanYaml(yaml, 'test.yaml');
      const expr = result.expressions.find(e => e.expression.includes('geoip'));
      expect(expr?.result.diagnostics.some(d => d.code === 'deprecated-field')).toBe(true);
    });

    it('flags unknown fields in YAML expressions', () => {
      const yaml = `
configuration_rules:
  - description: Bad field
    expression: (http.request.nonexistent eq "test")
`;
      const result = scanYaml(yaml, 'test.yaml');
      expect(result.expressions[0].result.valid).toBe(false);
      expect(result.expressions[0].result.diagnostics.some(d => d.code === 'unknown-field')).toBe(true);
    });

    it('validates rewrite expressions in rewrite context', () => {
      const yaml = `
transform_url_rewrite_rules:
  - description: Rewrite
    expression: (starts_with(http.request.uri.path, "/ads/"))
    rewrite_expression: 'regex_replace(http.request.uri.path, "^/ads/", "/")'
`;
      const result = scanYaml(yaml, 'test.yaml');
      const rewrite = result.expressions.find(e => e.expressionType === 'rewrite_url');
      expect(rewrite?.result.valid).toBe(true);
    });

    it('handles YAML parse errors gracefully', () => {
      const yaml = `
invalid: yaml: [broken
`;
      const result = scanYaml(yaml, 'test.yaml');
      expect(result.parseError).toBeDefined();
    });

    it('handles empty YAML files', () => {
      const result = scanYaml('', 'empty.yaml');
      expect(result.expressions.length).toBe(0);
    });
  });

  // ── Real-World YAML Structures ─────────────────────────────────────

  describe('real-world YAML structures', () => {
    it('scans standard zone config', () => {
      const yaml = `
zone:
  type: full
configuration_rules:
  - description: Apple Deep Linking File
    expression: (http.request.uri.path contains "apple-app-site-association")
    security_level: essentially_off
  - description: Dashboard
    expression: (starts_with(http.request.uri.path, "/dashboard/"))
    bic: false
`;
      const result = scanYaml(yaml, 'shop.example.at.yaml');
      expect(result.expressions.length).toBe(2);
      expect(result.expressions.every(e => e.result.valid)).toBe(true);
    });

    it('scans standard WAF account config', () => {
      const yaml = `
account:
  waf_rules:
    - name: Legal Compliance Ruleset
      description: Rules mandated by compliance team
      expression: (cf.zone.plan eq "ENT")
      enabled: true
      rules:
        - description: Country blocks
          action: block
          expression: (ip.geoip.country in {"CU" "IR" "KP" "SY" "RU" "BY"})
          identifier: RULE-001
          enabled: true
`;
      const result = scanYaml(yaml, 'account.yaml');
      expect(result.expressions.length).toBe(2);
      // The ip.geoip.country expression should trigger deprecation warning
      const countryExpr = result.expressions.find(e => e.expression.includes('geoip'));
      expect(countryExpr?.result.valid).toBe(true); // valid but with warning
      expect(countryExpr?.result.diagnostics.some(d => d.code === 'deprecated-field')).toBe(true);
    });

    it('scans config with URL rewrite rules', () => {
      const yaml = `
transform_url_rewrite_rules:
  - description: strip-ads-prefix
    expression: (starts_with(http.request.uri.path, "/ads/"))
    rewrite_expression: 'regex_replace(http.request.uri.path, "^/ads/", "/")'
  - description: strip-webhooks-prefix
    expression: (starts_with(http.request.uri.path, "/webhooks/incoming/"))
    rewrite_expression: 'regex_replace(http.request.uri.path, "^/webhooks/incoming/", "/")'
  - description: api-versioned-rewrite
    expression: (http.request.uri.path eq "/graphql" and http.request.method eq "POST" and any(lower(http.request.headers.names[*])[*] eq "x-custom-header"))
    rewrite_value: /v2/graphql
`;
      const result = scanYaml(yaml, 'api.example.com.yaml');
      expect(result.expressions.length).toBe(5); // 3 filter + 2 rewrite
      const errors = result.expressions.filter(e => !e.result.valid);
      expect(errors.length).toBe(0);
    });

    it('scans percentage rollout config', () => {
      const yaml = `
expression: (ip.src.country in {"DK" "EG" "GH" "GT" "HU" "ID" "IL" "KR" "LK" "MG" "NZ" "PA" "PE" "PK" "PL" "SA" "TW"})
include_country:
`;
      const result = scanYaml(yaml, '1.yaml');
      expect(result.expressions.length).toBe(1);
      expect(result.expressions[0].result.valid).toBe(true);
    });
  });
});
