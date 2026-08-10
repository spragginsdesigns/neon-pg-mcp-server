import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  CompleteRequestSchema,
  SetLevelRequestSchema,
  ErrorCode,
  McpError
} from "@modelcontextprotocol/sdk/types.js";
import pg from 'pg';
import { readFileSync } from 'node:fs';

const PROJECT_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

function addConnectionsJson(raw, label, connections) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label} must be valid JSON mapping project names to connection strings: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object mapping project names to connection strings`);
  }
  for (const [name, connectionString] of Object.entries(parsed)) {
    if (!PROJECT_NAME_PATTERN.test(name)) {
      throw new Error(`${label} project name "${name}" is invalid; use letters, digits, "_", "-", or "."`);
    }
    if (typeof connectionString !== 'string' || connectionString.length === 0) {
      throw new Error(`${label} entry "${name}" must be a non-empty connection string`);
    }
    if (connections.has(name)) {
      console.error(`neon-pg: ${label} entry "${name}" overrides an earlier definition`);
    }
    connections.set(name, connectionString);
  }
}

// Sources are merged in order; later sources override earlier ones per name:
// 1. NEON_PG_CONNECTION_STRING          -> project "default" (legacy single setup)
// 2. NEON_PG_CONNECTIONS_FILE (JSON)    -> shared per-machine connections map
// 3. NEON_PG_CONNECTIONS (inline JSON)  -> per-registration overrides
function loadConnections() {
  const connections = new Map();

  const single = process.env.NEON_PG_CONNECTION_STRING;
  if (single) {
    connections.set('default', single);
  }

  const filePath = process.env.NEON_PG_CONNECTIONS_FILE;
  if (filePath) {
    let raw;
    try {
      raw = readFileSync(filePath, 'utf8');
    } catch (error) {
      throw new Error(`NEON_PG_CONNECTIONS_FILE could not be read (${filePath}): ${error.message}`);
    }
    addConnectionsJson(raw, `NEON_PG_CONNECTIONS_FILE (${filePath})`, connections);
  }

  const multiRaw = process.env.NEON_PG_CONNECTIONS;
  if (multiRaw) {
    addConnectionsJson(multiRaw, 'NEON_PG_CONNECTIONS', connections);
  }

  if (connections.size === 0) {
    throw new Error('Set NEON_PG_CONNECTION_STRING (single database), NEON_PG_CONNECTIONS (JSON map of project name -> connection string), or NEON_PG_CONNECTIONS_FILE (path to that JSON)');
  }

  return connections;
}

const CONNECTIONS = loadConnections();
const DEFAULT_PROJECT = CONNECTIONS.has('default')
  ? 'default'
  : (CONNECTIONS.size === 1 ? [...CONNECTIONS.keys()][0] : null);

const READONLY_PROJECTS = new Set(
  (process.env.NEON_PG_READONLY_PROJECTS || '')
    .split(',')
    .map(name => name.trim())
    .filter(Boolean)
);
for (const name of READONLY_PROJECTS) {
  if (!CONNECTIONS.has(name)) {
    console.error(`neon-pg: NEON_PG_READONLY_PROJECTS names unknown project "${name}"`);
  }
}

function projectNames() {
  return [...CONNECTIONS.keys()];
}

// Per-project metadata, parsed once at startup. `source` is the block stamped
// on every tool result; it never contains credentials.
const PROJECT_INFO = new Map([...CONNECTIONS.entries()].map(([name, connectionString]) => {
  let host = null;
  let database = null;
  try {
    const url = new URL(connectionString);
    host = url.hostname;
    database = decodeURIComponent(url.pathname.replace(/^\//, '')) || null;
  } catch {
    // Unparseable connection string; source falls back to nulls.
  }
  const readonly = READONLY_PROJECTS.has(name);
  const source = { project: name, database, host };
  if (readonly) source.readonly = true;
  return [name, {
    name,
    host,
    database,
    default: name === DEFAULT_PROJECT,
    readonly,
    source: Object.freeze(source)
  }];
}));

function projectSource(project) {
  return PROJECT_INFO.get(project).source;
}

function configuredProjectsHint() {
  return `Configured projects: ${projectNames().join(', ')}`;
}

function resolveProject(args, { forWrite = false, toolName = 'this tool' } = {}) {
  const requested = args?.project;

  if (requested === undefined || requested === null || requested === '') {
    if (forWrite) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `${toolName} requires an explicit "project" argument so writes can never land on an unintended database. Nothing was executed. ${configuredProjectsHint()}`
      );
    }
    if (!DEFAULT_PROJECT) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `No default project is configured; pass "project". ${configuredProjectsHint()}`
      );
    }
    return DEFAULT_PROJECT;
  }

  if (typeof requested !== 'string' || !CONNECTIONS.has(requested)) {
    const suggestions = typeof requested === 'string' ? findSimilar(requested, projectNames()) : [];
    const hint = suggestions.length > 0 ? ` Did you mean: ${suggestions.join(', ')}?` : '';
    throw new McpError(
      ErrorCode.InvalidParams,
      `Unknown project "${requested}". ${configuredProjectsHint()}.${hint}`
    );
  }

  if (forWrite && READONLY_PROJECTS.has(requested)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Project "${requested}" (database ${PROJECT_INFO.get(requested).database ?? 'unknown'}) is listed in NEON_PG_READONLY_PROJECTS; ${toolName} is refused and nothing was run. Use the query tool for reads.`
    );
  }

  return requested;
}

const MAX_ROWS = 100;
const QUERY_TIMEOUT = 30000;
const RESOURCE_PAGE_SIZE = 100;
const MAX_TOOL_RESPONSE_CHARS = 130000;
const MAX_CELL_CHARS = 4000;
const JSON_SCHEMA_URI = "https://json-schema.org/draft/2020-12/schema";
const JSON_MIME_TYPE = "application/json";
const SAFE_IDENTIFIER_PATTERN = "^[a-zA-Z_][a-zA-Z0-9_]*$";
const LOG_LEVELS = ["debug", "info", "notice", "warning", "error", "critical", "alert", "emergency"];
const SERVER_INSTRUCTIONS = [
  "This server exposes one or more named Neon Postgres projects for live schema discovery and SQL work.",
  "Call list_projects to see the configured projects; pass the optional project argument on any tool to target a specific one.",
  "Every tool result carries a source block naming the project, database, and host it ran against — always check it before trusting or acting on results.",
  "Use query for read-only SELECT, WITH, and EXPLAIN statements; it runs read-only and safely caps unbounded top-level result sets, so do not add LIMIT only to satisfy the server.",
  "Use list_slow_queries to find pg_stat_statements performance hotspots before tuning SQL.",
  "Use get_schema, search_schema, describe_table, and sample_data to verify table names, columns, JSONB keys, enums, and real row shapes before writing complex SQL.",
  "Use execute only for intentional INSERT, UPDATE, DELETE, or DDL changes; execute always requires an explicit project argument and refuses projects marked read-only."
].join(" ");

const COMMON_SURFACES = [
  "picks",
  "sonar",
  "games",
  "users",
  "players",
  "videos",
  "x_scraper",
  "bot_analysis",
  "vibe_bet_generator",
  "referrals",
  "subscriptions",
  "odds"
];

const COMMON_PIPELINES = [
  "vibe_reports_to_vibe_bets",
  "x_tweets_to_bot_analysis",
  "odds_feed_to_sonar",
  "games_to_picks",
  "users_to_referrals",
  "videos_to_analysis"
];

const GENERIC_OBJECT_SCHEMA = {
  type: "object",
  additionalProperties: true
};

const SOURCE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  description: "Which configured project, database, and host this result ran against.",
  properties: {
    project: { type: "string" },
    database: { type: ["string", "null"] },
    host: { type: ["string", "null"] },
    readonly: { type: "boolean" }
  },
  required: ["project", "database", "host"]
};

