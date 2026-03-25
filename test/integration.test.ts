/**
 * Integration tests — calls real public APIs via the built CLI binary.
 * Only tests no-auth platforms (hn, lb, dev, so, arxiv, gh, med, sub).
 * Requires: pnpm build (dist/ must exist).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execFileAsync = promisify(execFile);
// Resolve from repo root — tests must be run from the package directory
const CLI = path.resolve(process.cwd(), 'dist/main.js');

/** Run the CLI and return { stdout, stderr, code }. */
async function run(args: string[], timeoutMs = 30_000): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync('node', [CLI, ...args], {
      timeout: timeoutMs,
      env: { ...process.env, CROSSMIND_DATA_DIR: `/tmp/crossmind-ci-${Date.now()}` },
    });
    return { stdout, stderr, code: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? 1 };
  }
}

/** Assert that output contains N or more non-empty lines. */
function assertLines(stdout: string, minCount: number, label: string): void {
  const lines = stdout.trim().split('\n').filter((l) => l.trim().length > 0);
  assert.ok(lines.length >= minCount, `${label}: expected >= ${minCount} lines, got ${lines.length}\nOutput: ${stdout.slice(0, 500)}`);
}

// ── CLI basics ───────────────────────────────────────────────────────────

describe('CLI basics', () => {
  test('--version prints version', async () => {
    const { stdout, code } = await run(['--version']);
    assert.equal(code, 0);
    assert.match(stdout, /\d+\.\d+\.\d+/);
  });

  test('--help exits 0', async () => {
    const { code } = await run(['--help']);
    assert.equal(code, 0);
  });

  test('hn --help exits 0', async () => {
    const { code } = await run(['hn', '--help']);
    assert.equal(code, 0);
  });
});

// ── Hacker News ──────────────────────────────────────────────────────────

describe('hn (Hacker News)', () => {
  test('hn top 5: returns 5 results in compact format', async () => {
    const { stdout, stderr, code } = await run(['hn', 'top', '5']);
    assert.equal(code, 0, `exit code should be 0, stderr: ${stderr}`);
    assertLines(stdout, 5, 'hn top 5');
    // Should match compact format: "1. score:NNN ..."
    assert.match(stdout, /^1\. score:\d+/m);
    // Footer on stderr
    assert.match(stderr, /results/);
  });

  test('hn top 5 --json: valid JSON array with required fields', async () => {
    const { stdout, code } = await run(['hn', 'top', '5', '--json']);
    assert.equal(code, 0);
    const items = JSON.parse(stdout) as Record<string, unknown>[];
    assert.ok(Array.isArray(items));
    assert.ok(items.length >= 1);
    const first = items[0];
    assert.ok(typeof first['title'] === 'string' && first['title'].length > 0, 'title should be non-empty');
    assert.ok(typeof first['score'] === 'number' || typeof first['score'] === 'string', 'score should exist');
    assert.equal(first['rank'], 1);
  });

  test('hn new 3: returns newest stories', async () => {
    const { stdout, code } = await run(['hn', 'new', '3']);
    assert.equal(code, 0);
    assertLines(stdout, 3, 'hn new 3');
  });

  test('hn ask 3: returns Ask HN posts', async () => {
    const { stdout, code } = await run(['hn', 'ask', '3']);
    assert.equal(code, 0);
    assertLines(stdout, 1, 'hn ask 3');  // Ask may have fewer results
  });

  test('hn show 3: returns Show HN posts', async () => {
    const { stdout, code } = await run(['hn', 'show', '3']);
    assert.equal(code, 0);
    assertLines(stdout, 1, 'hn show 3');
  });
});

// ── Lobsters ─────────────────────────────────────────────────────────────

describe('lb (Lobsters)', () => {
  test('lb top 5: returns hottest stories', async () => {
    const { stdout, code } = await run(['lb', 'top', '5']);
    assert.equal(code, 0);
    assertLines(stdout, 5, 'lb top 5');
    assert.match(stdout, /^1\. score:\d+/m);
  });

  test('lb top 5 --json: valid JSON with expected fields', async () => {
    const { stdout, code } = await run(['lb', 'top', '5', '--json']);
    assert.equal(code, 0);
    const items = JSON.parse(stdout) as Record<string, unknown>[];
    assert.ok(items.length >= 1);
    const first = items[0];
    assert.ok(first['title'], 'title should exist');
    assert.ok(first['url'] || first['score'] !== undefined, 'url or score should exist');
  });

  test('lb new 5: returns newest stories', async () => {
    const { stdout, code } = await run(['lb', 'new', '5']);
    assert.equal(code, 0);
    assertLines(stdout, 5, 'lb new 5');
  });
});

// ── DEV.to ───────────────────────────────────────────────────────────────

describe('dev (DEV.to)', () => {
  test('dev top 5: returns top articles', async () => {
    const { stdout, code } = await run(['dev', 'top', '5']);
    assert.equal(code, 0);
    assertLines(stdout, 5, 'dev top 5');
  });

  test('dev latest 5: returns latest articles', async () => {
    const { stdout, code } = await run(['dev', 'latest', '5']);
    assert.equal(code, 0);
    assertLines(stdout, 5, 'dev latest 5');
  });

  test('dev search javascript 5: returns articles about javascript', async () => {
    const { stdout, code } = await run(['dev', 'search', 'javascript', '5']);
    assert.equal(code, 0);
    assertLines(stdout, 1, 'dev search javascript');
  });
});

