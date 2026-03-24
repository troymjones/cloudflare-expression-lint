import { describe, it, expect } from 'vitest';
import { rewriteExpressions, findExpressionLocation } from '../rewriter.js';

describe('findExpressionLocation', () => {
  it('finds inline expression', () => {
    const content = '    expression: (http.host eq "test.com" and http.request.method eq "POST")\n    enabled: true\n';
    const loc = findExpressionLocation(content, '(http.host eq "test.com" and http.request.method eq "POST")');
    expect(loc).not.toBeNull();
    expect(loc!.indent).toBe('    ');
    expect(loc!.key).toBe('expression:');
  });

  it('finds single-quoted inline expression', () => {
    const content = "    expression: '(http.host eq \"test.com\")'\n    enabled: true\n";
    const loc = findExpressionLocation(content, '(http.host eq "test.com")');
    expect(loc).not.toBeNull();
    expect(loc!.key).toBe('expression:');
  });

  it('finds block scalar expression (>-)', () => {
    const content = [
      '    expression: >-',
      '      (http.host eq "test.com"',
      '      and http.request.method eq "POST")',
      '    enabled: true',
      '',
    ].join('\n');
    const loc = findExpressionLocation(content, '(http.host eq "test.com" and http.request.method eq "POST")');
    expect(loc).not.toBeNull();
    expect(loc!.indent).toBe('    ');
  });

  it('finds block scalar expression (|)', () => {
    const content = [
      '    expression: |',
      '      (http.host eq "test.com"',
      '      and http.request.method eq "POST")',
      '    enabled: true',
      '',
    ].join('\n');
    const loc = findExpressionLocation(content, '(http.host eq "test.com" and http.request.method eq "POST")');
    expect(loc).not.toBeNull();
  });

  it('finds source_url_expression key', () => {
    const content = '    source_url_expression: (http.request.full_uri matches "test.com/path")\n    target: foo\n';
    const loc = findExpressionLocation(content, '(http.request.full_uri matches "test.com/path")');
    expect(loc).not.toBeNull();
    expect(loc!.key).toBe('source_url_expression:');
  });

  it('finds counting_expression key', () => {
    const content = '    counting_expression: (http.response.code gt 400 and http.response.code lt 500)\n    id: foo\n';
    const loc = findExpressionLocation(content, '(http.response.code gt 400 and http.response.code lt 500)');
    expect(loc).not.toBeNull();
    expect(loc!.key).toBe('counting_expression:');
  });

  it('returns null for non-expression key', () => {
    const content = '    description: (http.host eq "test.com")\n';
    const loc = findExpressionLocation(content, '(http.host eq "test.com")');
    expect(loc).toBeNull();
  });

  it('returns null when expression not found', () => {
    const content = '    expression: (http.host eq "other.com")\n';
    const loc = findExpressionLocation(content, '(http.host eq "test.com")');
    expect(loc).toBeNull();
  });

  it('captures correct line offsets for inline', () => {
    const line1 = '    enabled: true\n';
    const line2 = '    expression: (http.host eq "test.com")\n';
    const line3 = '    action: block\n';
    const content = line1 + line2 + line3;
    const loc = findExpressionLocation(content, '(http.host eq "test.com")');
    expect(loc).not.toBeNull();
    expect(loc!.lineStart).toBe(line1.length);
    expect(loc!.lineEnd).toBe(line1.length + line2.length);
    // Replacing lineStart..lineEnd should leave line1 and line3 intact
    const replaced = content.substring(0, loc!.lineStart) + 'REPLACED\n' + content.substring(loc!.lineEnd);
    expect(replaced).toBe(line1 + 'REPLACED\n' + line3);
  });

  it('captures correct line offsets for block scalar', () => {
    const before = '    enabled: true\n';
    const block = '    expression: >-\n      (http.host eq "test.com"\n      and http.request.method eq "POST")\n';
    const after = '    action: block\n';
    const content = before + block + after;
    const loc = findExpressionLocation(content, '(http.host eq "test.com" and http.request.method eq "POST")');
    expect(loc).not.toBeNull();
    expect(loc!.lineStart).toBe(before.length);
    expect(loc!.lineEnd).toBe(before.length + block.length);
    const replaced = content.substring(0, loc!.lineStart) + 'REPLACED\n' + content.substring(loc!.lineEnd);
    expect(replaced).toBe(before + 'REPLACED\n' + after);
  });

  it('respects beforeOffset parameter (searches backwards)', () => {
    const content = [
      '    expression: (http.host eq "a.com")',
      '    enabled: true',
      '    expression: (http.host eq "a.com")',
      '    enabled: false',
      '',
    ].join('\n');
    // Find the second occurrence
    const loc2 = findExpressionLocation(content, '(http.host eq "a.com")');
    expect(loc2).not.toBeNull();
    // It should find the LAST occurrence (searching backwards)
    expect(content.substring(loc2!.lineEnd).trimStart()).toMatch(/^enabled: false/);

    // Find before the second occurrence
    const loc1 = findExpressionLocation(content, '(http.host eq "a.com")', loc2!.lineStart);
    expect(loc1).not.toBeNull();
    expect(content.substring(loc1!.lineEnd).trimStart()).toMatch(/^enabled: true/);
  });

  it('finds inline expression in CRLF file', () => {
    const content = '    expression: (http.host eq "test.com")\r\n    enabled: true\r\n';
    const loc = findExpressionLocation(content, '(http.host eq "test.com")');
    expect(loc).not.toBeNull();
    expect(loc!.key).toBe('expression:');
    // lineEnd should include the \r so substring replacement works
    const replaced = content.substring(0, loc!.lineStart) + '    expression: REPLACED\r\n' + content.substring(loc!.lineEnd);
    expect(replaced).toContain('enabled: true');
  });

  it('finds block scalar expression in CRLF file', () => {
    const content = [
      '    expression: >-',
      '      (http.host eq "test.com"',
      '      and http.request.method eq "POST")',
      '    enabled: true',
      '',
    ].join('\r\n');
    const loc = findExpressionLocation(content, '(http.host eq "test.com" and http.request.method eq "POST")');
    expect(loc).not.toBeNull();
    expect(loc!.isBlockScalar).toBe('>-');
  });

  it('finds double-quoted expression with escaped quotes', () => {
    const content = '    expression: "(http.host eq \\"secure.example.com\\")"\n    enabled: true\n';
    const loc = findExpressionLocation(content, '(http.host eq "secure.example.com")');
    expect(loc).not.toBeNull();
    expect(loc!.key).toBe('expression:');
  });

  it('finds double-quoted expression with escaped quotes in CRLF file', () => {
    const content = '    expression: "(http.host eq \\"secure.example.com\\")"\r\n    enabled: true\r\n';
    const loc = findExpressionLocation(content, '(http.host eq "secure.example.com")');
    expect(loc).not.toBeNull();
  });

  it('finds plain multi-line value (no block scalar indicator)', () => {
    const content = [
      '      expression: (http.host eq "test.com" and http.user_agent',
      '        eq "SomeBot/1.0")',
      '      enabled: true',
      '',
    ].join('\n');
    const loc = findExpressionLocation(content, '(http.host eq "test.com" and http.user_agent eq "SomeBot/1.0")');
    expect(loc).not.toBeNull();
    expect(loc!.isBlockScalar).toBe('plain-multiline');
    // lineEnd should span past the continuation line
    const remaining = content.substring(loc!.lineEnd);
    expect(remaining).toMatch(/^\s*enabled: true/);
  });

  it('finds plain multi-line value in CRLF file', () => {
    const content = [
      '      expression: (http.host eq "test.com" and http.user_agent',
      '        eq "SomeBot/1.0")',
      '      enabled: true',
      '',
    ].join('\r\n');
    const loc = findExpressionLocation(content, '(http.host eq "test.com" and http.user_agent eq "SomeBot/1.0")');
    expect(loc).not.toBeNull();
    expect(loc!.isBlockScalar).toBe('plain-multiline');
  });
});