const PROJECT_ARG_SCHEMA = {
  type: "string",
  description: "Named project connection to run against (see list_projects). Defaults to the \"default\" project."
};

const LIST_PROJECTS_RESULT_SCHEMA = {
  $schema: JSON_SCHEMA_URI,
  type: "object",
  additionalProperties: false,
  properties: {
    projects: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          host: { type: ["string", "null"] },
          database: { type: ["string", "null"] },
          default: { type: "boolean" },
          readonly: { type: "boolean" }
        },
        required: ["name", "host", "database", "default", "readonly"]
      }
    },
    defaultProject: { type: ["string", "null"] },
    note: { type: "string" }
  },
  required: ["projects", "defaultProject"]
};

const QUERY_RESULT_SCHEMA = {
  $schema: JSON_SCHEMA_URI,
  type: "object",
  additionalProperties: false,
  properties: {
    source: SOURCE_SCHEMA,
    rowCount: { type: "integer" },
    rows: { type: "array", items: GENERIC_OBJECT_SCHEMA },
    fields: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          dataTypeID: { type: "number" }
        },
        required: ["name", "dataTypeID"]
      }
    },
    warning: { type: "string" },
    payloadWarning: { type: "string" },
    payloadTruncated: { type: "boolean" },
    truncatedRows: { type: "integer" },
    truncatedCells: { type: "integer" },
    approxBytes: { type: "integer" },
    defaultLimitApplied: { type: "boolean" },
    maxRows: { type: "integer" }
  },
  required: ["source", "rowCount", "rows", "fields"]
};

const EXECUTE_RESULT_SCHEMA = {
  $schema: JSON_SCHEMA_URI,
  type: "object",
  additionalProperties: false,
  properties: {
    source: SOURCE_SCHEMA,
    command: { type: "string" },
    rowCount: { type: "integer" }
  },
  required: ["source", "command", "rowCount"]
};

const TABLES_RESULT_SCHEMA = {
  $schema: JSON_SCHEMA_URI,
  type: "object",
  additionalProperties: false,
  properties: {
    source: SOURCE_SCHEMA,
    tables: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          table_name: { type: "string" },
          size: { type: "string" },
          cols: { type: ["number", "string"] }
        },
        required: ["table_name", "size", "cols"]
      }
    }
  },
  required: ["source", "tables"]
};

const SCHEMA_OVERVIEW_RESULT_SCHEMA = {
  $schema: JSON_SCHEMA_URI,
  type: "object",
  additionalProperties: false,
  properties: {
    source: SOURCE_SCHEMA,
    tables: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          size: { type: "string" },
          rows: { type: "number" },
          columns: { type: "number" },
          comment: { type: "string" }
        },
        required: ["name", "size", "rows", "columns"]
      }
    },
    pagination: {
      type: "object",
      additionalProperties: false,
      properties: {
        returned: { type: "number" },
        total: { type: "number" },
        offset: { type: "number" },
        limit: { type: "number" },
        has_more: { type: "boolean" }
      },
      required: ["returned", "total", "offset", "limit", "has_more"]
    },
    note: { type: "string" }
  },
  required: ["source", "tables", "pagination"]
};

const TABLE_SCHEMA_RESULT_SCHEMA = {
  $schema: JSON_SCHEMA_URI,
  type: "object",
  additionalProperties: false,
  properties: {
    source: SOURCE_SCHEMA,
    table: { type: "string" },
    columns: { type: "array", items: GENERIC_OBJECT_SCHEMA },
    primaryKeys: { type: "array", items: { type: "string" } },
    size: { type: "string" },
    rowEstimate: { type: ["number", "string"] },
    foreignKeys: { type: "array", items: GENERIC_OBJECT_SCHEMA },
    indexes: { type: "array", items: { type: "string" } },
    enums: GENERIC_OBJECT_SCHEMA,
    jsonbKeys: GENERIC_OBJECT_SCHEMA
  },
  required: ["source", "table", "columns", "primaryKeys", "size", "rowEstimate"]
};

const SAMPLE_DATA_RESULT_SCHEMA = {
  $schema: JSON_SCHEMA_URI,
  type: "object",
  additionalProperties: false,
  properties: {
    source: SOURCE_SCHEMA,
    table: { type: "string" },
    rowCount: { type: "integer" },
    rows: { type: "array", items: GENERIC_OBJECT_SCHEMA },
    jsonb_structures: GENERIC_OBJECT_SCHEMA,
    payloadWarning: { type: "string" },
    payloadTruncated: { type: "boolean" },
    truncatedRows: { type: "integer" },
    truncatedCells: { type: "integer" },
    approxBytes: { type: "integer" }
  },
  required: ["source", "table", "rowCount", "rows"]
};

const SEARCH_SCHEMA_RESULT_SCHEMA = {
  $schema: JSON_SCHEMA_URI,
  type: "object",
  additionalProperties: false,
  properties: {
    source: SOURCE_SCHEMA,
    pattern: { type: "string" },
    matching_tables: { type: "array", items: { type: "string" } },
    matching_columns: { type: "array", items: { type: "string" } }
  },
  required: ["source", "pattern", "matching_tables", "matching_columns"]
};

const SQL_STAT_NUMBER_SCHEMA = { type: ["number", "string", "null"] };

const SLOW_QUERIES_RESULT_SCHEMA = {
  $schema: JSON_SCHEMA_URI,
  type: "object",
  additionalProperties: false,
  properties: {
    source: SOURCE_SCHEMA,
    extensionInstalled: { type: "boolean" },
    slowQueries: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          queryId: { type: ["string", "null"] },
          query: { type: "string" },
          calls: SQL_STAT_NUMBER_SCHEMA,
          totalExecTimeMs: SQL_STAT_NUMBER_SCHEMA,
          meanExecTimeMs: SQL_STAT_NUMBER_SCHEMA,
          minExecTimeMs: SQL_STAT_NUMBER_SCHEMA,
          maxExecTimeMs: SQL_STAT_NUMBER_SCHEMA,
          rows: SQL_STAT_NUMBER_SCHEMA,
          sharedBlocks: GENERIC_OBJECT_SCHEMA,
          tempBlocks: GENERIC_OBJECT_SCHEMA,
          wal: GENERIC_OBJECT_SCHEMA
        },
        required: ["query", "calls", "totalExecTimeMs", "meanExecTimeMs", "rows"]
      }
    },
    totalQueriesFound: { type: "integer" },
    limit: { type: "integer" },
    orderBy: { type: "string" },
    minMeanMs: { type: "number" },
    note: { type: "string" },
    installSql: { type: "string" },
    payloadWarning: { type: "string" },
    payloadTruncated: { type: "boolean" },
    truncatedRows: { type: "integer" },
    truncatedCells: { type: "integer" },
    approxBytes: { type: "integer" }
  },
  required: ["source", "extensionInstalled", "slowQueries", "totalQueriesFound", "limit", "orderBy", "minMeanMs"]
};

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

// Helper: Validate identifier is safe for SQL interpolation
const SAFE_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
function assertSafeIdentifier(name, kind = 'identifier') {
  if (!SAFE_IDENTIFIER.test(name)) {
    throw new McpError(ErrorCode.InvalidParams, `Invalid ${kind}: "${name}" contains unsafe characters`);
  }
}

function encodeCursor(offset) {
  return Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64');
}

function decodeCursor(cursor) {
  if (!cursor) return 0;

  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8'));
    if (!Number.isInteger(parsed.offset) || parsed.offset < 0) {
      throw new Error('offset must be a non-negative integer');
    }
    return parsed.offset;
  } catch (error) {
    throw new McpError(ErrorCode.InvalidParams, `Invalid cursor: ${error.message}`);
  }
}

