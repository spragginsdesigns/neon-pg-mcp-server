# Neon PostgreSQL MCP Server

A Model Context Protocol (MCP) server that provides secure access to Neon PostgreSQL databases, enabling AI assistants like Claude to interact with your database through standardized tools.

## Overview

This MCP server allows AI assistants to:
- Query data using SELECT statements
- Execute data modifications (INSERT, UPDATE, DELETE)
- List available tables
- Describe table structures

The server implements multiple versions to demonstrate different approaches:
- `pg-mcp-server.js` - Modern ES module implementation using the latest MCP SDK
- `index.js` - CommonJS implementation with class-based architecture
- `basic-pg-server.js` - Simplified implementation with basic MCP protocol handling
- `src/index.ts` - TypeScript implementation (requires compilation)

## Features

- **Secure Connection**: SSL/TLS encrypted connections to Neon PostgreSQL
- **Connection Pooling**: Efficient database connection management
- **Type Safety**: Input validation for all operations
- **Error Handling**: Comprehensive error handling with meaningful messages
- **MCP Compliance**: Full implementation of the Model Context Protocol specification

## Prerequisites

- Node.js 18+ 
- A Neon PostgreSQL database account and connection string
- An MCP-compatible client (e.g., Claude Desktop, Cursor IDE)

## Installation

1. Clone this repository:
```bash
git clone <repository-url>
cd neon-pg-server
```

2. Install dependencies:
```bash
npm install
```

3. Configure your Neon PostgreSQL connection(s) via environment variables (see below):
```bash
export NEON_PG_CONNECTION_STRING="postgresql://user:password@host/database?sslmode=require"
```

## Environment Variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `NEON_PG_CONNECTION_STRING` | one of the two | Single connection string, registered as the project named `default`. The original single-database setup — still fully supported. |
| `NEON_PG_CONNECTIONS` | one of the two | JSON object mapping project names to connection strings, e.g. `{"versemind":"postgresql://...","linecrush":"postgresql://..."}`. Can be combined with `NEON_PG_CONNECTION_STRING`. |
| `NEON_PG_READONLY_PROJECTS` | no | Comma-separated project names for which the `execute` tool is refused outright (reads still work). |

At least one of the first two must be set. If both define a project named `default`, the `NEON_PG_CONNECTIONS` entry wins (a warning is logged to stderr).

### Multi-Project Setup

One server instance can serve several Neon projects. Pools are created lazily per project on first use, so configuring six projects does not open six pools at startup.

```json
{
  "neon-pg": {
    "command": "node",
    "args": ["/path/to/neon-pg-server/pg-mcp-server.js"],
    "env": {
      "NEON_PG_CONNECTION_STRING": "postgresql://user:pw@ep-old-host.aws.neon.tech/verceldb?sslmode=require",
      "NEON_PG_CONNECTIONS": "{\"versemind\":\"postgresql://user:pw@ep-vm-host.aws.neon.tech/neondb?sslmode=require\",\"linecrush\":\"postgresql://user:pw@ep-lc-host.aws.neon.tech/verceldb?sslmode=require\"}",
      "NEON_PG_READONLY_PROJECTS": "linecrush"
    }
  }
}
```

With this config:
- `get_tables` with no arguments runs against `default` (the legacy connection string) — existing setups keep working unchanged.
- `get_tables` with `project: "versemind"` runs against the versemind database.
- `execute` with `project: "linecrush"` is refused because linecrush is in `NEON_PG_READONLY_PROJECTS`.
- `list_projects` shows all three names with their host and database (never credentials).

**Default project resolution:** the project named `default` (from `NEON_PG_CONNECTION_STRING` or a `default` key in `NEON_PG_CONNECTIONS`) is the default for read tools. If no `default` exists but exactly one project is configured, that one is the default. With multiple named projects and no `default`, read tools require an explicit `project` argument.

### Multi-Project Safety Rules

These exist so it is impossible to read a tool result — or run a write — without knowing which database it touched:

