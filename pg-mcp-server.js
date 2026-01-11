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

const pool = new pg.Pool({
  connectionString: CONNECTION_STRING,
  ssl: { rejectUnauthorized: true },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

const server = new Server(
  { name: "neon-pg", version: "1.3.0" },
  { capabilities: { tools: {} } }
);

// Minimal tool definitions - 4 tools only
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
    name: "describe_table",
    description: "Get structure information about a specific table",
    inputSchema: {
      type: "object",
      properties: {
        table: { type: "string", description: "Name of the table to describe" }
      },
      required: ["table"]
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
    case "describe_table": return await handleDescribeTable(args);
    default: throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
  }
});

async function handleQuery(args) {
  if (!args.sql) throw new McpError(ErrorCode.InvalidParams, "sql required");

  const lower = args.sql.trim().toLowerCase();
  if (!lower.startsWith('select') && !lower.startsWith('with')) {
    throw new McpError(ErrorCode.InvalidParams, "Use SELECT or WITH queries only");
  }

  const sql = lower.includes(' limit ') ? args.sql : `${args.sql} LIMIT ${MAX_ROWS}`;
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
}

async function handleExecute(args) {
  if (!args.sql) throw new McpError(ErrorCode.InvalidParams, "sql required");

  if (args.sql.trim().toLowerCase().startsWith('select')) {
    throw new McpError(ErrorCode.InvalidParams, "Use query tool for SELECT");
  }

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

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("neon-pg MCP v1.3.0");

process.on('SIGINT', async () => { await pool.end(); process.exit(0); });
process.on('SIGTERM', async () => { await pool.end(); process.exit(0); });
