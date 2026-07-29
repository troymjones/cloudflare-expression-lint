import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CLI = join(__dirname, '../../dist/cli.js');
const FIXTURES = join(__dirname, 'fixtures');

function run(args: string[], opts?: { cwd?: string }): { stdout: string; exitCode: number } {
  try {
    const stdout = execFileSync('node', [CLI, ...args], {
      encoding: 'utf-8',
      cwd: opts?.cwd,
      timeout: 10000,
    });
    return { stdout, exitCode: 0 };
  } catch (err: any) {
    return { stdout: (err.stdout ?? '') + (err.stderr ?? ''), exitCode: err.status ?? 1 };
  }
}

describe('CLI', () => {
  describe('single expression mode', () => {
    it('-e validates a valid expression', () => {
      const { stdout, exitCode } = run(['-e', '(http.host eq "test.com")']);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('valid');
    });

    it('-e reports errors for invalid expression', () => {
      const { exitCode } = run(['-e', '(http.nonexistent_field eq "test")']);
      expect(exitCode).toBe(1);
    });

    it('-e with --fix auto-fixes expression', () => {
      const { stdout, exitCode } = run(['-e', 'http.host eq "test.com"', '--fix']);
      expect(exitCode).toBe(0);
      expect(stdout.trim()).toBe('(http.host eq "test.com")');
    });

    it('-e with --prettify formats expression', () => {
      const { stdout, exitCode } = run([
        '-e',
        '(http.host eq "api.example.com" and http.request.method eq "POST" and http.request.uri.path eq "/webhook" and not ip.src in $internal)',
        '--prettify',
      ]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('\n');
    });

    it('--format json outputs JSON', () => {
      const { stdout, exitCode } = run(['-e', '(http.host eq "test.com")', '--format', 'json']);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.valid).toBe(true);
    });
  });

  describe('file scanning mode', () => {
    it('scans clean file with no errors', () => {
      const { exitCode } = run([join(FIXTURES, 'clean.yaml')]);
      expect(exitCode).toBe(0);
    });

    it('reports errors for file with invalid fields', () => {
      const { exitCode } = run([join(FIXTURES, 'with-errors.yaml')]);
      expect(exitCode).toBe(1);
    });

    it('uses config file', () => {
      const { exitCode } = run([
        '--config', join(FIXTURES, 'test-config.json'),
        join(FIXTURES, 'clean.yaml'),
      ]);
      expect(exitCode).toBe(0);
    });
  });

  describe('--fix mode', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'cf-lint-test-'));
      cpSync(join(FIXTURES, 'needs-fix.yaml'), join(tmpDir, 'test.yaml'));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('--fix modifies file', () => {
      const before = readFileSync(join(tmpDir, 'test.yaml'), 'utf-8');
      const { exitCode } = run(['--fix', join(tmpDir, 'test.yaml')]);
      expect(exitCode).toBe(0);
      const after = readFileSync(join(tmpDir, 'test.yaml'), 'utf-8');
      expect(after).not.toBe(before);
    });

    it('--fix --check reports needed fixes without modifying', () => {
      const before = readFileSync(join(tmpDir, 'test.yaml'), 'utf-8');
      const { exitCode } = run(['--fix', '--check', join(tmpDir, 'test.yaml')]);
      expect(exitCode).toBe(1);
      const after = readFileSync(join(tmpDir, 'test.yaml'), 'utf-8');
      expect(after).toBe(before);
    });

    it('--fix --check exits 0 after --fix', () => {
      run(['--fix', join(tmpDir, 'test.yaml')]);
      const { exitCode } = run(['--fix', '--check', join(tmpDir, 'test.yaml')]);
      expect(exitCode).toBe(0);
    });
  });

  describe('--prettify mode', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'cf-lint-test-'));
      cpSync(join(FIXTURES, 'needs-prettify.yaml'), join(tmpDir, 'test.yaml'));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('--prettify reformats long expressions', () => {
      const before = readFileSync(join(tmpDir, 'test.yaml'), 'utf-8');
      const { exitCode } = run(['--prettify', join(tmpDir, 'test.yaml')]);
      expect(exitCode).toBe(0);
      const after = readFileSync(join(tmpDir, 'test.yaml'), 'utf-8');
      expect(after).toContain('>-');
    });

    it('--prettify --check reports needed formatting without modifying', () => {
      const before = readFileSync(join(tmpDir, 'test.yaml'), 'utf-8');
      const { exitCode } = run(['--prettify', '--check', join(tmpDir, 'test.yaml')]);
      expect(exitCode).toBe(1);
      const after = readFileSync(join(tmpDir, 'test.yaml'), 'utf-8');
      expect(after).toBe(before);
    });

    it('--prettify --check exits 0 after --prettify', () => {
      run(['--prettify', join(tmpDir, 'test.yaml')]);
      const { exitCode } = run(['--prettify', '--check', join(tmpDir, 'test.yaml')]);
      expect(exitCode).toBe(0);
    });
  });

  describe('convergence', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'cf-lint-test-'));
      cpSync(join(FIXTURES, 'needs-fix.yaml'), join(tmpDir, 'test.yaml'));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('fix then prettify check passes', () => {
      run(['--fix', join(tmpDir, 'test.yaml')]);
      run(['--prettify', '--convert-block-scalars', join(tmpDir, 'test.yaml')]);
      const fixCheck = run(['--fix', '--check', join(tmpDir, 'test.yaml')]);
      const prettyCheck = run(['--prettify', '--check', '--convert-block-scalars', join(tmpDir, 'test.yaml')]);
      expect(fixCheck.exitCode).toBe(0);
      expect(prettyCheck.exitCode).toBe(0);
    });
  });

  describe('placeholders', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'cf-lint-test-'));
      cpSync(join(FIXTURES, 'with-placeholders.yaml'), join(tmpDir, 'test.yaml'));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('preserves placeholders through fix + prettify', () => {
      run(['--fix', join(tmpDir, 'test.yaml')]);
      run(['--prettify', '--convert-block-scalars', join(tmpDir, 'test.yaml')]);
      const content = readFileSync(join(tmpDir, 'test.yaml'), 'utf-8');
      expect(content).toContain('__ALLOWED_APPS__');
      expect(content).not.toContain('ph0');
    });
  });

  describe('error handling', () => {
    it('shows help and exits 1 with no args', () => {
      const { stdout, exitCode } = run([]);
      expect(exitCode).toBe(1);
      expect(stdout).toContain('Usage');
    });

    it('--help exits 0', () => {
      const { stdout, exitCode } = run(['--help']);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('Usage');
    });

    it('handles non-existent file', () => {
      const { exitCode } = run(['/tmp/nonexistent-file-12345.yaml']);
      // Should not crash
      expect(typeof exitCode).toBe('number');
    });
  });

  describe('--quiet mode', () => {
    it('suppresses warnings', () => {
      const normal = run(['-e', '(http.host eq "test.com")']);
      const quiet = run(['-e', '(http.host eq "test.com")', '--quiet']);
      expect(quiet.stdout.length).toBeLessThanOrEqual(normal.stdout.length);
    });
  });
});