function createStructuredToolResult(data, extras = {}) {
  return {
    content: [{
      type: "text",
      text: JSON.stringify(data, null, 2)
    }],
    structuredContent: data,
    ...extras
  };
}

function createToolErrorResult(message, source, structuredContent) {
  const prefix = source ? `[project=${source.project} database=${source.database ?? "unknown"}] ` : "";
  const result = {
    content: [{
      type: "text",
      text: `${prefix}${message}`
    }],
    isError: true
  };

  const structured = { error: message, ...(structuredContent ?? {}) };
  if (source) structured.source = source;
  result.structuredContent = structured;

  return result;
}

function createJsonResource(uri, data) {
  return {
    contents: [{
      uri,
      mimeType: JSON_MIME_TYPE,
      text: JSON.stringify(data, null, 2)
    }]
  };
}

function jsonSize(value) {
  return JSON.stringify(value).length;
}

function truncateString(value, maxChars) {
  if (value.length <= maxChars) return { value, truncated: false };
  const omitted = value.length - maxChars;
  return {
    value: `${value.slice(0, maxChars)}... [truncated ${omitted} chars]`,
    truncated: true
  };
}

function budgetCellValue(value) {
  if (typeof value === "string") {
    return truncateString(value, MAX_CELL_CHARS);
  }

  if (value === null || typeof value !== "object") {
    return { value, truncated: false };
  }

  const serialized = JSON.stringify(value);
  if (serialized.length <= MAX_CELL_CHARS) {
    return { value, truncated: false };
  }

  const preview = serialized.slice(0, MAX_CELL_CHARS);
  return {
    value: {
      __truncated: true,
      type: Array.isArray(value) ? "array" : "object",
      originalBytes: serialized.length,
      preview: `${preview}... [truncated ${serialized.length - MAX_CELL_CHARS} chars]`
    },
    truncated: true
  };
}

function budgetRowsPayload(payload, rowKey = "rows") {
  if (!Array.isArray(payload[rowKey]) || jsonSize(payload) <= MAX_TOOL_RESPONSE_CHARS) {
    return payload;
  }

  let truncatedCells = 0;
  let rows = payload[rowKey].map(row => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      const budgeted = budgetCellValue(row);
      if (budgeted.truncated) truncatedCells++;
      return budgeted.value;
    }

    const nextRow = {};
    for (const [key, value] of Object.entries(row)) {
      const budgeted = budgetCellValue(value);
      if (budgeted.truncated) truncatedCells++;
      nextRow[key] = budgeted.value;
    }
    return nextRow;
  });

  let nextPayload = {
    ...payload,
    [rowKey]: rows,
    payloadTruncated: true,
    truncatedCells
  };

  if (jsonSize(nextPayload) > MAX_TOOL_RESPONSE_CHARS) {
    const originalRows = rows.length;
    let low = 0;
    let high = rows.length;
    let best = [];

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const candidate = {
        ...nextPayload,
        [rowKey]: rows.slice(0, mid),
        truncatedRows: originalRows - mid
      };

      if (jsonSize(candidate) <= MAX_TOOL_RESPONSE_CHARS) {
        best = candidate[rowKey];
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    nextPayload = {
      ...nextPayload,
      [rowKey]: best,
      truncatedRows: originalRows - best.length
    };
  }

  const rowMessage = nextPayload.truncatedRows > 0 ? ` and ${nextPayload.truncatedRows} rows` : "";
  nextPayload.payloadWarning = `Tool result was reduced below ${MAX_TOOL_RESPONSE_CHARS} characters for Claude/Codex host limits; truncated ${truncatedCells} large cells${rowMessage}. Refine the query or select specific columns for full values.`;
  nextPayload.approxBytes = jsonSize(nextPayload);
  return nextPayload;
}

function maskSqlLiteralsAndComments(sql) {
  let masked = "";
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];

    const dollarQuote = sql.slice(i).match(/^\$[a-zA-Z_][a-zA-Z0-9_]*\$|^\$\$/);
    if (dollarQuote) {
      const tag = dollarQuote[0];
      const end = sql.indexOf(tag, i + tag.length);
      if (end !== -1) {
        const length = end + tag.length - i;
        masked += " ".repeat(length);
        i += length;
        continue;
      }
    }

    if (ch === "'") {
      masked += " ";
      i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          masked += "  ";
          i += 2;
          continue;
        }
        masked += sql[i] === "\n" ? "\n" : " ";
        if (sql[i] === "'") {
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    if (ch === '"') {
      masked += " ";
      i++;
      while (i < sql.length) {
        if (sql[i] === '"' && sql[i + 1] === '"') {
          masked += "  ";
          i += 2;
          continue;
        }
        masked += sql[i] === "\n" ? "\n" : " ";
        if (sql[i] === '"') {
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    if (ch === "-" && next === "-") {
      masked += "  ";
      i += 2;
      while (i < sql.length && sql[i] !== "\n") {
        masked += " ";
        i++;
      }
      continue;
    }

    if (ch === "/" && next === "*") {
      let depth = 1;
      masked += "  ";
      i += 2;

      while (i < sql.length && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          masked += "  ";
          i += 2;
          depth++;
          continue;
        }
        if (sql[i] === "*" && sql[i + 1] === "/") {
          masked += "  ";
          i += 2;
          depth--;
          continue;
        }
        masked += sql[i] === "\n" ? "\n" : " ";
        i++;
      }
      continue;
    }

    masked += ch;
    i++;
  }

  return masked;
}

function isSqlWordAt(sql, index, word) {
  const segment = sql.slice(index, index + word.length);
  if (segment.toLowerCase() !== word) return false;

  const before = index === 0 ? "" : sql[index - 1];
  const after = sql[index + word.length] || "";
  return !/[a-zA-Z0-9_$]/.test(before) && !/[a-zA-Z0-9_$]/.test(after);
}

function normalizeSingleSqlStatement(rawSql) {
  const sql = rawSql.trim();
  const masked = maskSqlLiteralsAndComments(sql);
  const firstSemicolon = masked.indexOf(";");

  if (firstSemicolon === -1) return sql;

  const tail = masked.slice(firstSemicolon).replace(/;/g, "").trim();
  if (tail.length > 0) {
    throw new McpError(ErrorCode.InvalidParams, "Send one SELECT, WITH, or EXPLAIN statement at a time");
  }

  return sql.slice(0, firstSemicolon).trim();
}

function hasTopLevelResultLimit(sql) {
  const masked = maskSqlLiteralsAndComments(sql);
  let depth = 0;

  for (let i = 0; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === "(") {
      depth++;
      continue;
    }
    if (ch === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }

    if (depth !== 0) continue;

    if (isSqlWordAt(masked, i, "limit")) return true;
    if (isSqlWordAt(masked, i, "fetch") && /^fetch\s+(first|next)\b/i.test(masked.slice(i))) {
      return true;
    }
  }

  return false;
}

function prepareReadOnlySql(rawSql) {
  const sql = normalizeSingleSqlStatement(rawSql);
  const lower = sql.toLowerCase();

  if (!lower.startsWith('select') && !lower.startsWith('with') && !lower.startsWith('explain')) {
    throw new McpError(ErrorCode.InvalidParams, "Use SELECT, WITH, or EXPLAIN queries only");
  }

  const isExplain = lower.startsWith('explain');
  const hasUserLimit = isExplain || hasTopLevelResultLimit(sql);
  const text = hasUserLimit ? sql : `SELECT * FROM (\n${sql}\n) AS mcp_limited_result LIMIT ${MAX_ROWS}`;

  return {
    sql,
    text,
    isExplain,
    hasUserLimit,
    defaultLimitApplied: !hasUserLimit
  };
}

