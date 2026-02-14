import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import pg from 'pg';

const CONNECTION_STRING = process.env.NEON_PG_CONNECTION_STRING;
if (!CONNECTION_STRING) {
  throw new Error('NEON_PG_CONNECTION_STRING environment variable is required');
}

const MAX_ROWS = 100;
const QUERY_TIMEOUT = 30000;

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

// Helper: Get all table names (cached for error suggestions)
let cachedTables = null;
let cachedColumns = null;
async function getSchemaCache() {
  if (!cachedTables) {
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
  { name: "neon-pg", version: "1.6.0" },
  { capabilities: { tools: {} } }
);

// Tool definitions - 7 tools
const TOOLS = [
  {
    name: "query",
    description: "Execute a SQL SELECT query and return the results",
    inputSchema: {
      type: "object",
      properties: {
        sql: { type: "string", description: "SQL SELECT query to execute" },
        params: { type: "array", description: "Query parameters (optional)", items: { type: "string" } }
      },
      required: ["sql"]
    }
  },
  {
    name: "execute",
    description: "Execute a SQL statement that modifies data (INSERT, UPDATE, DELETE)",
    inputSchema: {
      type: "object",
      properties: {
        sql: { type: "string", description: "SQL statement to execute" },
        params: { type: "array", description: "Statement parameters (optional)", items: { type: "string" } }
      },
      required: ["sql"]
    }
  },
  {
    name: "get_tables",
    description: "Get a list of tables in the database",
    inputSchema: { type: "object", properties: {}, required: [] }
  },
  {
    name: "get_schema",
    description: "Get database schema - tables, columns, types, keys, and JSON structures. By default excludes backup/archive tables and limits to 50 tables ordered by size. Use this FIRST to avoid column/table name errors.",
    inputSchema: {
      type: "object",
      properties: {
        tables: { type: "array", items: { type: "string" }, description: "Specific tables to include (overrides limit/offset)" },
        limit: { type: "number", description: "Max tables to return (default 50, max 200)" },
        offset: { type: "number", description: "Skip first N tables for pagination (default 0)" },
        include_all: { type: "boolean", description: "Include backup/archive tables (default false)" }
      }
    }
  },
  {
    name: "describe_table",
    description: "Get structure information about a specific table",
    inputSchema: {
      type: "object",
      properties: {
        table: { type: "string", description: "Name of the table to describe" }
      },
      required: ["table"]
    }
  },
  {
    name: "sample_data",
    description: "Get sample rows from a table to see actual data format, JSON structures, and real values",
    inputSchema: {
      type: "object",
      properties: {
        table: { type: "string", description: "Table name to sample from" },
        limit: { type: "number", description: "Number of rows to return (default 3, max 10)" },
        where: { type: "string", description: "Optional WHERE clause (without 'WHERE' keyword)" }
      },
      required: ["table"]
    }
  },
  {
    name: "search_schema",
    description: "Search for tables and columns by name pattern. Use when you know the concept but not exact name.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Search pattern (case-insensitive, searches table and column names)" }
      },
      required: ["pattern"]
    }
  }
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

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

  const sql = lower.startsWith('explain') || lower.includes(' limit ') ? args.sql : `${args.sql} LIMIT ${MAX_ROWS}`;

  try {
    const result = await pool.query({ text: sql, values: args.params || [], statement_timeout: QUERY_TIMEOUT });

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          rowCount: result.rowCount,
          rows: result.rows,
          fields: result.fields.map(f => ({ name: f.name, dataTypeID: f.dataTypeID }))
        }, null, 2)
      }]
    };
  } catch (error) {
    const enhanced = await enhanceError(error, args.sql);
    throw new McpError(ErrorCode.InvalidParams, enhanced);
  }
}

