import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ErrorCode,
  McpError
} from "@modelcontextprotocol/sdk/types.js";
import pg from 'pg';

const CONNECTION_STRING = process.env.NEON_PG_CONNECTION_STRING;
if (!CONNECTION_STRING) {
  throw new Error('NEON_PG_CONNECTION_STRING environment variable is required');
}

const MAX_ROWS = 100;
const QUERY_TIMEOUT = 30000;
const RESOURCE_PAGE_SIZE = 100;
const JSON_SCHEMA_URI = "https://json-schema.org/draft/2020-12/schema";
const JSON_MIME_TYPE = "application/json";

const GENERIC_OBJECT_SCHEMA = {
  type: "object",
  additionalProperties: true
};

const QUERY_RESULT_SCHEMA = {
  $schema: JSON_SCHEMA_URI,
  type: "object",
  additionalProperties: false,
  properties: {
    rowCount: { type: "integer" },
    rows: { type: "array", items: GENERIC_OBJECT_SCHEMA },
    fields: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          dataTypeID: { type: "number" }
        },
        required: ["name", "dataTypeID"]
      }
    },
    warning: { type: "string" }
  },
  required: ["rowCount", "rows", "fields"]
};

const EXECUTE_RESULT_SCHEMA = {
  $schema: JSON_SCHEMA_URI,
  type: "object",
  additionalProperties: false,
  properties: {
    command: { type: "string" },
    rowCount: { type: "integer" }
  },
  required: ["command", "rowCount"]
};

const TABLES_RESULT_SCHEMA = {
  $schema: JSON_SCHEMA_URI,
  type: "object",
  additionalProperties: false,
  properties: {
    tables: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          table_name: { type: "string" },
          size: { type: "string" },
          cols: { type: ["number", "string"] }
        },
        required: ["table_name", "size", "cols"]
      }
    }
  },
  required: ["tables"]
};

const SCHEMA_OVERVIEW_RESULT_SCHEMA = {
  $schema: JSON_SCHEMA_URI,
  type: "object",
  additionalProperties: false,
  properties: {
    tables: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          size: { type: "string" },
          rows: { type: "number" },
          columns: { type: "number" },
          comment: { type: "string" }
        },
        required: ["name", "size", "rows", "columns"]
      }
    },
    pagination: {
      type: "object",
      additionalProperties: false,
      properties: {
        returned: { type: "number" },
        total: { type: "number" },
        offset: { type: "number" },
        limit: { type: "number" },
        has_more: { type: "boolean" }
      },
      required: ["returned", "total", "offset", "limit", "has_more"]
    },
    note: { type: "string" }
  },
  required: ["tables", "pagination"]
};

const TABLE_SCHEMA_RESULT_SCHEMA = {
  $schema: JSON_SCHEMA_URI,
  type: "object",
  additionalProperties: false,
  properties: {
    table: { type: "string" },
    columns: { type: "array", items: GENERIC_OBJECT_SCHEMA },
    primaryKeys: { type: "array", items: { type: "string" } },
    size: { type: "string" },
    rowEstimate: { type: ["number", "string"] },
    foreignKeys: { type: "array", items: GENERIC_OBJECT_SCHEMA },
    indexes: { type: "array", items: { type: "string" } },
    enums: GENERIC_OBJECT_SCHEMA,
    jsonbKeys: GENERIC_OBJECT_SCHEMA
  },
  required: ["table", "columns", "primaryKeys", "size", "rowEstimate"]
};

const SAMPLE_DATA_RESULT_SCHEMA = {
  $schema: JSON_SCHEMA_URI,
  type: "object",
  additionalProperties: false,
  properties: {
    table: { type: "string" },
    rowCount: { type: "integer" },
    rows: { type: "array", items: GENERIC_OBJECT_SCHEMA },
    jsonb_structures: GENERIC_OBJECT_SCHEMA
  },
  required: ["table", "rowCount", "rows"]
};

const SEARCH_SCHEMA_RESULT_SCHEMA = {
  $schema: JSON_SCHEMA_URI,
  type: "object",
  additionalProperties: false,
  properties: {
    pattern: { type: "string" },
    matching_tables: { type: "array", items: { type: "string" } },
    matching_columns: { type: "array", items: { type: "string" } }
  },
  required: ["pattern", "matching_tables", "matching_columns"]
};

// Helper: Calculate Levenshtein distance for fuzzy matching
function levenshtein(a, b) {
  const matrix = Array(b.length + 1).fill(null).map(() => Array(a.length + 1).fill(null));
  for (let i = 0; i <= a.length; i++) matrix[0][i] = i;
  for (let j = 0; j <= b.length; j++) matrix[j][0] = j;
  for (let j = 1; j <= b.length; j++) {
    for (let i = 1; i <= a.length; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[j][i] = Math.min(matrix[j][i - 1] + 1, matrix[j - 1][i] + 1, matrix[j - 1][i - 1] + cost);
    }
  }
  return matrix[b.length][a.length];
}

