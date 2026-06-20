# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Neon PostgreSQL MCP Server - A Model Context Protocol server that provides secure database access to Neon PostgreSQL databases, enabling AI assistants to interact with databases through standardized tools.

## Commands

```bash
# Run the server (ES module - recommended)
node pg-mcp-server.js

# Run CommonJS version
node index.js

# Run basic version
node basic-pg-server.js

# Build TypeScript (outputs to build/)
pnpm build

# Test database connection
pnpm test
```

## Architecture

### Server Implementations

The project provides multiple MCP server implementations demonstrating different approaches:

| File | Type | Use Case |
|------|------|----------|
| `pg-mcp-server.js` | ES Module | **Production** - Modern SDK with full features |
| `index.js` | CommonJS | Class-based architecture example |
| `basic-pg-server.js` | CommonJS | Minimal implementation, manual protocol handling |
| `src/index.ts` | TypeScript | Type-safe implementation (requires build) |

### MCP Tools Exposed

Production `pg-mcp-server.js` exposes 7 tools:
- `query` - Read-only SELECT/WITH/EXPLAIN queries only (unbounded top-level results are capped at 100 rows)
- `execute` - INSERT/UPDATE/DELETE statements
- `get_tables` - List tables in public schema
- `get_schema` - Schema overview with pagination and backup/archive filtering
- `describe_table` - Table structure, columns, keys, indexes, enums, JSONB keys
- `sample_data` - Small row samples with inferred JSONB structures
- `search_schema` - Table and column name search

Legacy examples (`index.js`, `basic-pg-server.js`, `src/index.ts`) expose the smaller 4-tool surface.

### Connection Architecture

```
MCP Client (Claude Desktop/Cursor)
    ↓ stdio transport
MCP Server (pg-mcp-server.js)
    ↓ SSL connection pool (max 10, 30s idle timeout)
Neon PostgreSQL Database
```

### Key Configuration

- `MAX_ROWS`: 100 (server wraps unbounded top-level query results with an outer cap)
- `QUERY_TIMEOUT`: 30000ms
- `MAX_TOOL_RESPONSE_CHARS`: 130000 (query/sample payload budget for Claude/Codex host limits)
- Pool: max 10 connections, 30s idle timeout, 10s connection timeout
- SSL: `rejectUnauthorized: true` (required for Neon)

## Environment

**Required:** `NEON_PG_CONNECTION_STRING` - Neon PostgreSQL connection string with SSL

```bash
export NEON_PG_CONNECTION_STRING="postgresql://user:password@host/database?sslmode=require"
```

## MCP Integration

### Claude Desktop Configuration

```json
{
  "neon-postgres": {
    "command": "node",
    "args": ["/path/to/neon-pg-server/pg-mcp-server.js"],
    "env": {
      "NEON_PG_CONNECTION_STRING": "your-connection-string"
    }
  }
}
```

### Protocol Notes

- Server uses stdio transport (stdin/stdout for MCP messages, stderr for logs)
- Handles SIGINT/SIGTERM for graceful pool shutdown
- Query tool validates SQL starts with SELECT/WITH/EXPLAIN, accepts trailing semicolons, and runs read-only
- Execute tool rejects SELECT (enforces tool separation)
- Tool metadata includes titles, read/write annotations, structured outputs, server instructions, completions, and structured logging

---

## Universal Claude Code Standards

### Credential Security (CRITICAL)

- **NEVER hardcode credentials** - this project correctly uses `process.env.NEON_PG_CONNECTION_STRING`
- ALWAYS fail explicitly if credentials missing (see line 6-9 of pg-mcp-server.js)

### Core Mindset

| Principle | Application |
|-----------|-------------|
| **Surgical fixes** | Fix specific MCP tool handlers, don't rewrite server |
| **Assume correct** | Current SQL validation logic is intentional |
| **Check git first** | `git log --oneline -20` before any changes |

### Before Writing Code

1. Check recent commits: `git log --oneline -20`
2. Search existing code: `rg "pattern" .`
3. Trace flow: MCP request → handler → pool.query → response

### Code Quality

- **No `any` types** in TypeScript
- **No console.log** - use `console.error` for MCP servers (stdout is protocol)
- **Parameterized queries** - always use `$1, $2` placeholders, never string concatenation

### Git Workflow

```bash
git status                        # Check changes
git add <specific-files>          # Stage only your files (NEVER git add .)
git diff --cached                 # Review staged
git commit -m "type(scope): msg"  # Conventional commit
```

**Commit types:** `feat`, `fix`, `refactor`, `docs`, `chore`

### Testing Changes

1. Set `NEON_PG_CONNECTION_STRING` environment variable
2. Run `node pg-mcp-server.js` - should output "neon-pg MCP v1.3.0" to stderr
3. Test with MCP client or send JSON-RPC via stdin
