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

Production `pg-mcp-server.js` exposes 9 tools:
- `list_projects` - Configured project connections (name, host, database, default/readonly flags; never credentials)
- `query` - Read-only SELECT/WITH/EXPLAIN queries only (unbounded top-level results are capped at 100 rows)
- `execute` - INSERT/UPDATE/DELETE statements; REQUIRES an explicit `project` argument and refuses projects in `NEON_PG_READONLY_PROJECTS`
- `list_slow_queries` - Read-only `pg_stat_statements` performance hotspots
- `get_tables` - List tables in public schema
- `get_schema` - Schema overview with pagination and backup/archive filtering
- `describe_table` - Table structure, columns, keys, indexes, enums, JSONB keys
- `sample_data` - Small row samples with inferred JSONB structures
- `search_schema` - Table and column name search

Legacy examples (`index.js`, `basic-pg-server.js`, `src/index.ts`) expose the smaller 4-tool surface.

All tools except `list_projects` take an optional `project` argument selecting a named connection (default: the `default` project); every result and error carries a `source` block naming the project, database, and host it ran against.

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
- `list_slow_queries`: requires `pg_stat_statements`; returns a setup note if the extension is absent
- Pool: max 10 connections, 30s idle timeout, 10s connection timeout
- SSL: `rejectUnauthorized: true` (required for Neon)

## Environment

At least one of the first two is required:

- `NEON_PG_CONNECTION_STRING` - Single Neon connection string with SSL, registered as project `default` (legacy setup, still supported)
- `NEON_PG_CONNECTIONS` - JSON map of project name -> connection string for multi-project setups
- `NEON_PG_CONNECTIONS_FILE` - Path to a JSON file with the same map; lets many registrations on one machine share a single gitignored connections file. Merge order: string, then file, then inline JSON (later wins per name)
- `NEON_PG_READONLY_PROJECTS` - Optional comma-separated project names where `execute` is refused

```bash
export NEON_PG_CONNECTION_STRING="postgresql://user:password@host/database?sslmode=require"
export NEON_PG_CONNECTIONS='{"versemind":"postgresql://...","linecrush":"postgresql://..."}'
export NEON_PG_READONLY_PROJECTS="linecrush"
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

1. Set `NEON_PG_CONNECTION_STRING` (and/or `NEON_PG_CONNECTIONS`) environment variable
2. Run `node pg-mcp-server.js` - should output "neon-pg MCP v1.9.0" plus the configured project list to stderr
3. Test with MCP client or send JSON-RPC via stdin
4. Run `node test-security-fixes.js` for the source-level regression suite
