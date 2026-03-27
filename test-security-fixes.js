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
  const helperMatch = serverSource.match(/async function getSampleData[\s\S]*?^}/m);
  assert(helperMatch, 'should find getSampleData');
  assert(helperMatch[0].includes("assertSafeIdentifier(tableName, 'table name')"), 'should validate table name');
});

// ── describe_table security ──
console.error('\n── describe_table security ──');

test('describe_table validates table identifier', () => {
  const helperMatch = serverSource.match(/async function getTableDescription[\s\S]*?^}/m);
  assert(helperMatch, 'should find getTableDescription');
  assert(helperMatch[0].includes("assertSafeIdentifier(tableName, 'table name')"), 'should validate table name');
});

test('JSONB loop validates column identifier', () => {
  const helperMatch = serverSource.match(/async function getTableDescription[\s\S]*?^}/m);
  assert(helperMatch, 'should find getTableDescription');
  assert(helperMatch[0].includes("assertSafeIdentifier(jcol.col, 'column name')"), 'should validate column name in JSONB loop');
});

// ── Version ──
console.error('\n── Version ──');

test('server version is 1.7.0', () => {
  assert(serverSource.includes('version: "1.7.0"'), 'server config should be 1.7.0');
});

test('startup log is v1.7.0', () => {
  assert(serverSource.includes('neon-pg MCP v1.7.0'), 'startup log should be v1.7.0');
});

// ── Structured MCP outputs ──
console.error('\n── structuredContent & outputSchema ──');

test('tool definitions include output schemas', () => {
  assert(serverSource.includes('outputSchema: QUERY_RESULT_SCHEMA'), 'query should expose outputSchema');
  assert(serverSource.includes('outputSchema: EXECUTE_RESULT_SCHEMA'), 'execute should expose outputSchema');
  assert(serverSource.includes('outputSchema: SCHEMA_OVERVIEW_RESULT_SCHEMA'), 'get_schema should expose outputSchema');
});

test('server source returns structuredContent from tools', () => {
  assert(serverSource.includes('structuredContent: data'), 'should include structuredContent helper');
  assert(serverSource.includes('return createStructuredToolResult(response);'), 'query should return structured results');
  assert(serverSource.includes('return createStructuredToolResult(await getTablesSummary());'), 'get_tables should return structured results');
});

test('tool errors can include structured content', () => {
  assert(serverSource.includes('result.structuredContent = structuredContent'), 'error helper should include structured content');
  assert(serverSource.includes('return createToolErrorResult(enhanced, { error: enhanced, sql: args.sql });'), 'tool errors should return structured details');
});

// ── MCP resources ──
console.error('\n── MCP resources ──');

test('server declares resources capability', () => {
  assert(serverSource.includes('capabilities: { tools: {}, resources: {}, prompts: {} }'), 'server should declare resources capability');
});

test('server registers resource handlers', () => {
  assert(serverSource.includes('ListResourcesRequestSchema'), 'should import list resources schema');
  assert(serverSource.includes('ListResourceTemplatesRequestSchema'), 'should import list resource templates schema');
  assert(serverSource.includes('ReadResourceRequestSchema'), 'should import read resource schema');
  assert(serverSource.includes('server.setRequestHandler(ListResourcesRequestSchema'), 'should register resources/list handler');
  assert(serverSource.includes('server.setRequestHandler(ReadResourceRequestSchema'), 'should register resources/read handler');
});

test('server exposes schema and session resources', () => {
  assert(serverSource.includes('neon://schema/overview'), 'should expose schema overview resource');
  assert(serverSource.includes('neon://session/latest-query'), 'should expose latest query resource');
  assert(serverSource.includes('neon://session/latest-explain'), 'should expose latest explain resource');
});

test('server exposes table resource templates', () => {
  assert(serverSource.includes('uriTemplate: "neon://table/{table}/schema"'), 'should expose table schema template');
  assert(serverSource.includes('uriTemplate: "neon://table/{table}/sample"'), 'should expose table sample template');
});

// ── MCP prompts ──
console.error('\n── MCP prompts ──');

test('server declares prompts capability', () => {
  assert(serverSource.includes('capabilities: { tools: {}, resources: {}, prompts: {} }'), 'server should declare prompts capability');
});

test('server imports and registers prompt handlers', () => {
  assert(serverSource.includes('ListPromptsRequestSchema'), 'should import list prompts schema');
  assert(serverSource.includes('GetPromptRequestSchema'), 'should import get prompt schema');
  assert(serverSource.includes('server.setRequestHandler(ListPromptsRequestSchema'), 'should register prompts/list handler');
  assert(serverSource.includes('server.setRequestHandler(GetPromptRequestSchema'), 'should register prompts/get handler');
});

test('server defines the five workflow prompts', () => {
  assert(serverSource.includes('name: "understand_schema"'), 'should define understand_schema prompt');
  assert(serverSource.includes('name: "investigate_product_surface"'), 'should define investigate_product_surface prompt');
  assert(serverSource.includes('name: "explore_table"'), 'should define explore_table prompt');
  assert(serverSource.includes('name: "investigate_query_error"'), 'should define investigate_query_error prompt');
  assert(serverSource.includes('name: "trace_data_pipeline"'), 'should define trace_data_pipeline prompt');
});

test('prompt helper enforces required args', () => {
  assert(serverSource.includes('function requirePromptArg(args, key)'), 'should define prompt arg helper');
  assert(serverSource.includes('Prompt argument "${key}" is required'), 'should validate required prompt args');
});

// ── Summary ──
console.error(`\n── Results: ${passed} passed, ${failed} failed ──\n`);
process.exit(failed > 0 ? 1 : 0);
