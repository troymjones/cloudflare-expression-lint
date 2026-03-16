import { describe, it, expect } from 'vitest';
import { scanYaml, getDefaultExpressionKeys, getDefaultPhaseMappings } from '../yaml-scanner.js';
import type { ScannerOptions } from '../yaml-scanner.js';

describe('YAML Scanner', () => {
  // ── Expression Detection ───────────────────────────────────────────

  describe('expression detection', () => {
    it('detects filter expressions in YAML', () => {
      const yaml = `
rules:
  - description: Test rule
    expression: (http.host eq "test.com")
    security_level: medium
`;
      const result = scanYaml(yaml, 'test.yaml');
      expect(result.expressions.length).toBe(1);
      expect(result.expressions[0].expressionType).toBe('filter');
      expect(result.expressions[0].expression).toBe('(http.host eq "test.com")');
    });

    it('detects rewrite expressions with custom keys', () => {
      const yaml = `
http_request_transform:
  - description: Rewrite ads path
    expression: (starts_with(http.request.uri.path, "/ads/"))
    rewrite_expression: 'regex_replace(http.request.uri.path, "^/ads/", "/")'
`;
      const options: ScannerOptions = {
        expressionKeys: {
          'rewrite_expression': { type: 'rewrite_url', phaseHint: 'http_request_transform' },
        },
      };
      const result = scanYaml(yaml, 'test.yaml', options);
      expect(result.expressions.length).toBe(2);
      const rewrite = result.expressions.find(e => e.expressionType === 'rewrite_url');
      expect(rewrite).toBeDefined();
      expect(rewrite!.phase).toBe('http_request_transform');
    });

    it('detects redirect expressions with custom keys', () => {
      const yaml = `
single_redirects:
  - description: Redirect to dashboard
    source_url_expression: (http.host contains "conference.example.org")
`;
      const options: ScannerOptions = {
        expressionKeys: {
          'source_url_expression': { type: 'filter', phaseHint: 'http_request_dynamic_redirect' },
        },
      };
      const result = scanYaml(yaml, 'test.yaml', options);
      expect(result.expressions.length).toBeGreaterThanOrEqual(1);
    });

    it('detects "true" as a valid expression', () => {
      const yaml = `
rules:
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
    it('infers phase from direct Cloudflare phase name as YAML key', () => {
      const yaml = `
http_request_firewall_custom:
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
  - description: Cache everything
    expression: (http.host eq "cdn.example.com")
    cache: true
`;
      const result = scanYaml(yaml, 'test.yaml');
      const expr = result.expressions.find(e => e.expression.includes('cdn'));
      expect(expr?.phase).toBe('http_request_cache_settings');
    });

    it('infers phase from custom mapping', () => {
      const yaml = `
my_waf_rules:
  - description: Set header
    expression: "true"
`;
      const options: ScannerOptions = {
        phaseMappings: {
          'my_waf_rules': 'http_request_firewall_custom',
        },
      };
      const result = scanYaml(yaml, 'test.yaml', options);
      expect(result.expressions[0].phase).toBe('http_request_firewall_custom');
    });

    it('has no phase when YAML key is not mapped', () => {
      const yaml = `
unmapped_key:
  - description: No phase
    expression: (http.host eq "test.com")
`;
      const result = scanYaml(yaml, 'test.yaml');
      expect(result.expressions[0].phase).toBeUndefined();
    });
  });

  // ── Custom Mappings ────────────────────────────────────────────────

  describe('custom scanner options', () => {
    it('merges custom expression keys with defaults', () => {
      const yaml = `
rules:
  - my_filter: (http.host eq "test.com")
    expression: (http.host eq "other.com")
`;
      const options: ScannerOptions = {
        expressionKeys: {
          'my_filter': { type: 'filter' },
        },
      };
      const result = scanYaml(yaml, 'test.yaml', options);
      // Should detect both: the custom key and the default 'expression' key
      expect(result.expressions.length).toBe(2);
    });

    it('replaces default expression keys when replaceExpressionKeys is true', () => {
      const yaml = `
rules:
  - my_filter: (http.host eq "test.com")
    expression: (http.host eq "other.com")
`;
      const options: ScannerOptions = {
        expressionKeys: {
          'my_filter': { type: 'filter' },
        },
        replaceExpressionKeys: true,
      };
      const result = scanYaml(yaml, 'test.yaml', options);
      // Should only detect custom key, not 'expression'
      expect(result.expressions.length).toBe(1);
      expect(result.expressions[0].expression).toBe('(http.host eq "test.com")');
    });

    it('merges custom phase mappings with defaults', () => {
      const yaml = `
firewall_rules:
  - expression: (http.host eq "test.com")
`;
      const options: ScannerOptions = {
        phaseMappings: {
          'firewall_rules': 'http_request_firewall_custom',
        },
      };
      const result = scanYaml(yaml, 'test.yaml', options);
      expect(result.expressions[0].phase).toBe('http_request_firewall_custom');
    });

    it('replaces default phase mappings when replacePhaseMappings is true', () => {
      const yaml = `
cache_rules:
  - expression: (http.host eq "test.com")
`;
      const options: ScannerOptions = {
        phaseMappings: {
          'my_cache': 'http_request_cache_settings',
        },
        replacePhaseMappings: true,
      };
      const result = scanYaml(yaml, 'test.yaml', options);
      // cache_rules should NOT be recognized since we replaced defaults
      expect(result.expressions[0].phase).toBeUndefined();
    });

    it('exposes default expression keys for inspection', () => {
      const keys = getDefaultExpressionKeys();
      expect(keys).toHaveProperty('expression');
      // Only 'expression' is a built-in default; others are user-configurable
      expect(Object.keys(keys).length).toBe(1);
    });

    it('exposes default phase mappings for inspection', () => {
      const mappings = getDefaultPhaseMappings();
      expect(mappings).toHaveProperty('cache_rules');
      expect(mappings).toHaveProperty('http_request_firewall_custom');
    });
  });

  // ── Validation Integration ─────────────────────────────────────────

  describe('validation integration', () => {
    it('flags deprecated fields in YAML expressions', () => {
      const yaml = `
http_request_firewall_custom:
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
rules:
  - description: Bad field
    expression: (http.request.nonexistent eq "test")
`;
      const result = scanYaml(yaml, 'test.yaml');
      expect(result.expressions[0].result.valid).toBe(false);
      expect(result.expressions[0].result.diagnostics.some(d => d.code === 'unknown-field')).toBe(true);
    });

    it('validates rewrite expressions in rewrite context', () => {
      const yaml = `
http_request_transform:
  - description: Rewrite
    expression: (starts_with(http.request.uri.path, "/ads/"))
    rewrite_expression: 'regex_replace(http.request.uri.path, "^/ads/", "/")'
`;
      const options: ScannerOptions = {
        expressionKeys: {
          'rewrite_expression': { type: 'rewrite_url', phaseHint: 'http_request_transform' },
        },
      };
      const result = scanYaml(yaml, 'test.yaml', options);
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
    it('scans zone config with custom phase mappings', () => {
      const yaml = `
zone:
  type: full
config_rules:
  - description: Apple Deep Linking File
    expression: (http.request.uri.path contains "apple-app-site-association")
    security_level: essentially_off
  - description: Dashboard
    expression: (starts_with(http.request.uri.path, "/dashboard/"))
    bic: false
`;
      const options: ScannerOptions = {
        phaseMappings: { 'config_rules': 'http_config_settings' },
      };
      const result = scanYaml(yaml, 'zone.yaml', options);
      expect(result.expressions.length).toBe(2);
      expect(result.expressions.every(e => e.result.valid)).toBe(true);
      expect(result.expressions[0].phase).toBe('http_config_settings');
    });

    it('scans WAF account config with custom mappings', () => {
      const yaml = `
account:
  http_request_firewall_custom:
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
      const countryExpr = result.expressions.find(e => e.expression.includes('geoip'));
      expect(countryExpr?.result.valid).toBe(true);
      expect(countryExpr?.result.diagnostics.some(d => d.code === 'deprecated-field')).toBe(true);
    });

    it('scans config with URL rewrite rules', () => {
      const yaml = `
http_request_transform:
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
      const options: ScannerOptions = {
        expressionKeys: {
          'rewrite_expression': { type: 'rewrite_url', phaseHint: 'http_request_transform' },
        },
      };
      const result = scanYaml(yaml, 'api.example.com.yaml', options);
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