// Helper: Find similar names from a list
function findSimilar(target, candidates, maxDistance = 3) {
  target = target.toLowerCase();
  return candidates
    .map(c => ({ name: c, distance: levenshtein(target, c.toLowerCase()) }))
    .filter(c => c.distance <= maxDistance && c.distance > 0)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 5)
    .map(c => c.name);
}

// Helper: Validate identifier is safe for SQL interpolation
const SAFE_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
function assertSafeIdentifier(name, kind = 'identifier') {
  if (!SAFE_IDENTIFIER.test(name)) {
    throw new McpError(ErrorCode.InvalidParams, `Invalid ${kind}: "${name}" contains unsafe characters`);
  }
}

function encodeCursor(offset) {
  return Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64');
}

function decodeCursor(cursor) {
  if (!cursor) return 0;

  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8'));
    if (!Number.isInteger(parsed.offset) || parsed.offset < 0) {
      throw new Error('offset must be a non-negative integer');
    }
    return parsed.offset;
  } catch (error) {
    throw new McpError(ErrorCode.InvalidParams, `Invalid cursor: ${error.message}`);
  }
}

function createStructuredToolResult(data, extras = {}) {
  return {
    content: [{
      type: "text",
      text: JSON.stringify(data, null, 2)
    }],
    structuredContent: data,
    ...extras
  };
}

function createToolErrorResult(message, structuredContent) {
  const result = {
    content: [{
      type: "text",
      text: message
    }],
    isError: true
  };

  if (structuredContent !== undefined) {
    result.structuredContent = structuredContent;
  }

  return result;
}

function createJsonResource(uri, data) {
  return {
    contents: [{
      uri,
      mimeType: JSON_MIME_TYPE,
      text: JSON.stringify(data, null, 2)
    }]
  };
}

// Helper: Get all table names (cached for error suggestions)
let cachedTables = null;
let cachedColumns = null;
let cacheTimestamp = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

let latestQueryResource = {
  status: "empty",
  message: "Run the query tool to populate this resource."
};

let latestExplainResource = {
  status: "empty",
  message: "Run an EXPLAIN query with the query tool to populate this resource."
};

function invalidateSchemaCache() {
  cachedTables = null;
  cachedColumns = null;
  cacheTimestamp = 0;
}

async function getSchemaCache() {
  if (!cachedTables || Date.now() - cacheTimestamp > CACHE_TTL) {
    const tablesResult = await pool.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `);
    cachedTables = tablesResult.rows.map(r => r.table_name);

    const columnsResult = await pool.query(`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public'
    `);
    cachedColumns = columnsResult.rows;
    cacheTimestamp = Date.now();
  }
  return { tables: cachedTables, columns: cachedColumns };
}

// Helper: Parse PostgreSQL error and add suggestions
async function enhanceError(error, sql) {
  const msg = error.message || '';
  const { tables, columns } = await getSchemaCache();

  // Column not found
  let match = msg.match(/column "([^"]+)" does not exist/i);
  if (match) {
    const badCol = match[1];
    // Try to find the table from the SQL
    const tableMatch = sql.match(/from\s+([a-z_][a-z0-9_]*)/i) || sql.match(/update\s+([a-z_][a-z0-9_]*)/i);
    const tableName = tableMatch ? tableMatch[1] : null;

    let suggestions = [];
    if (tableName) {
      const tableCols = columns.filter(c => c.table_name === tableName).map(c => c.column_name);
      suggestions = findSimilar(badCol, tableCols);
      return `Column "${badCol}" does not exist in table "${tableName}"\n\nDid you mean: ${suggestions.length > 0 ? suggestions.join(', ') : '(no similar columns)'}\n\nAvailable columns in ${tableName}: ${tableCols.join(', ')}`;
    } else {
      // Search all columns
      const allCols = [...new Set(columns.map(c => c.column_name))];
      suggestions = findSimilar(badCol, allCols);
      return `Column "${badCol}" does not exist\n\nDid you mean: ${suggestions.length > 0 ? suggestions.join(', ') : '(no similar columns)'}`;
    }
  }

  // Table/relation not found
  match = msg.match(/relation "([^"]+)" does not exist/i);
  if (match) {
    const badTable = match[1];
    const suggestions = findSimilar(badTable, tables);
    return `Table "${badTable}" does not exist\n\nDid you mean: ${suggestions.length > 0 ? suggestions.join(', ') : '(no similar tables)'}\n\nAvailable tables: ${tables.slice(0, 20).join(', ')}${tables.length > 20 ? '...' : ''}`;
  }

  // Return original message if no enhancement
  return msg;
}

function updateLatestQueryResources({ sql, result, isExplain }) {
  const snapshot = {
    sql,
    capturedAt: new Date().toISOString(),
    result
  };

  latestQueryResource = snapshot;

  if (isExplain) {
    latestExplainResource = snapshot;
  }
}

function buildStaticResources() {
  return [
    {
      uri: "neon://schema/overview",
      name: "Schema Overview",
      description: "High-level snapshot of the current database schema.",
      mimeType: JSON_MIME_TYPE
    },
    {
      uri: "neon://session/latest-query",
      name: "Latest Query Result",
      description: "Most recent result returned by the query tool in this MCP session.",
      mimeType: JSON_MIME_TYPE
    },
    {
      uri: "neon://session/latest-explain",
      name: "Latest Query Plan",
      description: "Most recent EXPLAIN result returned by the query tool in this MCP session.",
      mimeType: JSON_MIME_TYPE
    }
  ];
}

function buildTableResources(tables) {
  return tables.flatMap(table => ([
    {
      uri: `neon://table/${encodeURIComponent(table)}/schema`,
      name: `${table} schema`,
      description: `Detailed schema for table "${table}".`,
      mimeType: JSON_MIME_TYPE
    },
    {
      uri: `neon://table/${encodeURIComponent(table)}/sample`,
      name: `${table} sample`,
      description: `Sample rows and inferred JSON structure for table "${table}".`,
      mimeType: JSON_MIME_TYPE
    }
  ]));
}