async function handleExecute(args) {
  if (!args.sql) throw new McpError(ErrorCode.InvalidParams, "sql required");

  if (args.sql.trim().toLowerCase().startsWith('select')) {
    throw new McpError(ErrorCode.InvalidParams, "Use query tool for SELECT");
  }

  try {
    const result = await pool.query({ text: args.sql, values: args.params || [], statement_timeout: QUERY_TIMEOUT });

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          command: result.command,
          rowCount: result.rowCount
        }, null, 2)
      }]
    };
  } catch (error) {
    const enhanced = await enhanceError(error, args.sql);
    throw new McpError(ErrorCode.InvalidParams, enhanced);
  }
}

async function handleGetTables() {
  const result = await pool.query(`
    SELECT t.table_name,
           pg_size_pretty(pg_total_relation_size(quote_ident(t.table_name))) as size,
           (SELECT count(*) FROM information_schema.columns c
            WHERE c.table_name = t.table_name AND c.table_schema = 'public') as cols
    FROM information_schema.tables t
    WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
    ORDER BY t.table_name
  `);

  return {
    content: [{
      type: "text",
      text: JSON.stringify({ tables: result.rows }, null, 2)
    }]
  };
}

async function handleGetSchema(args) {
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

  return {
    content: [{
      type: "text",
      text: JSON.stringify(output, null, 2)
    }]
  };
}

async function handleDescribeTable(args) {
  if (!args.table) throw new McpError(ErrorCode.InvalidParams, "table required");

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
    `, [args.table]),

    pool.query(`
      SELECT kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
      WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = 'public' AND tc.table_name = $1
    `, [args.table]),

    pool.query(`
      SELECT kcu.column_name as col, ccu.table_name as ref_table, ccu.column_name as ref_col
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
      JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public' AND tc.table_name = $1
    `, [args.table]),

    pool.query(`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = $1
    `, [args.table]),

    pool.query(`
      SELECT pg_size_pretty(pg_total_relation_size(quote_ident($1))) as size,
             (SELECT reltuples::bigint FROM pg_class WHERE relname = $1) as rows
    `, [args.table])
  ]);

  if (cols.rowCount === 0) {
    throw new McpError(ErrorCode.InvalidParams, `Table '${args.table}' not found`);
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
      const keysResult = await pool.query(`
        SELECT DISTINCT jsonb_object_keys(${jcol.col}) as key
        FROM ${args.table}
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
    table: args.table,
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

  return {
    content: [{
      type: "text",
      text: JSON.stringify(result, null, 2)
    }]
  };
}

async function handleSampleData(args) {
  if (!args.table) throw new McpError(ErrorCode.InvalidParams, "table required");

  const { tables } = await getSchemaCache();
  if (!tables.includes(args.table)) {
    const suggestions = findSimilar(args.table, tables);
    throw new McpError(ErrorCode.InvalidParams,
      `Table "${args.table}" not found\n\nDid you mean: ${suggestions.length > 0 ? suggestions.join(', ') : '(no similar tables)'}`);
  }

  const limit = Math.min(Math.max(1, args.limit || 3), 10);
  const whereClause = args.where ? `WHERE ${args.where}` : '';

  try {
    const result = await pool.query(`
      SELECT * FROM ${args.table}
      ${whereClause}
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
      table: args.table,
      rowCount: result.rowCount,
      rows: result.rows
    };

    if (Object.keys(jsonbStructures).length > 0) {
      output.jsonb_structures = jsonbStructures;
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify(output, null, 2)
      }]
    };
  } catch (error) {
    const enhanced = await enhanceError(error, `SELECT * FROM ${args.table} ${whereClause}`);
    throw new McpError(ErrorCode.InvalidParams, enhanced);
  }
}

async function handleSearchSchema(args) {
  if (!args.pattern) throw new McpError(ErrorCode.InvalidParams, "pattern required");

  const pattern = args.pattern.toLowerCase();

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
    pattern: args.pattern,
    matching_tables: [...matchingTables],
    matching_columns: matchingColumns
  };

  return {
    content: [{
      type: "text",
      text: JSON.stringify(output, null, 2)
    }]
  };
}

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("neon-pg MCP v1.6.0");

process.on('SIGINT', async () => { await pool.end(); process.exit(0); });
process.on('SIGTERM', async () => { await pool.end(); process.exit(0); });