1. **`execute` always requires an explicit `project` argument.** There is no default and no inference for writes; a missing or unknown project is an error that lists the valid names and runs nothing.
2. **Every tool result carries a `source` block** (`project`, `database`, `host`) — success or error, read or write. Error text is prefixed with `[project=... database=...]`.
3. **`NEON_PG_READONLY_PROJECTS`** hard-blocks `execute` per project, even with an explicit `project` argument.
4. MCP resources (`neon://...`) are served from the default project only.

## Usage

### Running the Server

Choose one of the available implementations:

**ES Module version (recommended):**
```bash
node pg-mcp-server.js
```

**CommonJS version:**
```bash
node index.js
```

**Basic version:**
```bash
node basic-pg-server.js
```

**TypeScript version:**
```bash
# First compile
npm run build
# Then run
node build/index.js
```

### Integrating with Claude Desktop

1. Open Claude Desktop settings
2. Navigate to Developer → MCP Servers
3. Add a new server configuration:

```json
{
  "neon-postgres": {
    "command": "node",
    "args": ["/path/to/neon-pg-server/pg-mcp-server.js"],
    "env": {
      "NEON_PG_CONNECTION_STRING": "your-connection-string-here"
    }
  }
}
```

### Integrating with Cursor IDE

1. Open File → Preferences → Cursor Settings → MCP
2. Add New Server
3. Configure with the path to your server script

## Available Tools

Production `pg-mcp-server.js` exposes 9 tools. Each tool includes Claude/Codex-friendly titles, read/write annotations, structured output schemas, and JSON text fallbacks.

Every tool except `list_projects` accepts an optional `project` argument selecting the named connection to run against (default: the `default` project). On `execute` the `project` argument is **required**. Every result includes a `source` block stating the project, database, and host it ran against.

### 0. List Projects Tool
List the configured project connections: name, host, database, default flag, and read-only flag. Never returns credentials.

**Parameters:** None

### 1. Query Tool
Execute read-only SELECT, WITH, and EXPLAIN queries to retrieve data from your database.

The query tool runs inside a read-only transaction and safely caps unbounded top-level result sets at 100 rows, so agents can omit `LIMIT` during exploration. A trailing semicolon is accepted.

**Parameters:**
- `sql` (required): SQL SELECT, WITH, or EXPLAIN statement to execute
- `params` (optional): Array of query parameters for parameterized queries

**Example:**
```sql
SELECT * FROM users WHERE age > $1
```

### 2. Execute Tool
Execute SQL statements that modify data (INSERT, UPDATE, DELETE, DDL).

**Parameters:**
- `sql` (required): SQL statement to execute
- `project` (**required**): Named project to write to — no default is applied for writes
- `params` (optional): Array of statement parameters

Refused outright for projects listed in `NEON_PG_READONLY_PROJECTS`.

**Example:**
```sql
INSERT INTO users (name, email) VALUES ($1, $2)
```

### 3. List Slow Queries Tool
List the slowest statements tracked by `pg_stat_statements`.

**Parameters:**
- `limit` (optional): Max queries to return, default 10, hard cap 25
- `order_by` (optional): Sort metric, one of `mean_exec_time`, `total_exec_time`, `calls`, or `rows`
- `min_mean_ms` (optional): Minimum mean execution time in milliseconds

If `pg_stat_statements` is not installed, the tool returns a structured setup note instead of a cryptic database error.

### 4. Get Tables Tool
List public schema tables with approximate size and column counts.

**Parameters:** None

### 5. Get Schema Tool
Return schema overview: table names, sizes, row estimates, column counts, and pagination metadata.

**Parameters:**
- `tables` (optional): Specific public tables to include
- `limit` (optional): Max tables to return, default 50, hard cap 200
- `offset` (optional): Tables to skip for pagination
- `include_all` (optional): Include backup/archive tables

### 6. Describe Table Tool
Get detailed structure information about a specific public table.

**Parameters:**
- `table` (required): Name of the table to describe