async function listResources(cursor) {
  const offset = decodeCursor(cursor);
  const { tables } = await getSchemaCache();
  const resources = [...buildStaticResources(), ...buildTableResources(tables)];
  const page = resources.slice(offset, offset + RESOURCE_PAGE_SIZE);
  const nextOffset = offset + page.length;

  return {
    resources: page,
    ...(nextOffset < resources.length ? { nextCursor: encodeCursor(nextOffset) } : {})
  };
}

function requirePromptArg(args, key) {
  const value = args?.[key];
  if (!value || typeof value !== 'string') {
    throw new McpError(ErrorCode.InvalidParams, `Prompt argument "${key}" is required`);
  }
  return value;
}

function promptTextMessage(text) {
  return {
    role: "user",
    content: {
      type: "text",
      text
    }
  };
}

function getPrompt(name, args = {}) {
  switch (name) {
    case "understand_schema":
      return {
        description: "Orient yourself to the LineCrush database before writing queries.",
        messages: [
          promptTextMessage(`You are working with the LineCrush database in Neon Postgres.

Start by building a live mental model from the database itself instead of assuming the schema from memory.

Follow this workflow:
1. Run \`get_schema\` first to see the current high-level schema overview and the largest or most important tables.
2. Use \`search_schema\` to find tables related to the current product surface or concept you care about.
3. Use \`describe_table\` on the most relevant tables to inspect columns, enums, foreign keys, indexes, and JSONB key structures.
4. Use \`sample_data\` to inspect real row shapes and values before writing complex queries.
5. Summarize the key relationships, major product surfaces, and likely source-of-truth tables before proceeding.

Important LineCrush context:
- Product surfaces often include picks, vibe bet generation, sonar, games, users, players, videos, x/twitter ingestion, bot analysis, and odds pipelines.
- Sport names are usually uppercase strings like NBA, NFL, MLB, NHL, MMA, BKFC, PGA, EPL, Boxing, Tennis, F1, WNBA, and NASCAR.
- Large tables should be filtered aggressively; avoid broad \`SELECT *\` queries on huge event or odds tables.
- JSONB columns are common, especially for odds, reports, and analysis payloads, so inspect JSONB keys before filtering.

Use the tools to discover the current truth, then explain the schema in plain language.`)
        ]
      };
    case "investigate_product_surface": {
      const surfaceName = requirePromptArg(args, "surface_name");
      return {
        description: `Investigate how the ${surfaceName} surface works in the LineCrush database.`,
        messages: [
          promptTextMessage(`Investigate the LineCrush product surface "${surfaceName}" using the live database schema.

Do this in order:
1. Use \`search_schema\` to find all tables whose names or columns seem related to "${surfaceName}".
2. From those matches, identify the likely core tables and run \`describe_table\` on each.
3. Run \`sample_data\` on the most important tables to understand row shape and domain meaning.
4. Map the data flow:
   - where records are created
   - which tables reference each other
   - which columns likely drive frontend behavior, alerts, generation, grading, ingestion, or user state
5. Call out heavy JSONB columns, enums, foreign keys, and large tables that need careful filtering.
6. Summarize:
   - what this surface does in the product
   - which tables are central
   - which tables are upstream/downstream
   - what an engineer should know before changing it

Use live schema discovery, not assumptions. If the surface touches multiple systems like scraping, generation, grading, odds, or frontend delivery, explain how they connect.`)
        ]
      };
    }
    case "explore_table": {
      const tableName = requirePromptArg(args, "table_name");
      return {
        description: `Explore the ${tableName} table in depth.`,
        messages: [
          promptTextMessage(`Explore the table "${tableName}" in the LineCrush database. Do this in order:

1. Run \`describe_table\` for "${tableName}" to inspect columns, types, foreign keys, indexes, enums, and JSONB key structures.
2. Run \`sample_data\` for "${tableName}" to inspect real row shapes and actual values.
3. Identify and call out:
   - JSONB columns and the keys they contain
   - enum columns and allowed values
   - foreign key relationships
   - fields with important domain meaning
4. Explain what this table appears to represent in the product and how it connects to nearby systems.
5. If it seems central, mention which other tables should be inspected next.

Focus on practical understanding, not just column listing.`)
        ]
      };
    }
    case "investigate_query_error": {
      const failingSql = requirePromptArg(args, "failing_sql");
      const errorMessage = args.error_message || "No error message provided.";
      return {
        description: "Debug a failing or unexpected SQL query against the LineCrush database.",
        messages: [
          promptTextMessage(`A SQL query against the LineCrush database is failing or returning unexpected results.

Failing SQL:
\`\`\`sql
${failingSql}
\`\`\`

Error message:
${errorMessage}

Investigate using this workflow:
1. Parse the query and identify all referenced tables, joins, filters, and columns.
2. Use \`search_schema\` to confirm the referenced tables and discover similarly named alternatives if needed.
3. Use \`describe_table\` on each relevant table to verify column names, data types, nullability, enums, foreign keys, and JSONB structures.
4. Check for common LineCrush issues:
   - the field is inside JSONB rather than top-level
   - the table or column name is slightly different than expected
   - sport values need uppercase strings
   - user identifiers differ across tables
   - large odds or event tables need strong filters
5. Rewrite the query with the correct schema assumptions.
6. Test the corrected query and explain the fix clearly.

Use the database tools to prove the fix rather than guessing.`)
        ]
      };
    }
    case "trace_data_pipeline": {
      const pipelineName = requirePromptArg(args, "pipeline_name");
      return {
        description: `Trace the ${pipelineName} data pipeline through the LineCrush database.`,
        messages: [
          promptTextMessage(`Trace the LineCrush data pipeline "${pipelineName}" through the database.

Goal: explain how data moves from upstream ingestion or generation to downstream product behavior.

Workflow:
1. Use \`search_schema\` to identify all likely tables involved in "${pipelineName}".
2. Use \`describe_table\` on the most relevant tables to inspect keys, timestamps, enums, JSONB payloads, and relationships.
3. Use \`sample_data\` where needed to inspect actual row shapes and lifecycle clues.
4. Determine:
   - where data first enters the system
   - which tables transform or enrich it
   - which tables power user-facing features
   - which timestamps or status columns indicate lifecycle state
5. Summarize the pipeline as a step-by-step flow and note likely failure points, stale-data risks, or places where filtering matters.

Be concrete and trace actual tables, not just abstract concepts.`)
        ]
      };
    }
    default:
      throw new McpError(ErrorCode.MethodNotFound, `Unknown prompt: ${name}`);
  }
}

