import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import pg from 'pg';

// Check for required environment variable
const CONNECTION_STRING = process.env.NEON_PG_CONNECTION_STRING;
if (!CONNECTION_STRING) {
  throw new Error('NEON_PG_CONNECTION_STRING environment variable is required');
}

// Initialize PostgreSQL connection pool
const pool = new pg.Pool({
  connectionString: CONNECTION_STRING,
  ssl: {
    rejectUnauthorized: true,
  },
  max: 10,
  idleTimeoutMillis: 30000
});

// Create server
const server = new Server({
  name: "neon-pg-server",
  version: "1.0.0"
}, {
  capabilities: {
    tools: {
      query: {
        name: "query",
        description: "Execute a SQL SELECT query and return the results",
        inputSchema: {
          type: "object",
          properties: {
            sql: {
              type: "string",
              description: "SQL SELECT query to execute"
            },
            params: {
              type: "array",
              description: "Query parameters (optional)",
              items: {
                type: "string"
              }
            }
          },
          required: ["sql"]
        }
      },
      execute: {
        name: "execute",
        description: "Execute a SQL statement that modifies data (INSERT, UPDATE, DELETE)",
        inputSchema: {
          type: "object",
          properties: {
            sql: {
              type: "string",
              description: "SQL statement to execute"
            },
            params: {
              type: "array",
              description: "Statement parameters (optional)",
              items: {
                type: "string"
              }
            }
          },
          required: ["sql"]
        }
      },
      get_tables: {
        name: "get_tables",
        description: "Get a list of tables in the database",
        inputSchema: {
          type: "object",
          properties: {},
          required: []
        }
      },
      describe_table: {
        name: "describe_table",
        description: "Get structure information about a specific table",
        inputSchema: {
          type: "object",
          properties: {
            table: {
              type: "string",
              description: "Name of the table to describe"
            }
          },
          required: ["table"]
        }
      }
    }
  }
});

// Handle tool listing
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "query",
        description: "Execute a SQL SELECT query and return the results",
        inputSchema: {
          type: "object",
          properties: {
            sql: {
              type: "string",
              description: "SQL SELECT query to execute"
            },
            params: {
              type: "array",
              description: "Query parameters (optional)",
              items: {
                type: "string"
              }
            }
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
            sql: {
              type: "string",
              description: "SQL statement to execute"
            },
            params: {
              type: "array",
              description: "Statement parameters (optional)",
              items: {
                type: "string"
              }
            }
          },
          required: ["sql"]
        }
      },
      {
        name: "get_tables",
        description: "Get a list of tables in the database",
        inputSchema: {
          type: "object",
          properties: {},
          required: []
        }
      },
      {
        name: "describe_table",
        description: "Get structure information about a specific table",
        inputSchema: {
          type: "object",
          properties: {
            table: {
              type: "string",
              description: "Name of the table to describe"
            }
          },
          required: ["table"]
        }
      }
    ]
  };
});

// Handle tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName = request.params.name;
  const args = request.params.arguments || {};

  if (toolName === "query") {
    return await handleQuery(args);
  } else if (toolName === "execute") {
    return await handleExecute(args);
  } else if (toolName === "get_tables") {
    return await handleGetTables();
  } else if (toolName === "describe_table") {
    return await handleDescribeTable(args);
  }

  throw new McpError(ErrorCode.MethodNotFound, "Tool not found");
});

// Query handler (SELECT only)
async function handleQuery(args) {
  if (!args.sql) {
    throw new McpError(ErrorCode.InvalidParams, "SQL query is required");
  }

  const trimmedSql = args.sql.trim().toLowerCase();
  if (!trimmedSql.startsWith('select') && !trimmedSql.startsWith('with')) {
    throw new McpError(ErrorCode.InvalidParams, "Query must be a SELECT statement or a WITH query");
  }

  try {
    const result = await pool.query(args.sql, args.params || []);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            rowCount: result.rowCount,
            rows: result.rows,
            fields: result.fields.map(f => ({
              name: f.name,
              dataTypeID: f.dataTypeID
            }))
          }, null, 2)
        }
      ]
    };
  } catch (error) {
    throw new McpError(ErrorCode.InternalError, `Database query error: ${error.message}`);
  }
}

// Execute handler (for non-SELECT statements)
async function handleExecute(args) {
  if (!args.sql) {
    throw new McpError(ErrorCode.InvalidParams, "SQL statement is required");
  }

  const trimmedSql = args.sql.trim().toLowerCase();
  if (trimmedSql.startsWith('select')) {
    throw new McpError(ErrorCode.InvalidParams, "Execute should not be used for SELECT statements. Use query instead");
  }

  try {
    const result = await pool.query(args.sql, args.params || []);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            command: result.command,
            rowCount: result.rowCount,
            oid: result.oid
          }, null, 2)
        }
      ]
    };
  } catch (error) {
    throw new McpError(ErrorCode.InternalError, `Database execute error: ${error.message}`);
  }
}

// Get tables handler
async function handleGetTables() {
  try {
    const sql = `
      SELECT
        table_name
      FROM
        information_schema.tables
      WHERE
        table_schema = 'public'
      ORDER BY
        table_name
    `;

    const result = await pool.query(sql);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            tables: result.rows.map(row => row.table_name)
          }, null, 2)
        }
      ]
    };
  } catch (error) {
    throw new McpError(ErrorCode.InternalError, `Error getting tables: ${error.message}`);
  }
}

// Describe table handler
async function handleDescribeTable(args) {
  if (!args.table) {
    throw new McpError(ErrorCode.InvalidParams, "Table name is required");
  }

  try {
    const sql = `
      SELECT
        column_name,
        data_type,
        is_nullable,
        column_default
      FROM
        information_schema.columns
      WHERE
        table_schema = 'public'
        AND table_name = $1
      ORDER BY
        ordinal_position
    `;

    const columns = await pool.query(sql, [args.table]);

    // Get primary key information
    const pkSql = `
      SELECT
        kcu.column_name
      FROM
        information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
      WHERE
        tc.constraint_type = 'PRIMARY KEY'
        AND tc.table_schema = 'public'
        AND tc.table_name = $1
      ORDER BY
        kcu.ordinal_position
    `;

    const pks = await pool.query(pkSql, [args.table]);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            table: args.table,
            columns: columns.rows,
            primaryKeys: pks.rows.map(row => row.column_name)
          }, null, 2)
        }
      ]
    };
  } catch (error) {
    throw new McpError(ErrorCode.InternalError, `Error describing table: ${error.message}`);
  }
}

// Start the server
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("Neon PostgreSQL MCP server running on stdio");

// Handle process termination gracefully
process.on('SIGINT', async () => {
  await pool.end();
  await server.close();
  process.exit(0);
});