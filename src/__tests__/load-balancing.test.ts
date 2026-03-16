import { describe, it, expect } from 'vitest';
import { validate } from '../validator.js';
import { scanYaml } from '../yaml-scanner.js';
import type { ScannerOptions } from '../yaml-scanner.js';

describe('Load Balancing Custom Rules', () => {
  // ── Field Validation ───────────────────────────────────────────────

  describe('load balancing fields', () => {
    it('accepts http.request.uri.path in LB context', () => {
      const result = validate('http.request.uri.path matches "^/api/v2/"', {
        expressionType: 'filter',
        phase: 'load_balancing',
      });
      expect(result.valid).toBe(true);
    });

    it('accepts http.request.headers in LB context', () => {
      const result = validate('lower(http.request.headers["x-country-code"][0]) == "gb"', {
        expressionType: 'filter',
        phase: 'load_balancing',
      });
      expect(result.valid).toBe(true);
    });

    it('accepts http.request.method in LB context', () => {
      const result = validate('http.request.method eq "POST"', {
        expressionType: 'filter',
        phase: 'load_balancing',
      });
      expect(result.valid).toBe(true);
    });

    it('accepts ip.src in LB context', () => {
      const result = validate('ip.src in {10.0.0.0/8}', {
        expressionType: 'filter',
        phase: 'load_balancing',
      });
      expect(result.valid).toBe(true);
    });

    it('accepts not with in-list in LB context', () => {
      const result = validate(
        'not lower(http.request.headers["x-country-code"][0]) in {"gb" "us"}',
        { expressionType: 'filter', phase: 'load_balancing' }
      );
      expect(result.valid).toBe(true);
    });
  });

  // ── LB-Specific Fields ────────────────────────────────────────────

  describe('LB-specific fields', () => {
    it('accepts cf.load_balancer.name in LB phase', () => {
      const result = validate('cf.load_balancer.name eq "my-lb"', {
        expressionType: 'filter',
        phase: 'load_balancing',
      });
      expect(result.valid).toBe(true);
    });

    it('accepts cf.load_balancer.region in LB phase', () => {
      const result = validate('cf.load_balancer.region eq "WNAM"', {
        expressionType: 'filter',
        phase: 'load_balancing',
      });
      expect(result.valid).toBe(true);
    });

    it('rejects cf.load_balancer.name outside LB phase', () => {
      const result = validate('cf.load_balancer.name eq "my-lb"', {
        expressionType: 'filter',
        phase: 'http_request_firewall_custom',
      });
      expect(result.diagnostics.some(d => d.code === 'field-not-in-phase')).toBe(true);
    });
  });

  // ── DNS Fields (unproxied LB) ─────────────────────────────────────

  describe('DNS fields for unproxied load balancing', () => {
    it('accepts dns.qry.name in LB phase', () => {
      const result = validate('dns.qry.name eq "example.com"', {
        expressionType: 'filter',
        phase: 'load_balancing',
      });
      expect(result.valid).toBe(true);
    });

    it('accepts dns.qry.type in LB phase', () => {
      const result = validate('dns.qry.type eq 1', {
        expressionType: 'filter',
        phase: 'load_balancing',
      });
      expect(result.valid).toBe(true);
    });

    it('accepts dns.qry.name.len in LB phase', () => {
      const result = validate('dns.qry.name.len gt 0', {
        expressionType: 'filter',
        phase: 'load_balancing',
      });
      expect(result.valid).toBe(true);
    });

    it('accepts dns.rr.opt.client.addr in LB phase', () => {
      const result = validate('dns.rr.opt.client.addr eq "1.2.3.4"', {
        expressionType: 'filter',
        phase: 'load_balancing',
      });
      expect(result.valid).toBe(true);
    });

    it('rejects dns.qry.name outside LB phase', () => {
      const result = validate('dns.qry.name eq "example.com"', {
        expressionType: 'filter',
        phase: 'http_request_firewall_custom',
      });
      expect(result.diagnostics.some(d => d.code === 'field-not-in-phase')).toBe(true);
    });

    it('accepts dns fields without phase specified', () => {
      // When no phase is given, skip phase validation
      const result = validate('dns.qry.name eq "example.com"', {
        expressionType: 'filter',
      });
      expect(result.valid).toBe(true);
    });
  });

  // ── YAML Scanner Integration ───────────────────────────────────────

  describe('YAML scanner with LB config', () => {
    const options: ScannerOptions = {
      expressionKeys: {
        'condition': { type: 'filter' },
      },
      phaseMappings: {
        'custom_rules': 'load_balancing',
      },
    };

    it('detects condition expressions in LB custom rules', () => {
      const yaml = `
load_balancer:
  name: MyLB
  custom_rules:
    - name: Route API traffic
      condition: http.request.uri.path matches "^/api/v2/"
      pool: api-pool
`;
      const result = scanYaml(yaml, 'lb.yaml', options);
      expect(result.expressions.length).toBe(1);
      expect(result.expressions[0].expressionType).toBe('filter');
      expect(result.expressions[0].phase).toBe('load_balancing');
      expect(result.expressions[0].result.valid).toBe(true);
    });

    it('validates multiple LB custom rule conditions', () => {
      const yaml = `
load_balancer:
  custom_rules:
    - name: Messaging
      condition: http.request.uri.path matches "^/api/v2/messaging(/.*)?$"
      pool: messaging-pool
    - name: Applications
      condition: http.request.uri.path matches "^/api/v2/applications(/.*)?$"
      pool: applications-pool
    - name: Country routing
      condition: not lower(http.request.headers["x-country-code"][0]) in {"gb" "us"}
      pool: default-pool
`;
      const result = scanYaml(yaml, 'lb.yaml', options);
      expect(result.expressions.length).toBe(3);
      expect(result.expressions.every(e => e.result.valid)).toBe(true);
    });

    it('catches invalid field in LB expression', () => {
      const yaml = `
load_balancer:
  custom_rules:
    - name: Bad rule
      condition: http.request.nonexistent eq "test"
      pool: some-pool
`;
      const result = scanYaml(yaml, 'lb.yaml', options);
      expect(result.expressions[0].result.valid).toBe(false);
      expect(result.expressions[0].result.diagnostics.some(d => d.code === 'unknown-field')).toBe(true);
    });

    it('handles real-world LB config with regex patterns', () => {
      const yaml = `
load_balancer:
  custom_rules:
    - name: Billing routes
      condition: http.request.uri.path matches "^/(deleteCC|downloadTransactionPDF|graphql|metadata|validateDelete).*"
      pool: billing-pool
`;
      const result = scanYaml(yaml, 'billing.yaml', options);
      expect(result.expressions[0].result.valid).toBe(true);
    });
  });
});