// Helper: Recursively extract JSONB structure with types
function extractJsonStructure(obj, maxDepth = 5, currentDepth = 0) {
  if (currentDepth >= maxDepth) return '...';
  if (obj === null) return 'null';
  if (Array.isArray(obj)) {
    if (obj.length === 0) return '[]';
    // Sample first element to show array item structure
    const itemStructure = extractJsonStructure(obj[0], maxDepth, currentDepth + 1);
    return [itemStructure];
  }
  if (typeof obj === 'object') {
    const structure = {};
    for (const [key, value] of Object.entries(obj)) {
      structure[key] = extractJsonStructure(value, maxDepth, currentDepth + 1);
    }
    return structure;
  }
  return typeof obj;
}

const pool = new pg.Pool({
  connectionString: CONNECTION_STRING,
  ssl: { rejectUnauthorized: true },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

const server = new Server(
  { name: "neon-pg", version: "1.7.0" },
  { capabilities: { tools: {}, resources: {}, prompts: {} } }
);

// Tool definitions - 7 tools
const TOOLS = [
  {
    name: "query",
    description: "Execute a SQL SELECT query and return the results",
    inputSchema: {
      $schema: JSON_SCHEMA_URI,
      type: "object",
      additionalProperties: false,
      properties: {
        sql: { type: "string", description: "SQL SELECT query to execute" },
        params: {
          type: "array",
          description: "Query parameters (optional)",
          items: {
            anyOf: [
              { type: "string" },
              { type: "number" },
              { type: "boolean" },
              { type: "null" },
              { type: "object" },
              { type: "array" }
            ]
          }
        }
      },
      required: ["sql"]
    },
    outputSchema: QUERY_RESULT_SCHEMA
  },
  {
    name: "execute",
    description: "Execute a SQL statement that modifies data (INSERT, UPDATE, DELETE)",
    inputSchema: {
      $schema: JSON_SCHEMA_URI,
      type: "object",
      additionalProperties: false,
      properties: {
        sql: { type: "string", description: "SQL statement to execute" },
        params: {
          type: "array",
          description: "Statement parameters (optional)",
          items: {
            anyOf: [
              { type: "string" },
              { type: "number" },
              { type: "boolean" },
              { type: "null" },
              { type: "object" },
              { type: "array" }
            ]
          }
        }
      },
      required: ["sql"]
    },
    outputSchema: EXECUTE_RESULT_SCHEMA
  },
  {
    name: "get_tables",
    description: "Get a list of tables in the database",
    inputSchema: {
      $schema: JSON_SCHEMA_URI,
      type: "object",
      additionalProperties: false
    },
    outputSchema: TABLES_RESULT_SCHEMA
  },
  {
    name: "get_schema",
    description: "Get database schema - tables, columns, types, keys, and JSON structures. By default excludes backup/archive tables and limits to 50 tables ordered by size. Use this FIRST to avoid column/table name errors.",
    inputSchema: {
      $schema: JSON_SCHEMA_URI,
      type: "object",
      additionalProperties: false,
      properties: {
        tables: { type: "array", items: { type: "string" }, description: "Specific tables to include (overrides limit/offset)" },
        limit: { type: "number", description: "Max tables to return (default 50, max 200)" },
        offset: { type: "number", description: "Skip first N tables for pagination (default 0)" },
        include_all: { type: "boolean", description: "Include backup/archive tables (default false)" }
      }
    },
    outputSchema: SCHEMA_OVERVIEW_RESULT_SCHEMA
  },
  {
    name: "describe_table",
    description: "Get structure information about a specific table",
    inputSchema: {
      $schema: JSON_SCHEMA_URI,
      type: "object",
      additionalProperties: false,
      properties: {
        table: { type: "string", description: "Name of the table to describe" }
      },
      required: ["table"]
    },
    outputSchema: TABLE_SCHEMA_RESULT_SCHEMA
  },
  {
    name: "sample_data",
    description: "Get sample rows from a table to see actual data format, JSON structures, and real values. Use the query tool for filtered results.",
    inputSchema: {
      $schema: JSON_SCHEMA_URI,
      type: "object",
      additionalProperties: false,
      properties: {
        table: { type: "string", description: "Table name to sample from" },
        limit: { type: "number", description: "Number of rows to return (default 3, max 10)" }
      },
      required: ["table"]
    },
    outputSchema: SAMPLE_DATA_RESULT_SCHEMA
  },
  {
    name: "search_schema",
    description: "Search for tables and columns by name pattern. Use when you know the concept but not exact name.",
    inputSchema: {
      $schema: JSON_SCHEMA_URI,
      type: "object",
      additionalProperties: false,
      properties: {
        pattern: { type: "string", description: "Search pattern (case-insensitive, searches table and column names)" }
      },
      required: ["pattern"]
    },
    outputSchema: SEARCH_SCHEMA_RESULT_SCHEMA
  }
];

const PROMPTS = [
  {
    name: "understand_schema",
    description: "Understand the LineCrush database at a high level before writing queries."
  },
  {
    name: "investigate_product_surface",
    description: "Trace how a specific LineCrush product surface works in the database.",
    arguments: [
      {
        name: "surface_name",
        description: "The LineCrush surface to investigate, such as picks, sonar, games, users, players, videos, x_scraper, or vibe_bet_generator.",
        required: true
      }
    ]
  },
  {
    name: "explore_table",
    description: "Deep-dive into a specific LineCrush table — structure, sample data, and relationships.",
    arguments: [
      {
        name: "table_name",
        description: "The table to explore.",
        required: true
      }
    ]
  },
  {
    name: "investigate_query_error",
    description: "Debug a failing or unexpected SQL query against the LineCrush database.",
    arguments: [
      {
        name: "failing_sql",
        description: "The SQL query that failed or returned unexpected results.",
        required: true
      },
      {
        name: "error_message",
        description: "The error message if the query failed.",
        required: false
      }
    ]
  },
  {
    name: "trace_data_pipeline",
    description: "Follow how data moves through a specific LineCrush ingestion or product pipeline.",
    arguments: [
      {
        name: "pipeline_name",
        description: "The pipeline to trace, such as vibe_reports_to_vibe_bets, x_tweets_to_bot_analysis, or odds_feed_to_sonar.",
        required: true
      }
    ]
  }
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
  return await listResources(request.params?.cursor);
});
server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: PROMPTS }));
server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
  resourceTemplates: [
    {
      uriTemplate: "neon://table/{table}/schema",
      name: "Table Schema",
      description: "Read the schema for a specific table.",
      mimeType: JSON_MIME_TYPE
    },
    {
      uriTemplate: "neon://table/{table}/sample",
      name: "Table Sample Data",
      description: "Read sample rows and inferred JSON structure for a specific table.",
      mimeType: JSON_MIME_TYPE
    },
    {
      uriTemplate: "neon://table/{table}/sample/{limit}",
      name: "Table Sample Data With Limit",
      description: "Read sample rows for a specific table with an explicit sample size.",
      mimeType: JSON_MIME_TYPE
    }
  ]
}));
server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  return getPrompt(name, args);
});
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;
  const parsed = new URL(uri);

  if (parsed.protocol !== 'neon:') {
    throw new McpError(ErrorCode.InvalidParams, `Unsupported resource URI: ${uri}`);
  }

  if (parsed.hostname === 'schema' && parsed.pathname === '/overview') {
    return createJsonResource(uri, await getSchemaOverview({}));
  }

  if (parsed.hostname === 'session' && parsed.pathname === '/latest-query') {
    return createJsonResource(uri, latestQueryResource);
  }

  if (parsed.hostname === 'session' && parsed.pathname === '/latest-explain') {
    return createJsonResource(uri, latestExplainResource);
  }

  if (parsed.hostname === 'table') {
    const pathParts = parsed.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const [table, resourceType, rawLimit] = pathParts;

    if (!table || !resourceType) {
      throw new McpError(ErrorCode.InvalidParams, `Invalid table resource URI: ${uri}`);
    }

    if (resourceType === 'schema') {
      return createJsonResource(uri, await getTableDescription(table));
    }

    if (resourceType === 'sample') {
      const limit = rawLimit === undefined ? undefined : Number(rawLimit);
      if (rawLimit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
        throw new McpError(ErrorCode.InvalidParams, `Invalid sample limit in resource URI: ${uri}`);
      }

      return createJsonResource(uri, await getSampleData(table, limit));
    }
  }

  throw new McpError(ErrorCode.InvalidParams, `Unknown resource URI: ${uri}`);
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  switch (name) {
    case "query": return await handleQuery(args);
    case "execute": return await handleExecute(args);
    case "get_tables": return await handleGetTables();
    case "get_schema": return await handleGetSchema(args);
    case "describe_table": return await handleDescribeTable(args);
    case "sample_data": return await handleSampleData(args);
    case "search_schema": return await handleSearchSchema(args);
    default: throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
  }
});

