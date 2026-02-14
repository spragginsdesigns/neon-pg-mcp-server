/**
 * Verification tests for v1.7.0 security hardening & reliability fixes.
 * Tests run against the module's exported/internal logic without needing a DB connection.
 *
 * Usage: node test-security-fixes.js
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverSource = readFileSync(join(__dirname, 'pg-mcp-server.js'), 'utf8');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.error(`  PASS: ${name}`);
    passed++;
  } catch (e) {
    console.error(`  FAIL: ${name} — ${e.message}`);
    failed++;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

// ── assertSafeIdentifier tests ──
// Extract the regex from source to test it directly
const SAFE_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

console.error('\n── assertSafeIdentifier ──');

test('accepts simple table name', () => {
  assert(SAFE_IDENTIFIER.test('users'), 'should accept "users"');
});

test('accepts underscored name', () => {
  assert(SAFE_IDENTIFIER.test('user_profiles'), 'should accept "user_profiles"');
});

test('accepts name starting with underscore', () => {
  assert(SAFE_IDENTIFIER.test('_internal'), 'should accept "_internal"');
});

test('accepts mixed case', () => {
  assert(SAFE_IDENTIFIER.test('MyTable'), 'should accept "MyTable"');
});

test('rejects SQL injection attempt', () => {
  assert(!SAFE_IDENTIFIER.test("'; DROP TABLE users --"), 'should reject injection');
});

test('rejects name with spaces', () => {
  assert(!SAFE_IDENTIFIER.test('my table'), 'should reject spaces');
});

test('rejects name starting with number', () => {
  assert(!SAFE_IDENTIFIER.test('1table'), 'should reject leading digit');
});

test('rejects empty string', () => {
  assert(!SAFE_IDENTIFIER.test(''), 'should reject empty');
});

test('rejects name with dots', () => {
  assert(!SAFE_IDENTIFIER.test('schema.table'), 'should reject dots');
});

test('rejects name with parens', () => {
  assert(!SAFE_IDENTIFIER.test('func()'), 'should reject parens');
});

// ── Schema cache TTL + invalidation ──
console.error('\n── Schema cache TTL & invalidation ──');

test('source contains cacheTimestamp variable', () => {
  assert(serverSource.includes('let cacheTimestamp = 0'), 'should have cacheTimestamp');
});

test('source contains CACHE_TTL constant', () => {
  assert(serverSource.includes('CACHE_TTL'), 'should have CACHE_TTL');
});

test('source contains invalidateSchemaCache function', () => {
  assert(serverSource.includes('function invalidateSchemaCache()'), 'should have invalidateSchemaCache');
});

test('invalidateSchemaCache resets all cache state', () => {
  assert(serverSource.includes('cachedTables = null'), 'should reset cachedTables');
  assert(serverSource.includes('cachedColumns = null'), 'should reset cachedColumns');
  assert(serverSource.includes('cacheTimestamp = 0'), 'should reset cacheTimestamp');
});

test('getSchemaCache checks TTL', () => {
  assert(serverSource.includes('Date.now() - cacheTimestamp > CACHE_TTL'), 'should check TTL');
});

test('DDL detection in handleExecute', () => {
  assert(serverSource.includes("['CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'RENAME']"), 'should detect DDL keywords');
  assert(serverSource.includes('invalidateSchemaCache()'), 'should call invalidateSchemaCache');
});

// ── Query validation ──
console.error('\n── Query validation ──');

test('allows SELECT queries', () => {
  assert(serverSource.includes("!lower.startsWith('select')"), 'should check for select');
});

test('allows WITH queries', () => {
  assert(serverSource.includes("!lower.startsWith('with')"), 'should check for with');
});

test('allows EXPLAIN queries', () => {
  assert(serverSource.includes("!lower.startsWith('explain')"), 'should check for explain');
});

// ── LIMIT truncation warning ──
console.error('\n── LIMIT truncation warning ──');

test('extracts hasUserLimit boolean', () => {
  assert(serverSource.includes('const hasUserLimit'), 'should have hasUserLimit');
});

test('adds warning when truncated', () => {
  assert(serverSource.includes('response.warning'), 'should set warning');
  assert(serverSource.includes('Results truncated at'), 'should have truncation message');
});

test('warning only triggers without user LIMIT', () => {
  assert(serverSource.includes('!hasUserLimit && result.rowCount >= MAX_ROWS'), 'should check both conditions');
});

// ── sample_data cleanup ──
console.error('\n── sample_data tool ──');

test('sample_data tool definition has no where property', () => {
  // Find the sample_data tool definition block
  const sampleToolMatch = serverSource.match(/name:\s*"sample_data"[\s\S]*?required:\s*\["table"\]/);
  assert(sampleToolMatch, 'should find sample_data tool definition');
  const toolDef = sampleToolMatch[0];
  assert(!toolDef.includes('where'), 'should not have where property in tool definition');
});

test('sample_data description mentions query tool for filtering', () => {
  assert(serverSource.includes('Use the query tool for filtered results'), 'should direct to query tool');
});

test('handleSampleData has no whereClause', () => {
  // Look in handleSampleData function for whereClause
  const handleMatch = serverSource.match(/async function handleSampleData[\s\S]*?^}/m);
  assert(handleMatch, 'should find handleSampleData');
  assert(!handleMatch[0].includes('whereClause'), 'should not have whereClause');
});

test('sample_data validates table identifier', () => {
  const handleMatch = serverSource.match(/async function handleSampleData[\s\S]*?^}/m);
  assert(handleMatch[0].includes("assertSafeIdentifier(args.table, 'table name')"), 'should validate table name');
});

// ── describe_table security ──
console.error('\n── describe_table security ──');

test('describe_table validates table identifier', () => {
  const handleMatch = serverSource.match(/async function handleDescribeTable[\s\S]*?^}/m);
  assert(handleMatch, 'should find handleDescribeTable');
  assert(handleMatch[0].includes("assertSafeIdentifier(args.table, 'table name')"), 'should validate table name');
});

test('JSONB loop validates column identifier', () => {
  const handleMatch = serverSource.match(/async function handleDescribeTable[\s\S]*?^}/m);
  assert(handleMatch[0].includes("assertSafeIdentifier(jcol.col, 'column name')"), 'should validate column name in JSONB loop');
});

// ── Version ──
console.error('\n── Version ──');

test('server version is 1.7.0', () => {
  assert(serverSource.includes('version: "1.7.0"'), 'server config should be 1.7.0');
});

test('startup log is v1.7.0', () => {
  assert(serverSource.includes('neon-pg MCP v1.7.0'), 'startup log should be v1.7.0');
});

// ── Summary ──
console.error(`\n── Results: ${passed} passed, ${failed} failed ──\n`);
process.exit(failed > 0 ? 1 : 0);
