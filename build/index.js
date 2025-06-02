#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
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
const isValidBatchQueryArgs = (args) => typeof args === "object" &&
    args !== null &&
    Array.isArray(args.queries) &&
    args.queries.every((query) => typeof query === "object" &&
        query !== null &&
        typeof query.sql === "string" &&
        (query.params === undefined || Array.isArray(query.params)) &&
        (query.name === undefined || typeof query.name === "string"));
const isValidGetSchemaArgs = (args) => typeof args === "object" &&
    args !== null &&
    (args.includeRelationships === undefined || typeof args.includeRelationships === "boolean") &&
    (args.tablePattern === undefined || typeof args.tablePattern === "string");
const isValidSmartQueryArgs = (args) => typeof args === "object" &&
    args !== null &&
    typeof args.table === "string" &&
    typeof args.operation === "string" &&
    ["count", "sample", "columns", "recent"].includes(args.operation) &&
    (args.limit === undefined || typeof args.limit === "number") &&
    (args.orderBy === undefined || typeof args.orderBy === "string");
const isValidCreateIndexArgs = (args) => typeof args === "object" &&
    args !== null &&
    typeof args.table === "string" &&
    Array.isArray(args.columns) &&
    (args.indexName === undefined || typeof args.indexName === "string");
const isValidDropIndexArgs = (args) => typeof args === "object" &&
    args !== null &&
    typeof args.indexName === "string";
const isValidCreateViewArgs = (args) => typeof args === "object" &&
    args !== null &&
    typeof args.name === "string" &&
    typeof args.query === "string";