async function handleQuery(args) {
  if (!args.sql) throw new McpError(ErrorCode.InvalidParams, "sql required");

  const lower = args.sql.trim().toLowerCase();
  if (!lower.startsWith('select') && !lower.startsWith('with') && !lower.startsWith('explain')) {
    throw new McpError(ErrorCode.InvalidParams, "Use SELECT, WITH, or EXPLAIN queries only");
  }

  const hasUserLimit = lower.startsWith('explain') || lower.includes(' limit ');
  const sql = hasUserLimit ? args.sql : `${args.sql} LIMIT ${MAX_ROWS}`;

  try {
    const result = await pool.query({ text: sql, values: args.params || [], statement_timeout: QUERY_TIMEOUT });

    const response = {
      rowCount: result.rowCount,
      rows: result.rows,
      fields: result.fields.map(f => ({ name: f.name, dataTypeID: f.dataTypeID }))
    };

    if (!hasUserLimit && result.rowCount >= MAX_ROWS) {
      response.warning = `Results truncated at ${MAX_ROWS} rows. Add an explicit LIMIT clause or use WHERE to narrow results.`;
    }

    updateLatestQueryResources({
      sql: args.sql,
      result: response,
      isExplain: lower.startsWith('explain')
    });

    return createStructuredToolResult(response);
  } catch (error) {
    const enhanced = await enhanceError(error, args.sql);
    return createToolErrorResult(enhanced, { error: enhanced, sql: args.sql });
  }
}