async function runReadOnlyQuery(project, text, params = []) {
  const client = await getPool(project).connect();

  try {
    await client.query('BEGIN READ ONLY');
    await client.query(`SET LOCAL statement_timeout = ${QUERY_TIMEOUT}`);
    const result = await client.query({ text, values: params });
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Ignore rollback failures so the original query error is preserved.
    }
    throw error;
  } finally {
    client.release();
  }
}

// Helper: Get all table names per project (cached for error suggestions)
const schemaCaches = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

let latestQueryResource = {
  status: "empty",
  message: "Run the query tool to populate this resource."
};

let latestExplainResource = {
  status: "empty",
  message: "Run an EXPLAIN query with the query tool to populate this resource."
};

let minimumLogLevel = "warning";

function shouldEmitLog(level) {
  return LOG_LEVELS.indexOf(level) >= LOG_LEVELS.indexOf(minimumLogLevel);
}

async function sendServerLog(level, logger, data) {
  if (!shouldEmitLog(level)) return;

  try {
    await server.sendLoggingMessage({ level, logger, data });
  } catch {
    // Logging is best-effort and must never break tool responses.
  }
}

function recordDuration(startedAt) {
  return Date.now() - startedAt;
}

function invalidateSchemaCache(project) {
  schemaCaches.delete(project);
}

async function getSchemaCache(project) {
  const cached = schemaCaches.get(project);
  if (cached && Date.now() - cached.timestamp <= CACHE_TTL) {
    return cached;
  }

  const pool = getPool(project);
  const [tablesResult, columnsResult] = await Promise.all([
    pool.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `),
    pool.query(`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public'
    `)
  ]);

  const next = {
    tables: tablesResult.rows.map(r => r.table_name),
    columns: columnsResult.rows,
    timestamp: Date.now()
  };
  schemaCaches.set(project, next);
  return next;
}

// Helper: Parse PostgreSQL error and add suggestions
async function enhanceError(project, error, sql) {
  const msg = error.message || '';

  let tables;
  let columns;
  try {
    ({ tables, columns } = await getSchemaCache(project));
  } catch {
    // Schema lookup failed (e.g. connection is down); fall back to the raw error.
    return msg;
  }

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

function updateLatestQueryResources({ project, sql, result, isExplain }) {
  const snapshot = {
    project,
    sql,
    capturedAt: new Date().toISOString(),
    result
  };

  latestQueryResource = snapshot;

  if (isExplain) {
    latestExplainResource = snapshot;
  }
}

function buildStaticResources() {
  return [
    {
      uri: "neon://schema/overview",
      name: "Schema Overview",
      title: "Neon Schema Overview",
      description: "High-level snapshot of the current database schema.",
      mimeType: JSON_MIME_TYPE,
      annotations: { audience: ["assistant"], priority: 0.95 }
    },
    {
      uri: "neon://session/latest-query",
      name: "Latest Query Result",
      title: "Latest Query Result",
      description: "Most recent result returned by the query tool in this MCP session.",
      mimeType: JSON_MIME_TYPE,
      annotations: { audience: ["assistant"], priority: 0.7 }
    },
    {
      uri: "neon://session/latest-explain",
      name: "Latest Query Plan",
      title: "Latest Query Plan",
      description: "Most recent EXPLAIN result returned by the query tool in this MCP session.",
      mimeType: JSON_MIME_TYPE,
      annotations: { audience: ["assistant"], priority: 0.7 }
    }
  ];
}

function buildTableResources(tables) {
  return tables.flatMap(table => ([
    {
      uri: `neon://table/${encodeURIComponent(table)}/schema`,
      name: `${table} schema`,
      title: `${table} Schema`,
      description: `Detailed schema for table "${table}".`,
      mimeType: JSON_MIME_TYPE,
      annotations: { audience: ["assistant"], priority: 0.85 }
    },
    {
      uri: `neon://table/${encodeURIComponent(table)}/sample`,
      name: `${table} sample`,
      title: `${table} Sample Data`,
      description: `Sample rows and inferred JSON structure for table "${table}".`,
      mimeType: JSON_MIME_TYPE,
      annotations: { audience: ["assistant"], priority: 0.65 }
    }
  ]));
}

async function listResources(cursor) {
  const offset = decodeCursor(cursor);
  let tableResources = [];
  if (DEFAULT_PROJECT) {
    const { tables } = await getSchemaCache(DEFAULT_PROJECT);
    tableResources = buildTableResources(tables);
  }
  const resources = [...buildStaticResources(), ...tableResources];
  const page = resources.slice(offset, offset + RESOURCE_PAGE_SIZE);
  const nextOffset = offset + page.length;

  return {
    resources: page,
    ...(nextOffset < resources.length ? { nextCursor: encodeCursor(nextOffset) } : {})
  };
}

function requirePromptArg(args, key) {
  const value = args?.[key];
  if (!value || typeof value !== 'string') {
    throw new McpError(ErrorCode.InvalidParams, `Prompt argument "${key}" is required`);
  }
  return value;
}

function promptTextMessage(text) {
  return {
    role: "user",
    content: {
      type: "text",
      text
    }
  };
}