const isValidDropViewArgs = (args) => typeof args === "object" &&
    args !== null &&
    typeof args.name === "string";
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
        // Register request handlers for tools
        this.server.setRequestHandler(ListToolsRequestSchema, async () => {
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
                    },
                    {
                        name: "batch_query",
                        description: "Execute multiple SQL queries in a single request. Useful for getting related data efficiently or running multiple operations together.",
                        inputSchema: {
                            type: "object",
                            properties: {
                                queries: {
                                    type: "array",
                                    description: "Array of queries to execute",
                                    items: {
                                        type: "object",
                                        properties: {
                                            sql: {
                                                type: "string",
                                                description: "SQL query to execute"
                                            },
                                            params: {
                                                type: "array",
                                                description: "Query parameters (optional)",
                                                items: {
                                                    type: "string"
                                                }
                                            },
                                            name: {
                                                type: "string",
                                                description: "Optional name to identify results"
                                            }
                                        },
                                        required: ["sql"]
                                    }
                                }
                            },
                            required: ["queries"]
                        }
                    },
                    {
                        name: "get_schema",
                        description: "Get comprehensive database schema information including all tables, columns, data types, and optionally foreign key relationships. This is useful for understanding the database structure before writing queries.",
                        inputSchema: {
                            type: "object",
                            properties: {
                                includeRelationships: {
                                    type: "boolean",
                                    description: "Include relationships between tables"
                                },
                                tablePattern: {
                                    type: "string",
                                    description: "Optional pattern to filter tables"
                                }
                            },
                            required: []
                        }
                    },
                    {
                        name: "smart_query",
                        description: "Execute common query patterns on a table without writing SQL. Operations: 'count' (get row count), 'sample' (get random rows), 'columns' (get column info), 'recent' (get most recent rows by ID or custom column).",
                        inputSchema: {
                            type: "object",
                            properties: {
                                table: {
                                    type: "string",
                                    description: "Name of the table to query"
                                },
                                operation: {
                                    type: "string",
                                    description: "Operation to perform (count, sample, columns, recent)",
                                    enum: ["count", "sample", "columns", "recent"]
                                },
                                limit: {
                                    type: "integer",
                                    description: "Optional limit for the query"
                                },
                                orderBy: {
                                    type: "string",
                                    description: "Optional order by clause"
                                }
                            },
                            required: ["table", "operation"]
                        }
                    },
                    {
                        name: "create_index",
                        description: "Create an index on a table",
                        inputSchema: {
                            type: "object",
                            properties: {
                                table: {
                                    type: "string",
                                    description: "Name of the table to create index on"
                                },
                                columns: {
                                    type: "array",
                                    description: "Columns to include in the index",
                                    items: {
                                        type: "string"
                                    }
                                },
                                indexName: {
                                    type: "string",
                                    description: "Optional name for the index"
                                }
                            },
                            required: ["table", "columns"]
                        }
                    },
                    {
                        name: "drop_index",
                        description: "Drop an index",
                        inputSchema: {
                            type: "object",
                            properties: {
                                indexName: {
                                    type: "string",
                                    description: "Name of the index to drop"
                                }
                            },
                            required: ["indexName"]
                        }
                    },
                    {
                        name: "create_view",
                        description: "Create a view",
                        inputSchema: {
                            type: "object",
                            properties: {
                                name: {
                                    type: "string",
                                    description: "Name of the view to create"
                                },
                                query: {
                                    type: "string",
                                    description: "Query to define the view"
                                }
                            },
                            required: ["name", "query"]
                        }
                    },
                    {
                        name: "drop_view",
                        description: "Drop a view",
                        inputSchema: {
                            type: "object",
                            properties: {
                                name: {
                                    type: "string",
                                    description: "Name of the view to drop"
                                }
                            },
                            required: ["name"]
                        }
                    }
                ]
            };
        });
        // Register handler for tool execution
        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const toolName = request.params.name;
            const args = request.params.arguments || {};
            switch (toolName) {
                case "query":
                    return await this.handleQuery(args);
                case "execute":
                    return await this.handleExecute(args);
                case "get_tables":
                    return await this.handleGetTables();
                case "describe_table":
                    return await this.handleDescribeTable(args);
                case "batch_query":
                    return await this.handleBatchQuery(args);
                case "get_schema":
                    return await this.handleGetSchema(args);
                case "smart_query":
                    return await this.handleSmartQuery(args);
                case "create_index":
                    return await this.handleCreateIndex(args);
                case "drop_index":
                    return await this.handleDropIndex(args);
                case "create_view":
                    return await this.handleCreateView(args);
                case "drop_view":
                    return await this.handleDropView(args);
                default:
                    throw new McpError(ErrorCode.MethodNotFound, `Tool not found: ${toolName}`);
            }
        });
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
    async handleBatchQuery(args) {
        if (!isValidBatchQueryArgs(args)) {
            throw new McpError(ErrorCode.InvalidParams, "Invalid batch query arguments");
        }
        try {
            const results = await Promise.all(args.queries.map(async (query) => {
                const result = await this.pool.query(query.sql, query.params || []);
                return {
                    name: query.name,
                    result: {
                        rowCount: result.rowCount,
                        rows: result.rows,
                        fields: result.fields.map((f) => ({
                            name: f.name,
                            dataTypeID: f.dataTypeID
                        }))
                    }
                };
            }));
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(results, null, 2)
                    }
                ]
            };
        }
        catch (error) {
            return {
                content: [
                    {
                        type: "text",
                        text: `Database batch query error: ${error.message}`
                    }
                ],
                isError: true
            };
        }
    }
    async handleGetSchema(args) {
        if (!isValidGetSchemaArgs(args)) {
            throw new McpError(ErrorCode.InvalidParams, "Invalid get schema arguments");
        }
        try {
            const sql = `
        SELECT
          table_name,
          column_name,
          data_type,
          is_nullable,
          column_default
        FROM
          information_schema.columns
        WHERE
          table_schema = 'public'
        ORDER BY
          table_name,
          ordinal_position
      `;
            const columns = await this.pool.query(sql);
            if (args.includeRelationships) {
                const relationshipsSql = `
          SELECT
            tc.table_name,
            kcu.column_name,
            ccu.table_name AS referenced_table_name,
            ccu.column_name AS referenced_column_name
          FROM
            information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
              ON tc.constraint_name = kcu.constraint_name
              AND tc.table_schema = kcu.table_schema
            JOIN information_schema.constraint_column_usage ccu
              ON tc.constraint_name = ccu.constraint_name
              AND tc.table_schema = ccu.table_schema
          WHERE
            tc.constraint_type = 'FOREIGN KEY'
            AND tc.table_schema = 'public'
          ORDER BY
            tc.table_name,
            kcu.ordinal_position
        `;
                const relationships = await this.pool.query(relationshipsSql);
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify({
                                columns: columns.rows,
                                relationships: relationships.rows
                            }, null, 2)
                        }
                    ]
                };
            }
            else {
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify({
                                columns: columns.rows
                            }, null, 2)
                        }
                    ]
                };
            }
        }
        catch (error) {
            return {
                content: [
                    {
                        type: "text",
                        text: `Error getting schema: ${error.message}`
                    }
                ],
                isError: true
            };
        }
    }
    async handleSmartQuery(args) {
        if (!isValidSmartQueryArgs(args)) {
            throw new McpError(ErrorCode.InvalidParams, "Invalid smart query arguments");
        }
        try {
            let sql = "";
            switch (args.operation) {
                case "count":
                    sql = `
            SELECT
              COUNT(*)
            FROM
              ${args.table}
          `;
                    break;
                case "sample":
                    sql = `
            SELECT
              *
            FROM
              ${args.table}
            ORDER BY
              RANDOM()
            LIMIT ${args.limit || 10}
          `;
                    break;
                case "columns":
                    sql = `
            SELECT
              column_name,
              data_type,
              is_nullable,
              column_default
            FROM
              information_schema.columns
            WHERE
              table_schema = 'public'
              AND table_name = '${args.table}'
            ORDER BY
              ordinal_position
          `;
                    break;
                case "recent":
                    sql = `
            SELECT
              *
            FROM
              ${args.table}
            ORDER BY
              ${args.orderBy || "id"} DESC
            LIMIT ${args.limit || 10}
          `;
                    break;
                default:
                    throw new McpError(ErrorCode.InvalidParams, "Invalid operation");
            }
            const result = await this.pool.query(sql);
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({
                            result: result.rows
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
                        text: `Error executing smart query: ${error.message}`
                    }
                ],
                isError: true
            };
        }
    }
    async handleCreateIndex(args) {
        if (!isValidCreateIndexArgs(args)) {
            throw new McpError(ErrorCode.InvalidParams, "Invalid create index arguments");
        }
        try {
            const sql = `
        CREATE INDEX ${args.indexName || `idx_${args.table}_${args.columns.join("_")}`}
        ON ${args.table} (${args.columns.join(", ")})
      `;
            await this.pool.query(sql);
            return {
                content: [
                    {
                        type: "text",
                        text: `Index created successfully`
                    }
                ]
            };
        }
        catch (error) {
            return {
                content: [
                    {
                        type: "text",
                        text: `Error creating index: ${error.message}`
                    }
                ],
                isError: true
            };
        }
    }
    async handleDropIndex(args) {
        if (!isValidDropIndexArgs(args)) {
            throw new McpError(ErrorCode.InvalidParams, "Invalid drop index arguments");
        }
        try {
            const sql = `
        DROP INDEX ${args.indexName}
      `;
            await this.pool.query(sql);
            return {
                content: [
                    {
                        type: "text",
                        text: `Index dropped successfully`
                    }
                ]
            };
        }
        catch (error) {
            return {
                content: [
                    {
                        type: "text",
                        text: `Error dropping index: ${error.message}`
                    }
                ],
                isError: true
            };
        }
    }
    async handleCreateView(args) {
        if (!isValidCreateViewArgs(args)) {
            throw new McpError(ErrorCode.InvalidParams, "Invalid create view arguments");
        }
        try {
            const sql = `
        CREATE VIEW ${args.name} AS
        ${args.query}
      `;
            await this.pool.query(sql);
            return {
                content: [
                    {
                        type: "text",
                        text: `View created successfully`
                    }
                ]
            };
        }
        catch (error) {
            return {
                content: [
                    {
                        type: "text",
                        text: `Error creating view: ${error.message}`
                    }
                ],
                isError: true
            };
        }
    }
    async handleDropView(args) {
        if (!isValidDropViewArgs(args)) {
            throw new McpError(ErrorCode.InvalidParams, "Invalid drop view arguments");
        }
        try {
            const sql = `
        DROP VIEW ${args.name}
      `;
            await this.pool.query(sql);
            return {
                content: [
                    {
                        type: "text",
                        text: `View dropped successfully`
                    }
                ]
            };
        }
        catch (error) {
            return {
                content: [
                    {
                        type: "text",
                        text: `Error dropping view: ${error.message}`
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
            const transport = new StdioServerTransport();
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