async function handleExecute(args) {
  if (!args.sql) throw new McpError(ErrorCode.InvalidParams, "sql required");

  if (args.sql.trim().toLowerCase().startsWith('select')) {
    throw new McpError(ErrorCode.InvalidParams, "Use query tool for SELECT");
  }

  try {
    const result = await pool.query({ text: args.sql, values: args.params || [], statement_timeout: QUERY_TIMEOUT });

    // Invalidate schema cache on DDL statements
    const firstWord = args.sql.trim().split(/\s+/)[0].toUpperCase();
    if (['CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'RENAME'].includes(firstWord)) {
      invalidateSchemaCache();
    }

    return createStructuredToolResult({
      command: result.command,
      rowCount: result.rowCount
    });
  } catch (error) {
    const enhanced = await enhanceError(error, args.sql);
    return createToolErrorResult(enhanced, { error: enhanced, sql: args.sql });
  }
}

async function handleGetTables() {
  return createStructuredToolResult(await getTablesSummary());
}

async function getTablesSummary() {
  const result = await pool.query(`
    SELECT t.table_name,
           pg_size_pretty(pg_total_relation_size(quote_ident(t.table_name))) as size,
           (SELECT count(*) FROM information_schema.columns c
            WHERE c.table_name = t.table_name AND c.table_schema = 'public') as cols
    FROM information_schema.tables t
    WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
    ORDER BY t.table_name
  `);

  return { tables: result.rows };
}

async function handleGetSchema(args) {
  return createStructuredToolResult(await getSchemaOverview(args));
}

async function getSchemaOverview(args) {
  // Build exclusion clause for backup/archive tables
  const includeAll = args.include_all === true;
  const excludeClause = includeAll ? '' : `
    AND c.relname NOT LIKE '%_backup%'
    AND c.relname NOT LIKE '%_archive%'
    AND c.relname NOT LIKE '%_bak_%'
    AND c.relname NOT LIKE '%_old_%'
    AND c.relname !~ '_\\d{6,8}$'
  `;

  // Specific tables override limit/offset
  const hasSpecificTables = args.tables?.length > 0;
  const tableFilter = hasSpecificTables ? `AND c.relname = ANY($1)` : '';

  // Pagination
  const limit = hasSpecificTables ? 200 : Math.min(Math.max(1, args.limit || 50), 200);
  const offset = hasSpecificTables ? 0 : Math.max(0, args.offset || 0);

  const query = `
    SELECT
      c.relname as table_name,
      pg_size_pretty(pg_total_relation_size(c.oid)) as size,
      pg_total_relation_size(c.oid) as size_bytes,
      c.reltuples::bigint as row_estimate,
      obj_description(c.oid) as comment,
      (SELECT count(*) FROM information_schema.columns ic
       WHERE ic.table_name = c.relname AND ic.table_schema = 'public') as col_count
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      ${tableFilter}
      ${excludeClause}
    ORDER BY pg_total_relation_size(c.oid) DESC
    LIMIT ${limit} OFFSET ${offset}
  `;

  const params = hasSpecificTables ? [args.tables] : [];
  const result = await pool.query(query, params);

  // Get total count for pagination info
  const countQuery = `
    SELECT count(*) as total
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
    ${excludeClause}
  `;
  const countResult = await pool.query(countQuery);
  const totalTables = parseInt(countResult.rows[0].total);

  // Build structured output
  const tables = result.rows.map(row => {
    const table = {
      name: row.table_name,
      size: row.size,
      rows: row.row_estimate,
      columns: parseInt(row.col_count)
    };
    if (row.comment) table.comment = row.comment;
    return table;
  });

  const output = {
    tables,
    pagination: {
      returned: tables.length,
      total: totalTables,
      offset,
      limit,
      has_more: offset + tables.length < totalTables
    }
  };

  if (!includeAll) {
    output.note = "Backup/archive tables excluded. Use include_all:true to see all.";
  }

  return output;
}

async function handleDescribeTable(args) {
  if (!args.table) throw new McpError(ErrorCode.InvalidParams, "table required");
  return createStructuredToolResult(await getTableDescription(args.table));
}

async function getTableDescription(tableName) {
  if (!tableName) throw new McpError(ErrorCode.InvalidParams, "table required");
  assertSafeIdentifier(tableName, 'table name');

  const [cols, pks, fks, idxs, stats] = await Promise.all([
    // Get columns with enum type names
    pool.query(`
      SELECT
        c.column_name as col,
        c.data_type as type,
        c.udt_name as udt,
        c.is_nullable as nullable,
        c.column_default as default
      FROM information_schema.columns c
      WHERE c.table_schema = 'public' AND c.table_name = $1
      ORDER BY c.ordinal_position
    `, [tableName]),

    pool.query(`
      SELECT kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
      WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = 'public' AND tc.table_name = $1
    `, [tableName]),

    pool.query(`
      SELECT kcu.column_name as col, ccu.table_name as ref_table, ccu.column_name as ref_col
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
      JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public' AND tc.table_name = $1
    `, [tableName]),

    pool.query(`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = $1
    `, [tableName]),

    pool.query(`
      SELECT pg_size_pretty(pg_total_relation_size(quote_ident($1))) as size,
             (SELECT reltuples::bigint FROM pg_class WHERE relname = $1) as rows
    `, [tableName])
  ]);

  if (cols.rowCount === 0) {
    throw new McpError(ErrorCode.InvalidParams, `Table '${tableName}' not found`);
  }

  // Find enum columns and get their values
  const enumCols = cols.rows.filter(c => c.type === 'USER-DEFINED');
  let enums = {};

  if (enumCols.length > 0) {
    const enumNames = [...new Set(enumCols.map(c => c.udt))];
    const enumResult = await pool.query(`
      SELECT t.typname, array_agg(e.enumlabel ORDER BY e.enumsortorder) as values
      FROM pg_type t
      JOIN pg_enum e ON t.oid = e.enumtypid
      WHERE t.typname = ANY($1)
      GROUP BY t.typname
    `, [enumNames]);

    for (const row of enumResult.rows) {
      enums[row.typname] = row.values;
    }
  }

  // Get JSONB column keys (sample from first row with data)
  const jsonbCols = cols.rows.filter(c => c.type === 'jsonb');
  let jsonbKeys = {};

  for (const jcol of jsonbCols) {
    try {
      assertSafeIdentifier(jcol.col, 'column name');
      const keysResult = await pool.query(`
        SELECT DISTINCT jsonb_object_keys(${jcol.col}) as key
        FROM ${tableName}
        WHERE ${jcol.col} IS NOT NULL
        LIMIT 15
      `);
      if (keysResult.rows.length > 0) {
        jsonbKeys[jcol.col] = keysResult.rows.map(r => r.key);
      }
    } catch (e) {
      // Column might have non-object jsonb, skip
    }
  }

  // Clean up column output
  const columns = cols.rows.map(c => {
    const col = { col: c.col, type: c.type, nullable: c.nullable };
    if (c.default) col.default = c.default;
    if (c.type === 'USER-DEFINED') col.enumType = c.udt;
    return col;
  });

  const result = {
    table: tableName,
    columns,
    primaryKeys: pks.rows.map(r => r.column_name),
    size: stats.rows[0]?.size,
    rowEstimate: stats.rows[0]?.rows || 0
  };

  // Only include if non-empty
  if (fks.rows.length > 0) result.foreignKeys = fks.rows;
  if (idxs.rows.length > 0) result.indexes = idxs.rows.map(i => i.indexname);
  if (Object.keys(enums).length > 0) result.enums = enums;
  if (Object.keys(jsonbKeys).length > 0) result.jsonbKeys = jsonbKeys;

  return result;
}

async function handleSampleData(args) {
  if (!args.table) throw new McpError(ErrorCode.InvalidParams, "table required");
  return createStructuredToolResult(await getSampleData(args.table, args.limit));
}

async function getSampleData(tableName, requestedLimit) {
  const { tables } = await getSchemaCache();
  if (!tables.includes(tableName)) {
    const suggestions = findSimilar(tableName, tables);
    throw new McpError(ErrorCode.InvalidParams,
      `Table "${tableName}" not found\n\nDid you mean: ${suggestions.length > 0 ? suggestions.join(', ') : '(no similar tables)'}`);
  }

  assertSafeIdentifier(tableName, 'table name');

  const limit = Math.min(Math.max(1, requestedLimit || 3), 10);

  try {
    const result = await pool.query(`
      SELECT * FROM ${tableName}
      LIMIT ${limit}
    `);

    // For each JSONB column, extract structure from the results
    const jsonbStructures = {};
    if (result.rows.length > 0) {
      const firstRow = result.rows[0];
      for (const [key, value] of Object.entries(firstRow)) {
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
          // Check if this looks like a JSON object (not a Date or other special object)
          if (value.constructor === Object || Array.isArray(value)) {
            jsonbStructures[key] = extractJsonStructure(value, 6);
          }
        } else if (Array.isArray(value)) {
          jsonbStructures[key] = extractJsonStructure(value, 6);
        }
      }
    }

    const output = {
      table: tableName,
      rowCount: result.rowCount,
      rows: result.rows
    };

    if (Object.keys(jsonbStructures).length > 0) {
      output.jsonb_structures = jsonbStructures;
    }

    return output;
  } catch (error) {
    const enhanced = await enhanceError(error, `SELECT * FROM ${tableName}`);
    throw new McpError(ErrorCode.InvalidParams, enhanced);
  }
}