// ── Stack Overflow ────────────────────────────────────────────────────────

describe('so (Stack Overflow)', () => {
  test('so top 5: returns top questions', async () => {
    const { stdout, code } = await run(['so', 'top', '5']);
    assert.equal(code, 0);
    assertLines(stdout, 5, 'so top 5');
    assert.match(stdout, /score:\d+/m);
    assert.match(stdout, /answers:\d+/m);
  });

  test('so search "async await" 5: returns search results', async () => {
    const { stdout, code } = await run(['so', 'search', 'async await', '5']);
    assert.equal(code, 0);
    assertLines(stdout, 1, 'so search async await');
  });

  test('so top 5 --json: valid JSON', async () => {
    const { stdout, code } = await run(['so', 'top', '5', '--json']);
    assert.equal(code, 0);
    const items = JSON.parse(stdout) as Record<string, unknown>[];
    assert.ok(items.length >= 1);
    assert.ok(items[0]['title'], 'title should exist');
  });
});

// ── arXiv ────────────────────────────────────────────────────────────────

describe('arxiv', () => {
  test('arxiv search "attention mechanism" 3: returns papers', async () => {
    const { stdout, code } = await run(['arxiv', 'search', 'attention mechanism', '3']);
    assert.equal(code, 0);
    assertLines(stdout, 1, 'arxiv search');
    assert.match(stdout, /https:\/\/arxiv\.org/m);
  });

  test('arxiv recent 3 --cat cs.AI: recent AI papers', async () => {
    const { stdout, code } = await run(['arxiv', 'recent', '3', '--cat', 'cs.AI']);
    assert.equal(code, 0);
    assertLines(stdout, 1, 'arxiv recent cs.AI');
  });

  test('arxiv search --json: parseable JSON', async () => {
    const { stdout, code } = await run(['arxiv', 'search', 'transformer', '3', '--json']);
    assert.equal(code, 0);
    const items = JSON.parse(stdout) as Record<string, unknown>[];
    assert.ok(Array.isArray(items));
    assert.ok(items[0]['title'], 'title should exist');
    assert.match(String(items[0]['url']), /arxiv\.org/);
  });
});

// ── GitHub ────────────────────────────────────────────────────────────────

describe('gh (GitHub)', () => {
  test('gh search "typescript cli" 5: returns repos', async () => {
    const { stdout, code } = await run(['gh', 'search', 'typescript cli', '5']);
    assert.equal(code, 0);
    assertLines(stdout, 5, 'gh search typescript cli');
    assert.match(stdout, /stars:\d+/m);
  });

  test('gh trending 5: returns trending repos', async () => {
    const { stdout, code } = await run(['gh', 'trending', '5']);
    assert.equal(code, 0);
    assertLines(stdout, 5, 'gh trending');
  });

  test('gh trending --lang python 5: python trending repos', async () => {
    const { stdout, code } = await run(['gh', 'trending', '5', '--lang', 'python']);
    assert.equal(code, 0);
    assertLines(stdout, 1, 'gh trending python');
  });

  test('gh issues cli/cli 5: returns open issues', async () => {
    const { stdout, code } = await run(['gh', 'issues', 'cli/cli', '5']);
    assert.equal(code, 0);
    assertLines(stdout, 1, 'gh issues cli/cli');
    assert.match(stdout, /#\d+/m);
  });

  test('gh releases cli/cli 3: returns releases', async () => {
    const { stdout, code } = await run(['gh', 'releases', 'cli/cli', '3']);
    assert.equal(code, 0);
    assertLines(stdout, 1, 'gh releases cli/cli');
  });

  test('gh search --json: parseable JSON with expected fields', async () => {
    const { stdout, code } = await run(['gh', 'search', 'react', '3', '--json']);
    assert.equal(code, 0);
    const items = JSON.parse(stdout) as Record<string, unknown>[];
    assert.ok(items.length >= 1);
    assert.ok(items[0]['full_name'], 'full_name should exist');
    assert.ok(typeof items[0]['stars'] === 'number', 'stars should be number');
  });
});

// ── Medium ───────────────────────────────────────────────────────────────

describe('med (Medium)', () => {
  test('med tag javascript 5: returns JS articles', async () => {
    const { stdout, code } = await run(['med', 'tag', 'javascript', '5']);
    assert.equal(code, 0);
    assertLines(stdout, 1, 'med tag javascript');
    assert.match(stdout, /medium\.com/m);
  });
});

// ── Substack ──────────────────────────────────────────────────────────────

describe('sub (Substack)', () => {
  test('sub feed lenny 5: returns Lenny newsletter posts', async () => {
    const { stdout, code } = await run(['sub', 'feed', 'lenny', '5']);
    assert.equal(code, 0);
    assertLines(stdout, 1, 'sub feed lenny');
  });
});

// ── Account management ────────────────────────────────────────────────────

describe('account management', () => {
  test('account list: exits 0 when no accounts', async () => {
    const { code } = await run(['account', 'list'], 5000);
    assert.equal(code, 0);
  });

  test('auth status: exits 0 when no accounts stored', async () => {
    const { code } = await run(['auth', 'status'], 5000);
    assert.equal(code, 0);
  });
});
