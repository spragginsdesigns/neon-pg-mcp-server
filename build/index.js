#!/usr/bin/env node
import { Server, StdioTransport, McpError, ErrorCode } from "@modelcontextprotocol/sdk";
import pg from "pg";
// Check for required environment variable
const CONNECTION_STRING = process.env.NEON_PG_CONNECTION_STRING;
if (!CONNECTION_STRING) {
    throw new Error("NEON_PG_CONNECTION_STRING environment variable is required");
}
// Validate input arguments
const isValidQueryArgs = (args) => typeof args === "object" &&
    args !== null &&
    typeof args.sql === "string" &&
    (args.params === undefined || Array.isArray(args.params));
const isValidExecuteArgs = (args) => typeof args === "object" &&
    args !== null &&
    typeof args.sql === "string" &&
    (args.params === undefined || Array.isArray(args.params));
const isValidDescribeTableArgs = (args) => typeof args === "object" && args !== null && typeof args.table === "string";
class NeonPostgresServer {
    constructor() {
        // Initialize MCP server
        this.server = new Server({
            name: "neon-pg-server",
            version: "0.1.0"
        });
        // Initialize PostgreSQL connection pool
        this.pool = new pg.Pool({
            connectionString: CONNECTION_STRING,
            ssl: {
                rejectUnauthorized: true
            },
            max: 10, // maximum number of clients in the pool
            idleTimeoutMillis: 30000 // how long a client is allowed to remain idle before being closed
        });
        // Setup tool handlers
        this.setupToolHandlers();
        // Error handling
        this.server.onerror = (error) => console.error("[MCP Error]", error);
        process.on("SIGINT", async () => {
            await this.pool.end();
            await this.server.close();
            process.exit(0);
        });
    }
    setupToolHandlers() {
        // Register available tools
        this.server.defineTools([
            {
                name: "query",
                description: "Execute a SQL SELECT query and return the results",
                parameters: {
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
                },
                handler: async (args) => {
                    return this.handleQuery(args);
                }
            },
            {
                name: "execute",
                description: "Execute a SQL statement that modifies data (INSERT, UPDATE, DELETE)",
                parameters: {
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
                },
                handler: async (args) => {
                    return this.handleExecute(args);
                }
            },
            {
                name: "get_tables",
                description: "Get a list of tables in the database",
                parameters: {
                    type: "object",
                    properties: {},
                    required: []
                },
                handler: async () => {
                    return this.handleGetTables();
                }
            },
            {
                name: "describe_table",
                description: "Get structure information about a specific table",
                parameters: {
                    type: "object",
                    properties: {
                        table: {
                            type: "string",
                            description: "Name of the table to describe"
                        }
                    },
                    required: ["table"]
                },
                handler: async (args) => {
                    return this.handleDescribeTable(args);
                }
            }
        ]);
    }
    async handleQuery(args) {
        if (!isValidQueryArgs(args)) {
            throw new McpError(ErrorCode.InvalidParams, "Invalid query arguments");
        }
        // Validate that the query is a SELECT statement to prevent misuse
        const trimmedSql = args.sql.trim().toLowerCase();
        if (!trimmedSql.startsWith("select") && !trimmedSql.startsWith("with")) {
            throw new McpError(ErrorCode.InvalidParams, "Query must be a SELECT statement or a WITH query");
        }
        try {
            const result = await this.pool.query(args.sql, args.params || []);
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({
                            rowCount: result.rowCount,
                            rows: result.rows,
                            fields: result.fields.map((f) => ({
                                name: f.name,
                                dataTypeID: f.dataTypeID
                            }))
                        }, null, 2)
                    }
                ]
            };
        }
        catch (error) {
            return {
                content: [
                    {
                        type: "text",
                        text: `Database query error: ${error.message}`
                    }
                ],
                isError: true
            };
        }
    }
    async handleExecute(args) {
        if (!isValidExecuteArgs(args)) {
            throw new McpError(ErrorCode.InvalidParams, "Invalid execute arguments");
        }
        // Validate that the statement is not a SELECT to ensure proper tool usage
        const trimmedSql = args.sql.trim().toLowerCase();
        if (trimmedSql.startsWith("select")) {
            throw new McpError(ErrorCode.InvalidParams, "Execute should not be used for SELECT statements. Use query instead");
        }
        try {
            const result = await this.pool.query(args.sql, args.params || []);
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
        }
        catch (error) {
            return {
                content: [
                    {
                        type: "text",
                        text: `Database execute error: ${error.message}`
                    }
                ],
                isError: true
            };
        }
    }
    async handleGetTables() {
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
            const result = await this.pool.query(sql);
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({
                            tables: result.rows.map((row) => row.table_name)
                        }, null, 2)
                    }
                ]
            };
        }
        catch (error) {
            return {
                content: [
                    {
                        type: "text",
                        text: `Error getting tables: ${error.message}`
                    }
                ],
                isError: true
            };
        }
    }
    async handleDescribeTable(args) {
        if (!isValidDescribeTableArgs(args)) {
            throw new McpError(ErrorCode.InvalidParams, "Invalid describe table arguments");
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
            const columns = await this.pool.query(sql, [args.table]);
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
            const pks = await this.pool.query(pkSql, [args.table]);
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({
                            table: args.table,
                            columns: columns.rows,
                            primaryKeys: pks.rows.map((row) => row.column_name)
                        }, null, 2)
                    }
                ]
            };
        }
        catch (error) {
            return {
                content: [
                    {
                        type: "text",
                        text: `Error describing table: ${error.message}`
                    }
                ],
                isError: true
            };
        }
    }
    async run() {
        try {
            // Test database connection
            const client = await this.pool.connect();
            client.release();
            console.error("Successfully connected to Neon PostgreSQL database");
            // Connect to MCP transport
            const transport = new StdioTransport();
            await this.server.connect(transport);
            console.error("Neon PostgreSQL MCP server running on stdio");
        }
        catch (error) {
            console.error("Failed to start server:", error);
            process.exit(1);
        }
    }
}
const server = new NeonPostgresServer();
server.run().catch(console.error);
//# sourceMappingURL=index.js.map