async function handleSearchSchema(args) {
  if (!args.pattern) throw new McpError(ErrorCode.InvalidParams, "pattern required");
  return createStructuredToolResult(await searchSchema(args.pattern));
}

async function searchSchema(rawPattern) {
  const pattern = rawPattern.toLowerCase();

  // Search tables and columns
  const result = await pool.query(`
    SELECT
      t.table_name,
      c.column_name,
      c.data_type,
      c.udt_name
    FROM information_schema.tables t
    JOIN information_schema.columns c ON t.table_name = c.table_name AND t.table_schema = c.table_schema
    WHERE t.table_schema = 'public'
      AND t.table_type = 'BASE TABLE'
      AND (
        LOWER(t.table_name) LIKE $1
        OR LOWER(c.column_name) LIKE $1
      )
    ORDER BY
      CASE WHEN LOWER(t.table_name) LIKE $1 THEN 0 ELSE 1 END,
      t.table_name,
      c.ordinal_position
  `, [`%${pattern}%`]);

  // Group results
  const matchingTables = new Set();
  const matchingColumns = [];

  for (const row of result.rows) {
    if (row.table_name.toLowerCase().includes(pattern)) {
      matchingTables.add(row.table_name);
    }
    if (row.column_name.toLowerCase().includes(pattern)) {
      let type = row.data_type === 'USER-DEFINED' ? row.udt_name : row.data_type;
      type = type.replace('character varying', 'varchar')
                 .replace('timestamp with time zone', 'timestamptz');
      matchingColumns.push(`${row.table_name}.${row.column_name}(${type})`);
    }
  }

  const output = {
    pattern: rawPattern,
    matching_tables: [...matchingTables],
    matching_columns: matchingColumns
  };

  return output;
}

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("neon-pg MCP v1.7.0");

process.on('SIGINT', async () => { await pool.end(); process.exit(0); });
process.on('SIGTERM', async () => { await pool.end(); process.exit(0); });
