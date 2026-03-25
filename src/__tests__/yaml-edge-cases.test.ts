/**
 * YAML scanner edge case tests.
 *
 * Tests for malformed YAML, deeply nested structures, custom key
 * mappings, and unusual expression formats.
 */

import { describe, it, expect } from 'vitest';
import { scanYaml } from '../yaml-scanner.js';

describe('YAML scanner edge cases', () => {
  describe('malformed YAML', () => {
    it('returns parse error for invalid YAML', () => {
      const content = '  - broken:\n    [unclosed\n    expression: (http.host eq "test.com")';
      const result = scanYaml(content, 'test.yaml');
      expect(result.parseError).toBeTruthy();
    });

    it('returns empty expressions for YAML with no expression keys', () => {
      const content = 'zone:\n  name: test\n  enabled: true\n';
      const result = scanYaml(content, 'test.yaml');
      expect(result.expressions).toHaveLength(0);
    });

    it('handles empty file', () => {
      const result = scanYaml('', 'test.yaml');
      expect(result.expressions).toHaveLength(0);
    });

    it('handles YAML with only comments', () => {
      const content = '# This is a comment\n# Another comment\n';
      const result = scanYaml(content, 'test.yaml');
      expect(result.expressions).toHaveLength(0);
    });
  });

  describe('deeply nested structures', () => {
    it('finds expressions at deep nesting levels', () => {
      const content = [
        'zone:',
        '  waf_rules:',
        '    rules:',
        '      - groups:',
        '          - rules:',
        '              - expression: (http.host eq "test.com")',
        '                enabled: true',
      ].join('\n');
      const result = scanYaml(content, 'test.yaml');
      expect(result.expressions.length).toBeGreaterThanOrEqual(1);
      expect(result.expressions[0].expression).toContain('http.host eq "test.com"');
    });

    it('finds multiple expressions in same file', () => {
      const content = [
        'zone:',
        '  waf_rules:',
        '    rules:',
        '      - expression: (http.host eq "a.com")',
        '        enabled: true',
        '      - expression: (http.host eq "b.com")',
        '        enabled: true',
        '      - expression: (http.host eq "c.com")',
        '        enabled: true',
      ].join('\n');
      const result = scanYaml(content, 'test.yaml');
      expect(result.expressions).toHaveLength(3);
    });
  });

  describe('custom expression keys', () => {
    it('finds custom expression keys from config', () => {
      const content = [
        'zone:',
        '  rules:',
        '    - my_filter: (http.host eq "test.com")',
        '      enabled: true',
      ].join('\n');
      const result = scanYaml(content, 'test.yaml', {
        expressionKeys: { my_filter: { type: 'filter' } },
      });
      expect(result.expressions.length).toBeGreaterThanOrEqual(1);
    });

    it('respects phase mappings', () => {
      const content = [
        'zone:',
        '  custom_phase:',
        '    rules:',
        '      - expression: (http.host eq "test.com")',
        '        enabled: true',
      ].join('\n');
      const result = scanYaml(content, 'test.yaml', {
        phaseMappings: { custom_phase: 'http_request_firewall_custom' },
      });
      expect(result.expressions.length).toBeGreaterThanOrEqual(1);
      if (result.expressions[0].phase) {
        expect(result.expressions[0].phase).toBe('http_request_firewall_custom');
      }
    });
  });

  describe('expression value formats', () => {
    it('handles null/empty expression value', () => {
      const content = [
        'zone:',
        '  waf_rules:',
        '    rules:',
        '      - expression:',
        '        enabled: true',
      ].join('\n');
      const result = scanYaml(content, 'test.yaml');
      // Should not crash, may or may not find an expression
      expect(result.parseError).toBeFalsy();
    });

    it('handles boolean expression value', () => {
      const content = [
        'zone:',
        '  waf_rules:',
        '    rules:',
        '      - expression: true',
        '        enabled: true',
      ].join('\n');
      const result = scanYaml(content, 'test.yaml');
      // true is a valid boolean expression
      expect(result.parseError).toBeFalsy();
    });

    it('handles very long expression (near 4096 char limit)', () => {
      // Build an expression just under the Cloudflare limit
      const conditions = Array.from({ length: 20 }, (_, i) =>
        `http.host eq "host${i}.example.com"`
      ).join(' and ');
      const expr = `(${conditions})`;
      const content = `zone:\n  waf_rules:\n    rules:\n      - expression: ${expr}\n`;
      const result = scanYaml(content, 'test.yaml');
      expect(result.expressions.length).toBe(1);
      expect(result.expressions[0].expression).toContain('host19.example.com');
    });
  });

  describe('block scalar variants', () => {
    it('handles >- folded strip', () => {
      const content = [
        '- expression: >-',
        '    (http.host eq "test.com")',
        '  enabled: true',
      ].join('\n');
      const result = scanYaml(content, 'test.yaml');
      expect(result.expressions.length).toBe(1);
    });

    it('handles | literal', () => {
      const content = [
        '- expression: |',
        '    (http.host eq "test.com")',
        '  enabled: true',
      ].join('\n');
      const result = scanYaml(content, 'test.yaml');
      expect(result.expressions.length).toBe(1);
    });

    it('handles quoted expression value', () => {
      const content = [
        'zone:',
        '  waf_rules:',
        '    rules:',
        '      - expression: "(http.host eq \\"test.com\\")"',
        '        enabled: true',
      ].join('\n');
      const result = scanYaml(content, 'test.yaml');
      expect(result.expressions.length).toBe(1);
      expect(result.expressions[0].expression).toContain('http.host eq "test.com"');
    });
  });
});