function getPrompt(name, args = {}) {
  switch (name) {
    case "understand_schema":
      return {
        description: "Orient yourself to the LineCrush database before writing queries.",
        messages: [
          promptTextMessage(`You are working with the LineCrush database in Neon Postgres.

Start by building a live mental model from the database itself instead of assuming the schema from memory.

Follow this workflow:
1. Run \`get_schema\` first to see the current high-level schema overview and the largest or most important tables.
2. Use \`search_schema\` to find tables related to the current product surface or concept you care about.
3. Use \`describe_table\` on the most relevant tables to inspect columns, enums, foreign keys, indexes, and JSONB key structures.
4. Use \`sample_data\` to inspect real row shapes and values before writing complex queries.
5. Summarize the key relationships, major product surfaces, and likely source-of-truth tables before proceeding.

Important LineCrush context:
- Product surfaces often include picks, vibe bet generation, sonar, games, users, players, videos, x/twitter ingestion, bot analysis, and odds pipelines.
- Sport names are usually uppercase strings like NBA, NFL, MLB, NHL, MMA, BKFC, PGA, EPL, Boxing, Tennis, F1, WNBA, and NASCAR.
- Large tables should be filtered aggressively; avoid broad \`SELECT *\` queries on huge event or odds tables.
- JSONB columns are common, especially for odds, reports, and analysis payloads, so inspect JSONB keys before filtering.

Use the tools to discover the current truth, then explain the schema in plain language.`)
        ]
      };
    case "investigate_product_surface": {
      const surfaceName = requirePromptArg(args, "surface_name");
      return {
        description: `Investigate how the ${surfaceName} surface works in the LineCrush database.`,
        messages: [
          promptTextMessage(`Investigate the LineCrush product surface "${surfaceName}" using the live database schema.

Do this in order:
1. Use \`search_schema\` to find all tables whose names or columns seem related to "${surfaceName}".
2. From those matches, identify the likely core tables and run \`describe_table\` on each.
3. Run \`sample_data\` on the most important tables to understand row shape and domain meaning.
4. Map the data flow:
   - where records are created
   - which tables reference each other
   - which columns likely drive frontend behavior, alerts, generation, grading, ingestion, or user state
5. Call out heavy JSONB columns, enums, foreign keys, and large tables that need careful filtering.
6. Summarize:
   - what this surface does in the product
   - which tables are central
   - which tables are upstream/downstream
   - what an engineer should know before changing it

Use live schema discovery, not assumptions. If the surface touches multiple systems like scraping, generation, grading, odds, or frontend delivery, explain how they connect.`)
        ]
      };
    }
    case "explore_table": {
      const tableName = requirePromptArg(args, "table_name");
      return {
        description: `Explore the ${tableName} table in depth.`,
        messages: [
          promptTextMessage(`Explore the table "${tableName}" in the LineCrush database. Do this in order:

1. Run \`describe_table\` for "${tableName}" to inspect columns, types, foreign keys, indexes, enums, and JSONB key structures.
2. Run \`sample_data\` for "${tableName}" to inspect real row shapes and actual values.
3. Identify and call out:
   - JSONB columns and the keys they contain
   - enum columns and allowed values
   - foreign key relationships
   - fields with important domain meaning
4. Explain what this table appears to represent in the product and how it connects to nearby systems.
5. If it seems central, mention which other tables should be inspected next.

Focus on practical understanding, not just column listing.`)
        ]
      };
    }
    case "investigate_query_error": {
      const failingSql = requirePromptArg(args, "failing_sql");
      const errorMessage = args.error_message || "No error message provided.";
      return {
        description: "Debug a failing or unexpected SQL query against the LineCrush database.",
        messages: [
          promptTextMessage(`A SQL query against the LineCrush database is failing or returning unexpected results.

Failing SQL:
\`\`\`sql
${failingSql}
\`\`\`

Error message:
${errorMessage}

Investigate using this workflow:
1. Parse the query and identify all referenced tables, joins, filters, and columns.
2. Use \`search_schema\` to confirm the referenced tables and discover similarly named alternatives if needed.
3. Use \`describe_table\` on each relevant table to verify column names, data types, nullability, enums, foreign keys, and JSONB structures.
4. Check for common LineCrush issues:
   - the field is inside JSONB rather than top-level
   - the table or column name is slightly different than expected
   - sport values need uppercase strings
   - user identifiers differ across tables
   - large odds or event tables need strong filters
5. Rewrite the query with the correct schema assumptions.
6. Test the corrected query and explain the fix clearly.

Use the database tools to prove the fix rather than guessing.`)
        ]
      };
    }
    case "trace_data_pipeline": {
      const pipelineName = requirePromptArg(args, "pipeline_name");
      return {
        description: `Trace the ${pipelineName} data pipeline through the LineCrush database.`,
        messages: [
          promptTextMessage(`Trace the LineCrush data pipeline "${pipelineName}" through the database.

Goal: explain how data moves from upstream ingestion or generation to downstream product behavior.

Workflow:
1. Use \`search_schema\` to identify all likely tables involved in "${pipelineName}".
2. Use \`describe_table\` on the most relevant tables to inspect keys, timestamps, enums, JSONB payloads, and relationships.
3. Use \`sample_data\` where needed to inspect actual row shapes and lifecycle clues.
4. Determine:
   - where data first enters the system
   - which tables transform or enrich it
   - which tables power user-facing features
   - which timestamps or status columns indicate lifecycle state
5. Summarize the pipeline as a step-by-step flow and note likely failure points, stale-data risks, or places where filtering matters.

Be concrete and trace actual tables, not just abstract concepts.`)
        ]
      };
    }
    default:
      throw new McpError(ErrorCode.MethodNotFound, `Unknown prompt: ${name}`);
  }
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

// Lazy per-project pools, created on first use and cached.
const pools = new Map();

function getPool(project) {
  let pool = pools.get(project);
  if (!pool) {
    pool = new pg.Pool({
      connectionString: CONNECTIONS.get(project),
      ssl: { rejectUnauthorized: true },
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000
    });
    pools.set(project, pool);
  }
  return pool;
}

function requireDefaultProject() {
  if (!DEFAULT_PROJECT) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Resources are served from the default project, but none is configured. ${configuredProjectsHint()}`
    );
  }
  return DEFAULT_PROJECT;
}

const server = new Server(
  { name: "neon-pg", version: "1.9.0" },
  {
    capabilities: {
      tools: {},
      resources: {},
      prompts: {},
      logging: {},
      completions: {}
    },
    instructions: SERVER_INSTRUCTIONS
  }
);

// Tool definitions - 9 tools
const TOOLS = [
  {
    name: "list_projects",
    title: "List Configured Projects",
    description: "List the named Neon project connections this server is configured with, including host, database, default flag, and read-only flag. Never returns credentials.",
    annotations: {
      title: "List Configured Projects",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    },
    inputSchema: {
      $schema: JSON_SCHEMA_URI,
      type: "object",
      additionalProperties: false
    },
    outputSchema: LIST_PROJECTS_RESULT_SCHEMA
  },
  {
    name: "query",
    title: "Run Read-Only SQL",
    description: `Run a read-only SQL SELECT, WITH, or EXPLAIN statement against Neon Postgres. Returns rows, field metadata, and whether the server applied its ${MAX_ROWS}-row safety cap.`,
    annotations: {
      title: "Run Read-Only SQL",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    },
    inputSchema: {
      $schema: JSON_SCHEMA_URI,
      type: "object",
      additionalProperties: false,
      properties: {
        project: PROJECT_ARG_SCHEMA,
        sql: { type: "string", minLength: 1, description: "Read-only SQL SELECT, WITH, or EXPLAIN statement. A trailing semicolon is accepted; LIMIT is optional." },
        params: {
          type: "array",
          description: "Query parameters (optional)",
          items: {
            anyOf: [
              { type: "string" },
              { type: "number" },
              { type: "boolean" },
              { type: "null" },
              { type: "object" },
              { type: "array" }
            ]
          }
        }
      },
      required: ["sql"]
    },
    outputSchema: QUERY_RESULT_SCHEMA
  },
  {
    name: "list_slow_queries",
    title: "List Slow Queries",
    description: "List the slowest statements tracked by pg_stat_statements. Use this before tuning SQL or adding indexes. Returns a clear setup note when the extension is not installed.",
    annotations: {
      title: "List Slow Queries",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    },
    inputSchema: {
      $schema: JSON_SCHEMA_URI,
      type: "object",
      additionalProperties: false,
      properties: {
        project: PROJECT_ARG_SCHEMA,
        limit: { type: "integer", minimum: 1, maximum: 25, default: 10, description: "Maximum slow queries to return. Default 10, hard cap 25." },
        order_by: {
          type: "string",
          enum: ["mean_exec_time", "total_exec_time", "calls", "rows"],
          default: "mean_exec_time",
          description: "Metric to sort by descending. Default mean_exec_time."
        },
        min_mean_ms: { type: "number", minimum: 0, default: 0, description: "Only include statements with mean execution time at or above this many milliseconds." }
      }
    },
    outputSchema: SLOW_QUERIES_RESULT_SCHEMA
  },
  {
    name: "execute",
    title: "Execute Write SQL",
    description: "Run an intentional SQL mutation or DDL statement against Neon Postgres. REQUIRES an explicit project argument naming the target database (no default is applied); refuses projects listed in NEON_PG_READONLY_PROJECTS. Does not accept SELECT; use query for reads.",
    annotations: {
      title: "Execute Write SQL",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true
    },
    inputSchema: {
      $schema: JSON_SCHEMA_URI,
      type: "object",
      additionalProperties: false,
      properties: {
        project: { type: "string", description: "REQUIRED. Named project connection to write to (see list_projects). No default is applied for writes." },
        sql: { type: "string", minLength: 1, description: "SQL INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, TRUNCATE, or other non-SELECT statement to execute." },
        params: {
          type: "array",
          description: "Statement parameters (optional)",
          items: {
            anyOf: [
              { type: "string" },
              { type: "number" },
              { type: "boolean" },
              { type: "null" },
              { type: "object" },
              { type: "array" }
            ]
          }
        }
      },
      required: ["sql", "project"]
    },
    outputSchema: EXECUTE_RESULT_SCHEMA
  },
  {
    name: "get_tables",
    title: "List Tables",
    description: "List public schema tables with approximate size and column counts.",
    annotations: {
      title: "List Tables",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    },
    inputSchema: {
      $schema: JSON_SCHEMA_URI,
      type: "object",
      additionalProperties: false,
      properties: {
        project: PROJECT_ARG_SCHEMA
      }
    },
    outputSchema: TABLES_RESULT_SCHEMA
  },
  {
    name: "get_schema",
    title: "Get Schema Overview",
    description: "Return database schema overview: tables, columns, types, keys, and JSON structures. By default excludes backup/archive tables and returns up to 50 tables ordered by size.",
    annotations: {
      title: "Get Schema Overview",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    },
    inputSchema: {
      $schema: JSON_SCHEMA_URI,
      type: "object",
      additionalProperties: false,
      properties: {
        project: PROJECT_ARG_SCHEMA,
        tables: { type: "array", items: { type: "string", pattern: SAFE_IDENTIFIER_PATTERN }, description: "Specific public table names to include; overrides limit and offset." },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 50, description: "Max tables to return. Default 50, hard cap 200." },
        offset: { type: "integer", minimum: 0, default: 0, description: "Number of tables to skip for pagination. Default 0." },
        include_all: { type: "boolean", description: "Include backup/archive tables (default false)" }
      }
    },
    outputSchema: SCHEMA_OVERVIEW_RESULT_SCHEMA
  },
  {
    name: "describe_table",
    title: "Describe Table",
    description: "Return detailed structure for one public table: columns, primary keys, foreign keys, indexes, enum values, JSONB keys, size, and row estimate.",
    annotations: {
      title: "Describe Table",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    },
    inputSchema: {
      $schema: JSON_SCHEMA_URI,
      type: "object",
      additionalProperties: false,
      properties: {
        project: PROJECT_ARG_SCHEMA,
        table: { type: "string", pattern: SAFE_IDENTIFIER_PATTERN, description: "Public table name to describe." }
      },
      required: ["table"]
    },
    outputSchema: TABLE_SCHEMA_RESULT_SCHEMA
  },
  {
    name: "sample_data",
    title: "Sample Table Data",
    description: "Return a few rows from one public table plus inferred JSON structures. For filtered samples, use query.",
    annotations: {
      title: "Sample Table Data",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    },
    inputSchema: {
      $schema: JSON_SCHEMA_URI,
      type: "object",
      additionalProperties: false,
      properties: {
        project: PROJECT_ARG_SCHEMA,
        table: { type: "string", pattern: SAFE_IDENTIFIER_PATTERN, description: "Public table name to sample from." },
        limit: { type: "integer", minimum: 1, maximum: 10, default: 3, description: "Number of rows to return. Default 3, hard cap 10." }
      },
      required: ["table"]
    },
    outputSchema: SAMPLE_DATA_RESULT_SCHEMA
  },
  {
    name: "search_schema",
    title: "Search Schema",
    description: "Search public table and column names by case-insensitive text pattern. Returns matching table names and table.column(type) matches.",
    annotations: {
      title: "Search Schema",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    },
    inputSchema: {
      $schema: JSON_SCHEMA_URI,
      type: "object",
      additionalProperties: false,
      properties: {
        project: PROJECT_ARG_SCHEMA,
        pattern: { type: "string", minLength: 1, description: "Case-insensitive text to search for in public table and column names." }
      },
      required: ["pattern"]
    },
    outputSchema: SEARCH_SCHEMA_RESULT_SCHEMA
  }
];

const PROMPTS = [
  {
    name: "understand_schema",
    title: "Understand Schema",
    description: "Understand the LineCrush database at a high level before writing queries."
  },
  {
    name: "investigate_product_surface",
    title: "Investigate Product Surface",
    description: "Trace how a specific LineCrush product surface works in the database.",
    arguments: [
      {
        name: "surface_name",
        description: "The LineCrush surface to investigate, such as picks, sonar, games, users, players, videos, x_scraper, or vibe_bet_generator.",
        required: true
      }
    ]
  },
  {
    name: "explore_table",
    title: "Explore Table",
    description: "Deep-dive into a specific LineCrush table — structure, sample data, and relationships.",
    arguments: [
      {
        name: "table_name",
        description: "The table to explore.",
        required: true
      }
    ]
  },
  {
    name: "investigate_query_error",
    title: "Investigate Query Error",
    description: "Debug a failing or unexpected SQL query against the LineCrush database.",
    arguments: [
      {
        name: "failing_sql",
        description: "The SQL query that failed or returned unexpected results.",
        required: true
      },
      {
        name: "error_message",
        description: "The error message if the query failed.",
        required: false
      }
    ]
  },
  {
    name: "trace_data_pipeline",
    title: "Trace Data Pipeline",
    description: "Follow how data moves through a specific LineCrush ingestion or product pipeline.",
    arguments: [
      {
        name: "pipeline_name",
        description: "The pipeline to trace, such as vibe_reports_to_vibe_bets, x_tweets_to_bot_analysis, or odds_feed_to_sonar.",
        required: true
      }
    ]
  }
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
  return await listResources(request.params?.cursor);
});
server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: PROMPTS }));
server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
  resourceTemplates: [
    {
      uriTemplate: "neon://table/{table}/schema",
      name: "Table Schema",
      title: "Table Schema",
      description: "Read the schema for a specific table.",
      mimeType: JSON_MIME_TYPE,
      annotations: { audience: ["assistant"], priority: 0.9 }
    },
    {
      uriTemplate: "neon://table/{table}/sample",
      name: "Table Sample Data",
      title: "Table Sample Data",
      description: "Read sample rows and inferred JSON structure for a specific table.",
      mimeType: JSON_MIME_TYPE,
      annotations: { audience: ["assistant"], priority: 0.7 }
    },
    {
      uriTemplate: "neon://table/{table}/sample/{limit}",
      name: "Table Sample Data With Limit",
      title: "Table Sample Data With Limit",
      description: "Read sample rows for a specific table with an explicit sample size.",
      mimeType: JSON_MIME_TYPE,
      annotations: { audience: ["assistant"], priority: 0.7 }
    }
  ]
}));
server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  return getPrompt(name, args);
});
server.setRequestHandler(SetLevelRequestSchema, async (request) => {
  minimumLogLevel = request.params.level;
  return {};
});
server.setRequestHandler(CompleteRequestSchema, async (request) => {
  return await completeArgument(request.params);
});
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;
  const parsed = new URL(uri);

  if (parsed.protocol !== 'neon:') {
    throw new McpError(ErrorCode.InvalidParams, `Unsupported resource URI: ${uri}`);
  }

  if (parsed.hostname === 'schema' && parsed.pathname === '/overview') {
    return createJsonResource(uri, await getSchemaOverview({}, requireDefaultProject()));
  }

  if (parsed.hostname === 'session' && parsed.pathname === '/latest-query') {
    return createJsonResource(uri, latestQueryResource);
  }

  if (parsed.hostname === 'session' && parsed.pathname === '/latest-explain') {
    return createJsonResource(uri, latestExplainResource);
  }

  if (parsed.hostname === 'table') {
    const pathParts = parsed.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const [table, resourceType, rawLimit] = pathParts;

    if (!table || !resourceType) {
      throw new McpError(ErrorCode.InvalidParams, `Invalid table resource URI: ${uri}`);
    }

    if (resourceType === 'schema') {
      return createJsonResource(uri, await getTableDescription(table, requireDefaultProject()));
    }

    if (resourceType === 'sample') {
      const limit = rawLimit === undefined ? undefined : Number(rawLimit);
      if (rawLimit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
        throw new McpError(ErrorCode.InvalidParams, `Invalid sample limit in resource URI: ${uri}`);
      }

      return createJsonResource(uri, await getSampleData(table, limit, requireDefaultProject()));
    }
  }

  throw new McpError(ErrorCode.InvalidParams, `Unknown resource URI: ${uri}`);
});

async function completeArgument(params) {
  const partial = String(params.argument?.value || "").toLowerCase();
  const name = params.argument?.name;
  const ref = params.ref || {};

  if (name === "project") {
    return createCompletionResult(filterCompletions(partial, projectNames()));
  }

  if (name === "table" || name === "table_name") {
    if (!DEFAULT_PROJECT) return createCompletionResult([]);
    const { tables } = await getSchemaCache(DEFAULT_PROJECT);
    return createCompletionResult(filterCompletions(partial, tables));
  }

  if (ref.type === "ref/prompt" && name === "surface_name") {
    return createCompletionResult(filterCompletions(partial, COMMON_SURFACES));
  }

  if (ref.type === "ref/prompt" && name === "pipeline_name") {
    return createCompletionResult(filterCompletions(partial, COMMON_PIPELINES));
  }

  if (ref.type === "ref/resource" && name === "limit") {
    return createCompletionResult(filterCompletions(partial, ["1", "3", "5", "10"]));
  }

  return createCompletionResult([]);
}

function filterCompletions(partial, candidates) {
  return candidates
    .map(value => {
      const lower = value.toLowerCase();
      let score = 2;
      if (lower.startsWith(partial)) score = 0;
      else if (lower.includes(partial)) score = 1;
      return { value, score };
    })
    .filter(item => partial.length === 0 || item.score < 2)
    .sort((a, b) => a.score - b.score || a.value.localeCompare(b.value))
    .map(item => item.value);
}

function createCompletionResult(values) {
  const limited = values.slice(0, 100);
  return {
    completion: {
      values: limited,
      total: values.length,
      hasMore: values.length > limited.length
    }
  };
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  switch (name) {
    case "list_projects": return handleListProjects();
    case "query": return await handleQuery(args);
    case "list_slow_queries": return await handleListSlowQueries(args);
    case "execute": return await handleExecute(args);
    case "get_tables": return await handleGetTables(args);
    case "get_schema": return await handleGetSchema(args);
    case "describe_table": return await handleDescribeTable(args);
    case "sample_data": return await handleSampleData(args);
    case "search_schema": return await handleSearchSchema(args);
    default: throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
  }
});

function handleListProjects() {
  const projects = [...PROJECT_INFO.values()].map(({ name, host, database, default: isDefault, readonly }) => (
    { name, host, database, default: isDefault, readonly }
  ));

  return createStructuredToolResult({
    projects,
    defaultProject: DEFAULT_PROJECT,
    note: "Read tools default to the default project when no project argument is given. execute always requires an explicit project argument."
  });
}

async function handleQuery(args) {
  const project = resolveProject(args, { toolName: "query" });
  const source = projectSource(project);

  if (!args.sql) {
    return createToolErrorResult("sql required", source);
  }

  let prepared;
  try {
    prepared = prepareReadOnlySql(args.sql);
  } catch (error) {
    return createToolErrorResult(error.message, source);
  }

  const startedAt = Date.now();

  try {
    const result = await runReadOnlyQuery(project, prepared.text, args.params || []);

    let response = {
      source,
      rowCount: result.rowCount,
      rows: result.rows,
      fields: result.fields.map(f => ({ name: f.name, dataTypeID: f.dataTypeID })),
      defaultLimitApplied: prepared.defaultLimitApplied,
      maxRows: MAX_ROWS
    };

    if (prepared.defaultLimitApplied && result.rowCount >= MAX_ROWS) {
      response.warning = `Results capped at ${MAX_ROWS} rows by the query tool. Add a top-level LIMIT or WHERE clause when you need a narrower result.`;
    }

    response = budgetRowsPayload(response);

    updateLatestQueryResources({
      project,
      sql: prepared.sql,
      result: response,
      isExplain: prepared.isExplain
    });

    await sendServerLog("info", "query", {
      project,
      durationMs: recordDuration(startedAt),
      rowCount: response.rowCount,
      returnedRows: response.rows.length,
      defaultLimitApplied: response.defaultLimitApplied,
      payloadTruncated: Boolean(response.payloadTruncated),
      isExplain: prepared.isExplain
    });

    return createStructuredToolResult(response);
  } catch (error) {
    const enhanced = await enhanceError(project, error, prepared.sql);
    await sendServerLog("error", "query", {
      project,
      durationMs: recordDuration(startedAt),
      isExplain: prepared.isExplain,
      error: enhanced
    });
    return createToolErrorResult(enhanced, source, { sql: prepared.sql });
  }
}

const SLOW_QUERY_ORDER_BY = Object.freeze({
  mean_exec_time: "mean_exec_time",
  total_exec_time: "total_exec_time",
  calls: "calls",
  rows: "rows"
});

function normalizeSlowQueryArgs(args = {}) {
  const limit = Math.min(Math.max(1, Math.trunc(Number(args.limit ?? 10))), 25);
  const minMeanMs = Number(args.min_mean_ms ?? 0);
  const orderBy = args.order_by ?? "mean_exec_time";

  if (!Number.isFinite(limit)) {
    throw new McpError(ErrorCode.InvalidParams, "limit must be a number between 1 and 25");
  }
  if (!Number.isFinite(minMeanMs) || minMeanMs < 0) {
    throw new McpError(ErrorCode.InvalidParams, "min_mean_ms must be a non-negative number");
  }
  if (!Object.hasOwn(SLOW_QUERY_ORDER_BY, orderBy)) {
    throw new McpError(ErrorCode.InvalidParams, "order_by must be one of mean_exec_time, total_exec_time, calls, rows");
  }

  return { limit, minMeanMs, orderBy, orderBySql: SLOW_QUERY_ORDER_BY[orderBy] };
}

function truncateSqlText(sql, maxLength = MAX_CELL_CHARS) {
  if (typeof sql !== "string" || sql.length <= maxLength) return sql;
  return `${sql.slice(0, maxLength)}... [truncated ${sql.length - maxLength} chars]`;
}

async function handleListSlowQueries(args) {
  const project = resolveProject(args, { toolName: "list_slow_queries" });
  const source = projectSource(project);
  const startedAt = Date.now();

  try {
    let response = { source, ...(await getSlowQueries(args, project)) };
    response = budgetRowsPayload(response, "slowQueries");

    await sendServerLog("info", "list_slow_queries", {
      project,
      durationMs: recordDuration(startedAt),
      extensionInstalled: response.extensionInstalled,
      totalQueriesFound: response.totalQueriesFound,
      payloadTruncated: Boolean(response.payloadTruncated)
    });

    return createStructuredToolResult(response);
  } catch (error) {
    const message = error.message || "Failed to list slow queries";
    await sendServerLog("error", "list_slow_queries", {
      project,
      durationMs: recordDuration(startedAt),
      error: message
    });
    return createToolErrorResult(message, source);
  }
}

async function getSlowQueries(args, project) {
  const { limit, minMeanMs, orderBy, orderBySql } = normalizeSlowQueryArgs(args);

  const extensionCheck = await runReadOnlyQuery(project, `
    SELECT EXISTS (
      SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'
    ) AS extension_installed
  `);

  if (!extensionCheck.rows[0]?.extension_installed) {
    return {
      extensionInstalled: false,
      slowQueries: [],
      totalQueriesFound: 0,
      limit,
      orderBy,
      minMeanMs,
      note: "pg_stat_statements is not installed in this database, so slow-query history is unavailable.",
      installSql: "CREATE EXTENSION IF NOT EXISTS pg_stat_statements;"
    };
  }

  const result = await runReadOnlyQuery(project, `
    SELECT
      queryid::text AS query_id,
      query,
      calls,
      total_exec_time,
      mean_exec_time,
      min_exec_time,
      max_exec_time,
      rows,
      shared_blks_hit,
      shared_blks_read,
      shared_blks_written,
      shared_blks_dirtied,
      temp_blks_read,
      temp_blks_written,
      wal_records,
      wal_fpi,
      wal_bytes
    FROM pg_stat_statements
    WHERE query NOT ILIKE '%pg_stat_statements%'
      AND query NOT ILIKE 'EXPLAIN%'
      AND mean_exec_time >= $1
    ORDER BY ${orderBySql} DESC
    LIMIT $2
  `, [minMeanMs, limit]);

  return {
    extensionInstalled: true,
    slowQueries: result.rows.map(row => ({
      queryId: row.query_id,
      query: truncateSqlText(row.query),
      calls: row.calls,
      totalExecTimeMs: row.total_exec_time,
      meanExecTimeMs: row.mean_exec_time,
      minExecTimeMs: row.min_exec_time,
      maxExecTimeMs: row.max_exec_time,
      rows: row.rows,
      sharedBlocks: {
        hit: row.shared_blks_hit,
        read: row.shared_blks_read,
        written: row.shared_blks_written,
        dirtied: row.shared_blks_dirtied
      },
      tempBlocks: {
        read: row.temp_blks_read,
        written: row.temp_blks_written
      },
      wal: {
        records: row.wal_records,
        fullPageImages: row.wal_fpi,
        bytes: row.wal_bytes
      }
    })),
    totalQueriesFound: result.rowCount,
    limit,
    orderBy,
    minMeanMs
  };
}

async function handleExecute(args) {
  // forWrite enforces the whole write-safety policy in resolveProject:
  // explicit project required (no default), readonly projects refused.
  const project = resolveProject(args, { forWrite: true, toolName: "execute" });
  const source = projectSource(project);

  if (!args.sql) {
    return createToolErrorResult("sql required", source);
  }

  if (args.sql.trim().toLowerCase().startsWith('select')) {
    return createToolErrorResult("Use query tool for SELECT", source);
  }

  const startedAt = Date.now();

  try {
    const result = await getPool(project).query({ text: args.sql, values: args.params || [], statement_timeout: QUERY_TIMEOUT });

    // Invalidate schema cache on DDL statements
    const firstWord = args.sql.trim().split(/\s+/)[0].toUpperCase();
    if (['CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'RENAME'].includes(firstWord)) {
      invalidateSchemaCache(project);
    }

    await sendServerLog("notice", "execute", {
      project,
      durationMs: recordDuration(startedAt),
      command: result.command,
      rowCount: result.rowCount,
      schemaCacheInvalidated: ['CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'RENAME'].includes(firstWord)
    });

    return createStructuredToolResult({
      source,
      command: result.command,
      rowCount: result.rowCount
    });
  } catch (error) {
    const enhanced = await enhanceError(project, error, args.sql);
    await sendServerLog("error", "execute", {
      project,
      durationMs: recordDuration(startedAt),
      error: enhanced
    });
    return createToolErrorResult(enhanced, source, { sql: args.sql });
  }
}

// Shared wrapper for simple read tools: resolves the project, stamps the
// source on success, and converts failures into tool errors that still
// state which project and database they ran against.
async function runReadToolWithSource(args, toolName, fn) {
  const project = resolveProject(args, { toolName });
  const source = projectSource(project);

  try {
    return createStructuredToolResult({ source, ...(await fn(project)) });
  } catch (error) {
    return createToolErrorResult(error?.message || String(error), source);
  }
}

async function handleGetTables(args) {
  return runReadToolWithSource(args, "get_tables", getTablesSummary);
}

async function getTablesSummary(project) {
  const result = await getPool(project).query(`
    SELECT t.table_name,
           pg_size_pretty(pg_total_relation_size(quote_ident(t.table_name))) as size,
           (SELECT count(*) FROM information_schema.columns c
            WHERE c.table_name = t.table_name AND c.table_schema = 'public') as cols
    FROM information_schema.tables t
    WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
    ORDER BY t.table_name
  `);

  return { tables: result.rows };
}

async function handleGetSchema(args) {
  return runReadToolWithSource(args, "get_schema", project => getSchemaOverview(args, project));
}

async function getSchemaOverview(args, project) {
  const pool = getPool(project);
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

  return output;
}

async function handleDescribeTable(args) {
  return runReadToolWithSource(args, "describe_table", project => getTableDescription(args.table, project));
}

async function getTableDescription(tableName, project) {
  if (!tableName) throw new McpError(ErrorCode.InvalidParams, "table required");
  assertSafeIdentifier(tableName, 'table name');
  const pool = getPool(project);

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
    `, [tableName]),

    pool.query(`
      SELECT kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
      WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = 'public' AND tc.table_name = $1
    `, [tableName]),

    pool.query(`
      SELECT kcu.column_name as col, ccu.table_name as ref_table, ccu.column_name as ref_col
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
      JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public' AND tc.table_name = $1
    `, [tableName]),

    pool.query(`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = $1
    `, [tableName]),

    pool.query(`
      SELECT pg_size_pretty(pg_total_relation_size(quote_ident($1))) as size,
             (SELECT reltuples::bigint FROM pg_class WHERE relname = $1) as rows
    `, [tableName])
  ]);

  if (cols.rowCount === 0) {
    throw new McpError(ErrorCode.InvalidParams, `Table '${tableName}' not found`);
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
      assertSafeIdentifier(jcol.col, 'column name');
      const keysResult = await pool.query(`
        SELECT DISTINCT jsonb_object_keys(${jcol.col}) as key
        FROM ${tableName}
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
    table: tableName,
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

  return result;
}

async function handleSampleData(args) {
  return runReadToolWithSource(args, "sample_data", project => getSampleData(args.table, args.limit, project));
}

async function getSampleData(tableName, requestedLimit, project) {
  if (!tableName) throw new McpError(ErrorCode.InvalidParams, "table required");
  const { tables } = await getSchemaCache(project);
  if (!tables.includes(tableName)) {
    const suggestions = findSimilar(tableName, tables);
    throw new McpError(ErrorCode.InvalidParams,
      `Table "${tableName}" not found\n\nDid you mean: ${suggestions.length > 0 ? suggestions.join(', ') : '(no similar tables)'}`);
  }

  assertSafeIdentifier(tableName, 'table name');

  const limit = Math.min(Math.max(1, requestedLimit || 3), 10);

  try {
    const result = await getPool(project).query(`
      SELECT * FROM ${tableName}
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
      table: tableName,
      rowCount: result.rowCount,
      rows: result.rows
    };

    if (Object.keys(jsonbStructures).length > 0) {
      output.jsonb_structures = jsonbStructures;
    }

    return budgetRowsPayload(output);
  } catch (error) {
    const enhanced = await enhanceError(project, error, `SELECT * FROM ${tableName}`);
    throw new McpError(ErrorCode.InvalidParams, enhanced);
  }
}

async function handleSearchSchema(args) {
  return runReadToolWithSource(args, "search_schema", project => searchSchema(args.pattern, project));
}

async function searchSchema(rawPattern, project) {
  if (!rawPattern) throw new McpError(ErrorCode.InvalidParams, "pattern required");
  const pattern = rawPattern.toLowerCase();

  // Search tables and columns
  const result = await getPool(project).query(`
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
    pattern: rawPattern,
    matching_tables: [...matchingTables],
    matching_columns: matchingColumns
  };

  return output;
}

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`neon-pg MCP v1.9.0 — projects: ${[...PROJECT_INFO.values()].map(p =>
  `${p.name}${p.default ? '*' : ''}${p.readonly ? ' [readonly]' : ''} (${p.database ?? '?'} @ ${p.host ?? '?'})`
).join(', ')}`);

async function closePools() {
  await Promise.all([...pools.values()].map(pool => pool.end().catch(() => {})));
}

process.on('SIGINT', async () => { await closePools(); process.exit(0); });
process.on('SIGTERM', async () => { await closePools(); process.exit(0); });
