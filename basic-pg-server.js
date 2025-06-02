#!/usr/bin/env node
const { spawn } = require('child_process');
const pg = require('pg');
const readline = require('readline');

// Check for required environment variable
const CONNECTION_STRING = process.env.NEON_PG_CONNECTION_STRING;
if (!CONNECTION_STRING) {
  console.error('NEON_PG_CONNECTION_STRING environment variable is required');
  process.exit(1);
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

// Create readline interface for stdin/stdout
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

// Basic MCP protocol handling
async function handleRequest(request) {
  try {
    const parsedRequest = JSON.parse(request);

    if (parsedRequest.method === 'list_tools') {
      return {
        id: parsedRequest.id,
        result: {
          tools: [
            {
              name: 'query',
              description: 'Execute a SQL SELECT query',
              parameters: {
                type: 'object',
                properties: {
                  sql: { type: 'string', description: 'SQL query (must be SELECT)' },
                  params: { type: 'array', description: 'Query parameters' }
                },
                required: ['sql']
              }
            },
            {
              name: 'execute',
              description: 'Execute a SQL statement (INSERT, UPDATE, DELETE)',
              parameters: {
                type: 'object',
                properties: {
                  sql: { type: 'string', description: 'SQL statement' },
                  params: { type: 'array', description: 'Statement parameters' }
                },
                required: ['sql']
              }
            },
            {
              name: 'get_tables',
              description: 'Get list of tables in database',
              parameters: {
                type: 'object',
                properties: {},
                required: []
              }
            },
            {
              name: 'describe_table',
              description: 'Get details about a specific table',
              parameters: {
                type: 'object',
                properties: {
                  table: { type: 'string', description: 'Table name' }
                },
                required: ['table']
              }
            }
          ]
        }
      };
    }
    else if (parsedRequest.method === 'call_tool') {
      const toolName = parsedRequest.params.name;
      const args = parsedRequest.params.arguments || {};

      let result;
      switch (toolName) {
        case 'query':
          result = await handleQuery(args.sql, args.params);
          break;
        case 'execute':
          result = await handleExecute(args.sql, args.params);
          break;
        case 'get_tables':
          result = await handleGetTables();
          break;
        case 'describe_table':
          result = await handleDescribeTable(args.table);
          break;
        default:
          throw new Error(`Unknown tool: ${toolName}`);
      }

      return {
        id: parsedRequest.id,
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2)
            }
          ]
        }
      };
    }
    else {
      // Handle other MCP methods
      return {
        id: parsedRequest.id,
        result: {}
      };
    }
  } catch (error) {
    console.error('Error handling request:', error);
    return {
      id: parsedRequest.id || 0,
      error: {
        code: -32000,
        message: error.message
      }
    };
  }
}

// Query handler (SELECT only)
async function handleQuery(sql, params = []) {
  if (!sql) {
    throw new Error('SQL query is required');
  }

  const trimmedSql = sql.trim().toLowerCase();
  if (!trimmedSql.startsWith('select') && !trimmedSql.startsWith('with')) {
    throw new Error('Query must be a SELECT statement or a WITH query');
  }

  try {
    const result = await pool.query(sql, params);
    return {
      rowCount: result.rowCount,
      rows: result.rows,
      fields: result.fields.map(f => ({
        name: f.name,
        dataTypeID: f.dataTypeID
      }))
    };
  } catch (error) {
    throw new Error(`Database query error: ${error.message}`);
  }
}

// Execute handler (for non-SELECT statements)
async function handleExecute(sql, params = []) {
  if (!sql) {
    throw new Error('SQL statement is required');
  }

  const trimmedSql = sql.trim().toLowerCase();
  if (trimmedSql.startsWith('select')) {
    throw new Error('Execute should not be used for SELECT statements. Use query instead');
  }

  try {
    const result = await pool.query(sql, params);
    return {
      command: result.command,
      rowCount: result.rowCount,
      oid: result.oid
    };
  } catch (error) {
    throw new Error(`Database execute error: ${error.message}`);
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
      tables: result.rows.map(row => row.table_name)
    };
  } catch (error) {
    throw new Error(`Error getting tables: ${error.message}`);
  }
}

// Describe table handler
async function handleDescribeTable(table) {
  if (!table) {
    throw new Error('Table name is required');
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

    const columns = await pool.query(sql, [table]);

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

    const pks = await pool.query(pkSql, [table]);

    return {
      table: table,
      columns: columns.rows,
      primaryKeys: pks.rows.map(row => row.column_name)
    };
  } catch (error) {
    throw new Error(`Error describing table: ${error.message}`);
  }
}

// Start the server
async function start() {
  try {
    // Test database connection
    const client = await pool.connect();
    client.release();
    console.error('Successfully connected to Neon PostgreSQL database');

    // Process MCP requests
    rl.on('line', async (line) => {
      if (line.trim()) {
        try {
          const response = await handleRequest(line);
          console.log(JSON.stringify(response));
        } catch (error) {
          console.error('Error processing request:', error);
          console.log(JSON.stringify({
            id: 0,
            error: {
              code: -32000,
              message: error.message
            }
          }));
        }
      }
    });

    console.error('Neon PostgreSQL MCP server running on stdio');
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Handle process termination
process.on('SIGINT', async () => {
  await pool.end();
  process.exit(0);
});

// Start server
start().catch(console.error);