describe('rewriteExpressions', () => {
  it('rewrites a long inline expression to >- block scalar', () => {
    const content = [
      '- description: Test rule',
      '  expression: (http.host eq "secure.example.com" and http.request.method eq "POST" and http.request.uri.path eq "/api/v1/webhook" and not ip.src in $blocklist)',
      '  enabled: true',
      '',
    ].join('\n');

    const expressions = [
      { expression: '(http.host eq "secure.example.com" and http.request.method eq "POST" and http.request.uri.path eq "/api/v1/webhook" and not ip.src in $blocklist)' },
    ];

    const result = rewriteExpressions(content, expressions, { maxWidth: 80 });
    expect(result.count).toBe(1);
    expect(result.content).toContain('expression: >-');
    expect(result.content).toContain('and http.request.method eq "POST"');
    // Next key should be on its own line
    expect(result.content).toContain('\n  enabled: true');
  });

  it('preserves short expressions', () => {
    const content = [
      '- description: Test',
      '  expression: (http.host eq "test.com")',
      '  enabled: true',
      '',
    ].join('\n');

    const expressions = [{ expression: '(http.host eq "test.com")' }];
    const result = rewriteExpressions(content, expressions, { maxWidth: 120 });
    expect(result.count).toBe(0);
    expect(result.content).toBe(content);
  });

  it('does not corrupt subsequent YAML keys', () => {
    const content = [
      '    - description: Rule one',
      '      expression: (http.host eq "secure.example.com" and http.request.method eq "POST" and http.request.uri.path eq "/api/webhook")',
      '      identifier: RULE-001',
      '      enabled: true',
      '    - description: Rule two',
      '      expression: (http.host eq "other.com")',
      '      enabled: false',
      '',
    ].join('\n');

    const expressions = [
      { expression: '(http.host eq "secure.example.com" and http.request.method eq "POST" and http.request.uri.path eq "/api/webhook")' },
    ];

    const result = rewriteExpressions(content, expressions, { maxWidth: 80 });
    expect(result.count).toBe(1);

    // Verify subsequent keys are on their own lines
    const lines = result.content.split('\n');
    const identifierLine = lines.find(l => l.includes('identifier: RULE-001'));
    expect(identifierLine).toBeDefined();
    expect(identifierLine!.trim()).toBe('identifier: RULE-001');

    const enabledLine = lines.find(l => l.includes('enabled: true'));
    expect(enabledLine).toBeDefined();

    // Rule two should be intact
    expect(result.content).toContain('description: Rule two');
    expect(result.content).toContain('expression: (http.host eq "other.com")');
  });

  it('handles multiple expressions in one file', () => {
    const content = [
      '- description: Rule A',
      '  expression: (http.host eq "a.example.com" and http.request.method eq "POST" and http.request.uri.path eq "/api/long-path")',
      '  enabled: true',
      '- description: Rule B',
      '  expression: (http.host eq "b.example.com" and http.request.method eq "GET" and http.request.uri.path eq "/api/another-path")',
      '  enabled: true',
      '',
    ].join('\n');

    const expressions = [
      { expression: '(http.host eq "a.example.com" and http.request.method eq "POST" and http.request.uri.path eq "/api/long-path")' },
      { expression: '(http.host eq "b.example.com" and http.request.method eq "GET" and http.request.uri.path eq "/api/another-path")' },
    ];

    const result = rewriteExpressions(content, expressions, { maxWidth: 80 });
    expect(result.count).toBe(2);

    // Both should be reformatted
    const blockScalarCount = (result.content.match(/expression: >-/g) || []).length;
    expect(blockScalarCount).toBe(2);

    // Both enabled: true should be on their own lines
    const enabledLines = result.content.split('\n').filter(l => l.trim() === 'enabled: true');
    expect(enabledLines.length).toBe(2);
  });

  it('rewrites existing block scalar expressions', () => {
    const content = [
      '    expression: >-',
      '      (http.host eq "test.com"',
      '      and http.request.method eq "POST" and http.request.uri.path eq "/api/very-long-endpoint/v1/resource")',
      '    enabled: true',
      '',
    ].join('\n');

    const expressions = [
      { expression: '(http.host eq "test.com" and http.request.method eq "POST" and http.request.uri.path eq "/api/very-long-endpoint/v1/resource")' },
    ];

    const result = rewriteExpressions(content, expressions, { maxWidth: 80 });
    expect(result.count).toBe(1);
    expect(result.content).toContain('expression: >-');
    expect(result.content).toContain('\n    enabled: true');
  });

  it('deduplicates identical expressions', () => {
    const content = [
      '- expression: (http.host eq "a.example.com" and http.request.method eq "POST" and http.request.uri.path eq "/api/path")',
      '  enabled: true',
      '- expression: (http.host eq "a.example.com" and http.request.method eq "POST" and http.request.uri.path eq "/api/path")',
      '  enabled: false',
      '',
    ].join('\n');

    const expressions = [
      { expression: '(http.host eq "a.example.com" and http.request.method eq "POST" and http.request.uri.path eq "/api/path")' },
      { expression: '(http.host eq "a.example.com" and http.request.method eq "POST" and http.request.uri.path eq "/api/path")' },
    ];

    const result = rewriteExpressions(content, expressions, { maxWidth: 80 });
    // Both occurrences should be reformatted
    expect(result.count).toBe(2);
    const blockScalarCount = (result.content.match(/expression: >-/g) || []).length;
    expect(blockScalarCount).toBe(2);
  });

  it('respects maxWidth option', () => {
    const expr = '(http.host eq "test.com" and ip.src.country eq "US")';
    const content = `  expression: ${expr}\n  enabled: true\n`;
    const expressions = [{ expression: expr }];

    // Wide width — no change
    const wide = rewriteExpressions(content, expressions, { maxWidth: 200 });
    expect(wide.count).toBe(0);

    // Narrow width — should reformat
    const narrow = rewriteExpressions(content, expressions, { maxWidth: 40 });
    expect(narrow.count).toBe(1);
    expect(narrow.content).toContain('expression: >-');
  });
});

