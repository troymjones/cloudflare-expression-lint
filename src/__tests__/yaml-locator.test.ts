import { describe, it, expect } from 'vitest';
import { findExpressionLocation } from '../yaml-locator.js';

describe('findExpressionLocation', () => {
  describe('inline values', () => {
    it('finds unquoted inline expression', () => {
      const content = '    expression: (http.host eq "test.com")\n    enabled: true\n';
      const loc = findExpressionLocation(content, '(http.host eq "test.com")');
      expect(loc).not.toBeNull();
      expect(loc!.key).toBe('expression:');
      expect(loc!.isBlockScalar).toBeUndefined();
    });

    it('finds single-quoted inline expression', () => {
      const content = "    expression: '(http.host eq \"test.com\")'\n    enabled: true\n";
      const loc = findExpressionLocation(content, '(http.host eq "test.com")');
      expect(loc).not.toBeNull();
    });

    it('finds double-quoted expression with escaped quotes', () => {
      const content = '    expression: "(http.host eq \\"secure.example.com\\")"\n    enabled: true\n';
      const loc = findExpressionLocation(content, '(http.host eq "secure.example.com")');
      expect(loc).not.toBeNull();
    });

    it('captures correct lineStart and lineEnd for inline', () => {
      const before = '    enabled: true\n';
      const line = '    expression: (http.host eq "test.com")\n';
      const after = '    action: block\n';
      const content = before + line + after;
      const loc = findExpressionLocation(content, '(http.host eq "test.com")');
      expect(loc!.lineStart).toBe(before.length);
      expect(loc!.lineEnd).toBe(before.length + line.length);
    });
  });

  describe('block scalars', () => {
    it('finds >- block scalar', () => {
      const content = [
        '    expression: >-',
        '      (http.host eq "test.com"',
        '      and http.request.method eq "POST")',
        '    enabled: true',
        '',
      ].join('\n');
      const loc = findExpressionLocation(content, '(http.host eq "test.com" and http.request.method eq "POST")');
      expect(loc).not.toBeNull();
      expect(loc!.isBlockScalar).toBe('>-');
    });

    it('finds | block scalar', () => {
      const content = [
        '    expression: |',
        '      (http.host eq "test.com"',
        '      and http.request.method eq "POST")',
        '    enabled: true',
        '',
      ].join('\n');
      const loc = findExpressionLocation(content, '(http.host eq "test.com" and http.request.method eq "POST")');
      expect(loc).not.toBeNull();
      expect(loc!.isBlockScalar).toBe('|');
    });

    it('finds |- block scalar', () => {
      const content = '    expression: |-\n      (http.host eq "test.com")\n    enabled: true\n';
      const loc = findExpressionLocation(content, '(http.host eq "test.com")');
      expect(loc).not.toBeNull();
      expect(loc!.isBlockScalar).toBe('|-');
    });

    it('does not include trailing blank lines in block scalar range', () => {
      const content = [
        '    expression: >-',
        '      (http.host eq "test.com")',
        '',
        '    enabled: true',
        '',
      ].join('\n');
      const loc = findExpressionLocation(content, '(http.host eq "test.com")');
      expect(loc).not.toBeNull();
      const after = content.substring(loc!.lineEnd);
      expect(after).toMatch(/^\n\s*enabled/);
    });
  });

  describe('plain multi-line values', () => {
    it('finds value wrapping across lines', () => {
      const content = [
        '      expression: (http.host eq "test.com" and http.user_agent',
        '        eq "SomeBot/1.0")',
        '      enabled: true',
        '',
      ].join('\n');
      const loc = findExpressionLocation(content, '(http.host eq "test.com" and http.user_agent eq "SomeBot/1.0")');
      expect(loc).not.toBeNull();
      expect(loc!.isBlockScalar).toBe('plain-multiline');
    });

    it('finds value starting on next line (empty key value)', () => {
      const content = [
        '        expression:',
        '          (http.host eq "test.com")',
        '          or (http.host eq "example.com")',
        '        enabled: true',
        '',
      ].join('\n');
      const loc = findExpressionLocation(content, '(http.host eq "test.com") or (http.host eq "example.com")');
      expect(loc).not.toBeNull();
      expect(loc!.isBlockScalar).toBe('plain-multiline');
    });
  });

  describe('CRLF line endings', () => {
    it('finds inline expression in CRLF file', () => {
      const content = '    expression: (http.host eq "test.com")\r\n    enabled: true\r\n';
      const loc = findExpressionLocation(content, '(http.host eq "test.com")');
      expect(loc).not.toBeNull();
    });

    it('finds block scalar in CRLF file', () => {
      const content = [
        '    expression: >-',
        '      (http.host eq "test.com")',
        '    enabled: true',
        '',
      ].join('\r\n');
      const loc = findExpressionLocation(content, '(http.host eq "test.com")');
      expect(loc).not.toBeNull();
      expect(loc!.isBlockScalar).toBe('>-');
    });

    it('finds plain multi-line in CRLF file', () => {
      const content = [
        '      expression: (http.host eq "test.com" and http.user_agent',
        '        eq "SomeBot/1.0")',
        '      enabled: true',
        '',
      ].join('\r\n');
      const loc = findExpressionLocation(content, '(http.host eq "test.com" and http.user_agent eq "SomeBot/1.0")');
      expect(loc).not.toBeNull();
    });

    it('finds double-quoted with escaped quotes in CRLF file', () => {
      const content = '    expression: "(http.host eq \\"test.com\\")"\r\n    enabled: true\r\n';
      const loc = findExpressionLocation(content, '(http.host eq "test.com")');
      expect(loc).not.toBeNull();
    });
  });

  describe('expression keys', () => {
    it('finds source_url_expression', () => {
      const content = '    source_url_expression: (http.request.full_uri matches "test")\n';
      const loc = findExpressionLocation(content, '(http.request.full_uri matches "test")');
      expect(loc).not.toBeNull();
      expect(loc!.key).toBe('source_url_expression:');
    });

    it('finds condition key', () => {
      const content = '    condition: (http.host eq "test.com")\n';
      const loc = findExpressionLocation(content, '(http.host eq "test.com")');
      expect(loc).not.toBeNull();
      expect(loc!.key).toBe('condition:');
    });

    it('returns null for non-expression key', () => {
      const content = '    description: (http.host eq "test.com")\n';
      const loc = findExpressionLocation(content, '(http.host eq "test.com")');
      expect(loc).toBeNull();
    });

    it('supports custom expression keys', () => {
      const content = '    my_filter: (http.host eq "test.com")\n';
      const loc = findExpressionLocation(content, '(http.host eq "test.com")', undefined, new Set(['my_filter']));
      expect(loc).not.toBeNull();
    });
  });

  describe('backwards search', () => {
    it('finds last occurrence first', () => {
      const content = [
        '    expression: (http.host eq "a.com")',
        '    enabled: true',
        '    expression: (http.host eq "a.com")',
        '    enabled: false',
        '',
      ].join('\n');
      const loc = findExpressionLocation(content, '(http.host eq "a.com")');
      expect(loc).not.toBeNull();
      expect(content.substring(loc!.lineEnd).trimStart()).toMatch(/^enabled: false/);
    });

    it('finds earlier occurrence with beforeOffset', () => {
      const content = [
        '    expression: (http.host eq "a.com")',
        '    enabled: true',
        '    expression: (http.host eq "a.com")',
        '    enabled: false',
        '',
      ].join('\n');
      const loc2 = findExpressionLocation(content, '(http.host eq "a.com")');
      const loc1 = findExpressionLocation(content, '(http.host eq "a.com")', loc2!.lineStart);
      expect(loc1).not.toBeNull();
      expect(content.substring(loc1!.lineEnd).trimStart()).toMatch(/^enabled: true/);
    });
  });

  describe('list items', () => {
    it('finds expression in list item', () => {
      const content = '      - expression: (http.host eq "test.com")\n        enabled: true\n';
      const loc = findExpressionLocation(content, '(http.host eq "test.com")');
      expect(loc).not.toBeNull();
      expect(loc!.indent).toBe('      - ');
    });
  });
});
