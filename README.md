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

3. Set up your Neon PostgreSQL connection string as an environment variable:
```bash
export NEON_PG_CONNECTION_STRING="postgresql://user:password@host/database?sslmode=require"
```

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

### 1. Query Tool
Execute SELECT queries to retrieve data from your database.

**Parameters:**
- `sql` (required): SQL SELECT query to execute
- `params` (optional): Array of query parameters for parameterized queries

**Example:**
```sql
SELECT * FROM users WHERE age > $1
```

### 2. Execute Tool
Execute SQL statements that modify data (INSERT, UPDATE, DELETE).

**Parameters:**
- `sql` (required): SQL statement to execute
- `params` (optional): Array of statement parameters

**Example:**
```sql
INSERT INTO users (name, email) VALUES ($1, $2)
```

### 3. Get Tables Tool
List all tables in the public schema of your database.

**Parameters:** None

**Returns:** Array of table names

### 4. Describe Table Tool
Get detailed structure information about a specific table.

**Parameters:**
- `table` (required): Name of the table to describe

**Returns:** 
- Column information (name, data type, nullable, default value)
- Primary key columns

## Security Considerations

- **Connection String**: Store your connection string as an environment variable, never commit it to version control
- **SSL/TLS**: The server enforces SSL connections to Neon PostgreSQL
- **Query Validation**: The server validates that:
  - Query tool only accepts SELECT and WITH statements
  - Execute tool rejects SELECT statements (use Query tool instead)
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