describe('convertBlockScalars', () => {
  it('converts | to >- for long expression', () => {
    const content = [
      '    expression: |',
      '      (http.host eq "test.com"',
      '      and http.request.method eq "POST"',
      '      and http.request.uri.path eq "/api")',
      '    enabled: true',
      '',
    ].join('\n');

    const expressions = [
      { expression: '(http.host eq "test.com" and http.request.method eq "POST" and http.request.uri.path eq "/api")' },
    ];

    const result = rewriteExpressions(content, expressions, { convertBlockScalars: true, maxWidth: 80 });
    expect(result.count).toBe(1);
    expect(result.content).toContain('expression: >-');
    expect(result.content).not.toContain('expression: |');
    expect(result.content).toContain('\n    enabled: true');
  });

  it('converts |- to >- for long expression', () => {
    const content = [
      '    expression: |-',
      '      (http.host eq "test.com"',
      '      and http.request.method eq "POST"',
      '      and http.request.uri.path eq "/api/v1/webhook/endpoint")',
      '    enabled: true',
      '',
    ].join('\n');

    const expressions = [
      { expression: '(http.host eq "test.com" and http.request.method eq "POST" and http.request.uri.path eq "/api/v1/webhook/endpoint")' },
    ];

    const result = rewriteExpressions(content, expressions, { convertBlockScalars: true, maxWidth: 80 });
    expect(result.count).toBe(1);
    expect(result.content).toContain('expression: >-');
    expect(result.content).not.toContain('expression: |-');
  });

  it('converts short | expression to inline', () => {
    const content = [
      '    expression: |',
      '      (http.host eq "test.com")',
      '    enabled: true',
      '',
    ].join('\n');

    const expressions = [
      { expression: '(http.host eq "test.com")' },
    ];

    const result = rewriteExpressions(content, expressions, { convertBlockScalars: true, maxWidth: 120 });
    expect(result.count).toBe(1);
    // Short expression should become inline, not >-
    expect(result.content).toContain('expression: (http.host eq "test.com")');
    expect(result.content).not.toContain('expression: |');
    expect(result.content).toContain('\n    enabled: true');
  });

  it('does not change expressions already using >-', () => {
    const content = [
      '    expression: >-',
      '      (http.host eq "test.com"',
      '      and http.request.method eq "POST")',
      '    enabled: true',
      '',
    ].join('\n');

    const expressions = [
      { expression: '(http.host eq "test.com" and http.request.method eq "POST")' },
    ];

    const result = rewriteExpressions(content, expressions, { convertBlockScalars: true, maxWidth: 120 });
    // Already >- and formatter wouldn't change the content — no modification needed
    expect(result.count).toBe(0);
  });

  it('does not convert | when flag is not set', () => {
    const content = [
      '    expression: |',
      '      (http.host eq "test.com")',
      '    enabled: true',
      '',
    ].join('\n');

    const expressions = [
      { expression: '(http.host eq "test.com")' },
    ];

    const result = rewriteExpressions(content, expressions, { maxWidth: 120 });
    expect(result.count).toBe(0);
    expect(result.content).toBe(content);
  });

  it('preserves raw strings when converting | to >-', () => {
    const content = [
      '    expression: |',
      '      (http.user_agent matches r"Bot.*"',
      '      and http.host eq "test.com"',
      '      and http.request.uri.path matches r"^/api/v[0-9]+")',
      '    enabled: true',
      '',
    ].join('\n');

    const expressions = [
      { expression: '(http.user_agent matches r"Bot.*" and http.host eq "test.com" and http.request.uri.path matches r"^/api/v[0-9]+")' },
    ];

    const result = rewriteExpressions(content, expressions, { convertBlockScalars: true, maxWidth: 80 });
    expect(result.count).toBe(1);
    expect(result.content).toContain('expression: >-');
    expect(result.content).toContain('r"Bot.*"');
    expect(result.content).toContain('r"^/api/v[0-9]+"');
  });

  it('handles multiple | expressions in one file', () => {
    const content = [
      '- description: Rule A',
      '  expression: |',
      '    (http.host eq "a.example.com"',
      '    and http.request.method eq "POST"',
      '    and http.request.uri.path eq "/api/webhook")',
      '  enabled: true',
      '- description: Rule B',
      '  expression: |',
      '    (http.host eq "b.example.com"',
      '    and http.request.method eq "GET"',
      '    and http.request.uri.path eq "/api/status")',
      '  enabled: true',
      '',
    ].join('\n');

    const expressions = [
      { expression: '(http.host eq "a.example.com" and http.request.method eq "POST" and http.request.uri.path eq "/api/webhook")' },
      { expression: '(http.host eq "b.example.com" and http.request.method eq "GET" and http.request.uri.path eq "/api/status")' },
    ];

    const result = rewriteExpressions(content, expressions, { convertBlockScalars: true, maxWidth: 80 });
    expect(result.count).toBe(2);
    const blockCount = (result.content.match(/expression: >-/g) || []).length;
    expect(blockCount).toBe(2);
    expect(result.content).not.toContain('expression: |');
    // Both enabled: true should be on their own lines
    const enabledLines = result.content.split('\n').filter(l => l.trim() === 'enabled: true');
    expect(enabledLines.length).toBe(2);
  });

  it('converts | with empty lines in block to >-', () => {
    const content = [
      '    expression: |',
      '      (http.host eq "test.com"',
      '',
      '      and http.request.method eq "POST")',
      '    enabled: true',
      '',
    ].join('\n');

    const expressions = [
      { expression: '(http.host eq "test.com" and http.request.method eq "POST")' },
    ];

    const result = rewriteExpressions(content, expressions, { convertBlockScalars: true, maxWidth: 120 });
    expect(result.count).toBe(1);
    expect(result.content).not.toContain('expression: |');
  });

  it('idempotent — second rewrite returns count 0', () => {
    const content = [
      '- description: Rule A',
      '  expression: (http.host eq "a.example.com" and http.request.method eq "POST" and http.request.uri.path eq "/api/long-path")',
      '  enabled: true',
      '',
    ].join('\n');

    const expressions = [
      { expression: '(http.host eq "a.example.com" and http.request.method eq "POST" and http.request.uri.path eq "/api/long-path")' },
    ];

    const first = rewriteExpressions(content, expressions, { maxWidth: 80 });
    expect(first.count).toBe(1);

    // Second pass on the prettified output
    const second = rewriteExpressions(first.content, expressions, { maxWidth: 80 });
    expect(second.count).toBe(0);
    expect(second.content).toBe(first.content);
  });

  it('handles single-quoted YAML value end-to-end', () => {
    const content = [
      "  expression: '(http.host eq \"a.example.com\" and http.request.method eq \"POST\" and http.request.uri.path eq \"/api/webhook\")'",
      '  enabled: true',
      '',
    ].join('\n');

    const expressions = [
      { expression: '(http.host eq "a.example.com" and http.request.method eq "POST" and http.request.uri.path eq "/api/webhook")' },
    ];

    const result = rewriteExpressions(content, expressions, { maxWidth: 80 });
    expect(result.count).toBe(1);
    expect(result.content).toContain('expression: >-');
    expect(result.content).toContain('\n  enabled: true');
  });

  it('does not corrupt next YAML key when converting |', () => {
    const content = [
      '    expression: |',
      '      (http.host eq "test.com"',
      '      and http.request.method eq "POST"',
      '      and http.request.uri.path eq "/api/v1/resource")',
      '    identifier: RULE-001',
      '    action: block',
      '',
    ].join('\n');

    const expressions = [
      { expression: '(http.host eq "test.com" and http.request.method eq "POST" and http.request.uri.path eq "/api/v1/resource")' },
    ];

    const result = rewriteExpressions(content, expressions, { convertBlockScalars: true, maxWidth: 80 });
    expect(result.count).toBe(1);
    const lines = result.content.split('\n');
    const idLine = lines.find(l => l.includes('identifier: RULE-001'));
    expect(idLine).toBeDefined();
    expect(idLine!.trim()).toBe('identifier: RULE-001');
    const actionLine = lines.find(l => l.includes('action: block'));
    expect(actionLine).toBeDefined();
  });

  it('does not collapse plain multi-line values with unparseable expressions', () => {
    // Expressions with template placeholders can't be parsed by the formatter.
    // Plain multi-line YAML values should be left alone, not collapsed to inline.
    const content = [
      '      expression: (',
      '          http.request.uri.path eq "/graphql" and',
      '          http.request.method eq "POST" and',
      '          any(http.request.headers["origin"][*] eq "https://example.com") and',
      '          any(http.request.headers["x-app"][*] in {TEMPLATE_PLACEHOLDER})',
      '        )',
      '      enabled: true',
      '',
    ].join('\n');
    const expressions = [
      { expression: '( http.request.uri.path eq "/graphql" and http.request.method eq "POST" and any(http.request.headers["origin"][*] eq "https://example.com") and any(http.request.headers["x-app"][*] in {TEMPLATE_PLACEHOLDER}) )' },
    ];

    const result = rewriteExpressions(content, expressions, {
      maxWidth: 120,
      convertBlockScalars: true,
    });
    // Should not rewrite since formatter can't improve the expression
    expect(result.count).toBe(0);
    expect(result.content).toBe(content);
  });

  it('does rewrite plain multi-line values when formatter can improve them', () => {
    // Parseable expressions that happen to be plain multi-line should still be rewritten
    const content = [
      '      expression: (http.host eq "test.com"',
      '        and http.request.method eq "POST")',
      '      enabled: true',
      '',
    ].join('\n');
    const expressions = [
      { expression: '(http.host eq "test.com" and http.request.method eq "POST")' },
    ];

    const result = rewriteExpressions(content, expressions, {
      maxWidth: 120,
      convertBlockScalars: true,
    });
    // Should rewrite since the expression fits on one line
    expect(result.count).toBe(1);
  });
});