**Returns:** 
- Column information (name, data type, nullable, default value)
- Primary key columns, foreign keys, indexes, enum values, JSONB keys, size, row estimate

### 7. Sample Data Tool
Return a few rows from a public table plus inferred JSONB structure.

**Parameters:**
- `table` (required): Name of the table to sample
- `limit` (optional): Number of rows, default 3, hard cap 10

### 8. Search Schema Tool
Search public table and column names by case-insensitive text pattern.

**Parameters:**
- `pattern` (required): Text to search for in table and column names

## Agent Ergonomics

- **Server instructions** tell Claude/Codex how to use schema discovery tools and avoid unnecessary LIMIT retries.
- **Tool annotations** mark read-only vs write tools for safer host permissions and confirmations.
- **Completions** provide suggestions for table names, prompt arguments, resource template arguments, and sample limits.
- **Structured logging** supports client-controlled log levels without writing protocol-breaking output to stdout.
- **Payload budgeting** trims oversized query, sample, and slow-query results below host limits before Claude receives them.
- **Slow-query discovery** gives agents a safe `pg_stat_statements` entry point before they start tuning queries.

## Security Considerations

- **Connection String**: Store your connection strings as environment variables, never commit them to version control
- **SSL/TLS**: The server enforces SSL connections to Neon PostgreSQL
- **Source Attribution**: Every tool result and error names the project, database, and host it ran against, so results can never be misattributed to the wrong database
- **Write Targeting**: `execute` requires an explicit `project` argument and honors `NEON_PG_READONLY_PROJECTS`
- **Query Validation**: The server validates that:
  - Query tool only accepts SELECT, WITH, and EXPLAIN statements
  - Query tool runs inside a read-only transaction
  - Unbounded top-level query results are capped at 100 rows without requiring agents to write `LIMIT`
  - Execute tool rejects SELECT statements (use Query tool instead)
- **Payload Control**: Query and sample results are reduced below host payload limits by truncating large cells, then rows as a last resort
- **Parameterized Queries**: Use parameterized queries to prevent SQL injection

## Configuration

### Connection Pool Settings

The server uses the following default pool settings:
- Maximum connections: 10
- Idle timeout: 30 seconds

You can modify these in the connection pool initialization:

```javascript
this.pool = new pg.Pool({
  connectionString: CONNECTION_STRING,
  ssl: { rejectUnauthorized: true },
  max: 10,  // Adjust as needed
  idleTimeoutMillis: 30000  // Adjust as needed
});
```

## Development

### Project Structure
```
neon-pg-server/
├── pg-mcp-server.js      # Main ES module implementation
├── index.js              # CommonJS implementation
├── basic-pg-server.js    # Basic implementation
├── src/
│   └── index.ts         # TypeScript implementation
├── build/               # Compiled TypeScript output
├── package.json         # Project dependencies
├── tsconfig.json        # TypeScript configuration
└── README.md           # This file
```

### Building from TypeScript

If you want to use the TypeScript version:

```bash
# Install dev dependencies
npm install

# Compile TypeScript
npx tsc

# Run compiled version
node build/index.js
```

## Troubleshooting

### Connection Issues
- Verify your connection string is correct
- Ensure your Neon database is active
- Check that SSL is enabled (required for Neon)

### MCP Client Issues
- Ensure the MCP client can find the server executable
- Check that environment variables are properly passed to the server
- Review server logs (output to stderr) for error messages

### Query Errors
- Verify SQL syntax is correct
- Check that tables and columns exist
- Ensure proper permissions for database operations

## Contributing

Contributions are welcome! Please:
1. Fork the repository
2. Create a feature branch
3. Add tests for new functionality
4. Submit a pull request

## License

MIT License - see LICENSE file for details

## Acknowledgments

- Built with the [Model Context Protocol SDK](https://modelcontextprotocol.io)
- Powered by [Neon PostgreSQL](https://neon.tech)
- Inspired by the MCP ecosystem and community