describe('CLI --fix combined with --prettify', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'cf-expr-both-')); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  // A file needing only formatting (no semantic fix) must still be formatted
  // when both flags are passed. Previously --fix short-circuited and exited.
  const needsFormatOnly =
    'rules:\n' +
    '  - expression: (http.host eq "test.com" and starts_with(http.request.uri.path, "/a/long/enough/path/to/wrap/the/line") and http.request.method eq "POST")\n';

  it('--fix --prettify formats a file that needs no semantic fix', () => {
    const file = join(tmpDir, 'test.yaml');
    writeFileSync(file, needsFormatOnly);
    const { exitCode } = run(['--fix', '--prettify', file]);
    expect(exitCode).toBe(0);
    expect(readFileSync(file, 'utf-8')).toContain('expression: >-');
  });

  it('--fix --prettify --check reports formatting work, not just fixes', () => {
    const file = join(tmpDir, 'test.yaml');
    writeFileSync(file, needsFormatOnly);
    const { stdout, exitCode } = run(['--fix', '--prettify', '--check', file]);
    expect(exitCode).toBe(1);
    expect(stdout).toContain('need formatting');
    // and it must not have modified the file in --check mode
    expect(readFileSync(file, 'utf-8')).toBe(needsFormatOnly);
  });

  it('--fix --prettify --check exits 0 on an already-clean file', () => {
    const file = join(tmpDir, 'test.yaml');
    writeFileSync(file, 'rules:\n  - expression: (http.host eq "test.com")\n');
    const { exitCode } = run(['--fix', '--prettify', '--check', file]);
    expect(exitCode).toBe(0);
  });
});