describe('rewriteExpressions with replacements', () => {
  it('applies replacement and formats through same code path as prettify', () => {
    const content = [
      '    expression: (A) and (B)',
      '    enabled: true',
      '',
    ].join('\n');
    const expressions = [{ expression: '(A) and (B)' }];
    const replacements = new Map([['(A) and (B)', '(A and B)']]);

    const result = rewriteExpressions(content, expressions, { replacements });
    expect(result.content).toContain('(A and B)');
    expect(result.count).toBe(1);
  });

  it('fix then prettify produces stable output (convergence)', () => {
    const content = [
      '    expression: >-',
      '      (http.host eq "test.com"',
      '      and http.request.method eq "POST")',
      '    enabled: true',
      '',
    ].join('\n');
    const expressions = [
      { expression: '(http.host eq "test.com" and http.request.method eq "POST")' },
    ];

    // Simulate --fix with replacements (no actual fix needed, just format)
    const fixResult = rewriteExpressions(content, expressions, {
      maxWidth: 120,
      convertBlockScalars: true,
      replacements: new Map(),
    });

    // Simulate --prettify on the result
    const prettifyResult = rewriteExpressions(fixResult.content, expressions, {
      maxWidth: 120,
      convertBlockScalars: true,
    });

    // Should be stable: prettify after fix produces no changes
    expect(prettifyResult.count).toBe(0);
    expect(prettifyResult.content).toBe(fixResult.content);
  });

  it('replacement with multi-line formatting uses >- block scalar', () => {
    const content = [
      '    expression: (A) and (B) and (C)',
      '    enabled: true',
      '',
    ].join('\n');
    const expressions = [{ expression: '(A) and (B) and (C)' }];
    // Fix merges and-groups
    const replacements = new Map([['(A) and (B) and (C)', '(A and B and C)']]);

    const result = rewriteExpressions(content, expressions, {
      maxWidth: 20,
      convertBlockScalars: true,
      replacements,
    });
    expect(result.content).toContain('>-');
    expect(result.count).toBe(1);
  });

  it('applies replacement to double-quoted expression with escaped quotes', () => {
    const content = '    expression: "(http.host eq \\"test.com\\") and (cf.zone.plan eq \\"ENT\\")"\n    enabled: true\n';
    const expressions = [{ expression: '(http.host eq "test.com") and (cf.zone.plan eq "ENT")' }];
    const canonical = '(http.host eq "test.com") and (cf.zone.plan eq "ENT")';
    const replacements = new Map([[canonical, '(http.host eq "test.com" and cf.zone.plan eq "ENT")']]);

    const result = rewriteExpressions(content, expressions, {
      maxWidth: 120,
      convertBlockScalars: true,
      replacements,
    });
    expect(result.count).toBe(1);
    expect(result.content).toContain('(http.host eq "test.com" and cf.zone.plan eq "ENT")');
    // Should not have the escaped quotes anymore (now >- or inline without quotes)
    expect(result.content).not.toContain('\\"');
  });

  it('applies replacement to plain multi-line value', () => {
    const content = [
      '      expression: ((http.host eq "test.com") and (http.user_agent',
      '        eq "SomeBot/1.0"))',
      '      enabled: true',
      '',
    ].join('\n');
    const expr = '((http.host eq "test.com") and (http.user_agent eq "SomeBot/1.0"))';
    const expressions = [{ expression: expr }];
    const canonical = '((http.host eq "test.com") and (http.user_agent eq "SomeBot/1.0"))';
    const replacements = new Map([[canonical, '(http.host eq "test.com" and http.user_agent eq "SomeBot/1.0")']]);

    const result = rewriteExpressions(content, expressions, {
      maxWidth: 120,
      convertBlockScalars: true,
      replacements,
    });
    expect(result.count).toBe(1);
    expect(result.content).toContain('http.host eq "test.com" and http.user_agent eq "SomeBot/1.0"');
  });

  it('applies replacement in CRLF file and converges', () => {
    const content = [
      '    expression: (A) and (B)',
      '    enabled: true',
      '',
    ].join('\r\n');
    const expressions = [{ expression: '(A) and (B)' }];
    const replacements = new Map([['(A) and (B)', '(A and B)']]);

    const result = rewriteExpressions(content, expressions, {
      maxWidth: 120,
      convertBlockScalars: true,
      replacements,
    });
    expect(result.count).toBe(1);
    expect(result.content).toContain('(A and B)');

    // Re-run prettify on the result - should be stable
    const prettifyResult = rewriteExpressions(result.content, [{ expression: '(A and B)' }], {
      maxWidth: 120,
      convertBlockScalars: true,
    });
    expect(prettifyResult.count).toBe(0);
  });

  it('converges when fix changes expression in >- block', () => {
    // Simulates: expression in >- block needs fixing, then prettify runs
    const content = [
      '    expression: >-',
      '      (http.host eq "test.com")',
      '      and (http.request.method eq "POST")',
      '    enabled: true',
      '',
    ].join('\n');
    const originalExpr = '(http.host eq "test.com") and (http.request.method eq "POST")';
    const fixedExpr = '(http.host eq "test.com" and http.request.method eq "POST")';
    const expressions = [{ expression: originalExpr }];
    const canonical = '(http.host eq "test.com") and (http.request.method eq "POST")';
    const replacements = new Map([[canonical, fixedExpr]]);

    // Step 1: --fix
    const fixResult = rewriteExpressions(content, expressions, {
      maxWidth: 120,
      convertBlockScalars: true,
      replacements,
    });
    expect(fixResult.count).toBe(1);
    expect(fixResult.content).toContain('http.host eq "test.com" and http.request.method eq "POST"');

    // Step 2: --prettify on the result
    const prettifyResult = rewriteExpressions(fixResult.content, [{ expression: fixedExpr }], {
      maxWidth: 120,
      convertBlockScalars: true,
    });
    expect(prettifyResult.count).toBe(0);
    expect(prettifyResult.content).toBe(fixResult.content);
  });
});
