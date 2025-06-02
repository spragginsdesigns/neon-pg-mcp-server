The Model Context Protocol (MCP) represents a significant advancement in AI integration, introduced by Anthropic in November 2024 as an open standard for connecting Large Language Models to external data sources and tools[1]. This comprehensive protocol addresses the critical challenge of AI isolation from real-world data systems.

## What is the Model Context Protocol?

MCP is an open-source framework that standardizes how AI models like LLMs integrate and share data with external tools, systems, and data sources[10]. Technology writers have dubbed it "the USB-C of AI apps," emphasizing its role as a universal connector between language-model agents and external software[10].

The protocol transforms the traditional "M×N problem" of AI integrations into an "M+N problem"[12]. Instead of requiring custom integrations between every AI application and every data source, MCP enables a standardized approach where tool creators build MCP servers and application developers build MCP clients[12].

## Architecture and Core Components

MCP follows a **client-server architecture** inspired by the Language Server Protocol (LSP)[2][3]. The system consists of four primary components:

**Host Applications**: LLMs that interact with users and initiate connections, including Claude Desktop, AI-enhanced IDEs like Cursor, and web-based LLM chat interfaces[2].

**MCP Clients**: Integrated within host applications to handle connections with MCP servers, translating between the host's requirements and the Model Context Protocol[2].

**MCP Servers**: Lightweight programs that expose specific capabilities through MCP, with each server typically focusing on a specific integration point like GitHub for repository access or PostgreSQL for database operations[2].

**Transport Layer**: The communication mechanism between clients and servers, supporting STDIO for local integrations and HTTP+SSE for remote connections[2].

All communication uses **JSON-RPC 2.0** as the underlying message standard, providing standardized structure for requests, responses, and notifications[2][9].

## Server Capabilities and Features

MCP servers can expose three main types of capabilities to clients[9][12]:

**Tools (Model-controlled)**: Functions that LLMs can call to perform specific actions, enabling the model to execute operations in external systems[12].

**Resources (Application-controlled)**: Data sources that LLMs can access, similar to GET endpoints in a REST API, providing data without performing significant computation[12].

**Prompts (User-controlled)**: Pre-defined templates that help use tools or resources optimally, selected before running inference[12].

## Building MCP Servers

### Development Environment Setup

Building an MCP server can be accomplished using Python or JavaScript SDKs[5]. For Python development:

```python
# Create project directory
mkdir mcp
cd mcp

# Create virtual environment
python -m venv dotenv
dotenv\Scripts\activate

# Install required packages
pip install mcp mcp[cli]
```

### Server Implementation

Here's a practical example of building a calculator MCP server using Python[5]:

```python
from mcp.server.fastmcp import FastMCP
import math

# Instantiate MCP server
mcp = FastMCP("Calculator Server")

# Define tools
@mcp.tool()
def add(a: int, b: int) -> int:
    """Add two numbers"""
    return int(a + b)

@mcp.tool()
def multiply(a: int, b: int) -> int:
    """Multiply two numbers"""
    return int(a * b)

@mcp.tool()
def factorial(a: int) -> int:
    """Calculate factorial of a number"""
    return int(math.factorial(a))

# Define resources
@mcp.resource("greeting://{name}")
def get_greeting(name: str) -> str:
    """Get a personalized greeting"""
    return f"Hello, {name}!"

# Run server with stdio transport
if __name__ == "__main__":
    mcp.run(transport="stdio")
```

### Testing with MCP Inspector

MCP Inspector provides a GUI tool for testing custom servers locally[5]:

```bash
mcp dev server.py
```

This opens a localhost interface where you can test tools and resources before integrating with AI applications.

## Integration with AI Applications

### Semantic Kernel Integration

Microsoft's Semantic Kernel demonstrates how to integrate MCP tools[4]:

```csharp
// Create MCP Client
await using IMcpClient mcpClient = await McpClientFactory.CreateAsync(
    new StdioClientTransport(new() {
        Name = "GitHub",
        Command = "npx",
        Arguments = ["-y", "@modelcontextprotocol/server-github"],
    }));

// Convert MCP tools to Kernel functions
kernel.Plugins.AddFromFunctions("GitHub",
    tools.Select(aiFunction => aiFunction.AsKernelFunction()));
```

### Cursor IDE Integration

For Cursor IDE integration, configure the MCP server through File → Preferences → Cursor Settings → MCP → Add New Server, specifying the command path to run your server[5].

## Real-World Applications and Use Cases

MCP enables numerous practical applications across industries[7][6]:

**Enterprise Data Integration**: Connecting AI assistants to internal business tools, databases, and content repositories while maintaining governance and security controls[6].

**Development Workflows**: Enhancing coding agents with repository access, enabling them to read code, create files, manage issues, and interact with version control systems[4].

**Multi-Step Automation**: Coordinating complex workflows across platforms, such as an AI planning an event by checking calendars, booking venues, emailing guests, and updating budget sheets[6].

**Personal AI Assistants**: Creating deeply integrated assistants that can interact with personal data, emails, notes, and smart devices securely through local MCP servers[6].

**Agentic Collaboration**: Enabling specialized AI agents to use MCP as a shared workspace for exchanging information and coordinating tasks dynamically[6].

## Security and Trust Considerations

MCP implementations must address critical security principles[9]:

**User Consent and Control**: Users must explicitly consent to and understand all data access and operations, retaining control over what data is shared and what actions are taken[9].

**Data Privacy**: Hosts must obtain explicit user consent before exposing user data to servers and must not transmit resource data elsewhere without user consent[9].

**Tool Safety**: Tools represent arbitrary code execution and must be treated with appropriate caution, requiring explicit user consent before invocation[9].

**LLM Sampling Controls**: Users must explicitly approve any LLM sampling requests and control whether sampling occurs, what prompts are sent, and what results servers can see[9].

## Comparison with Existing Approaches

**vs. Function Calling**: While OpenAI's function calling API and ChatGPT plugins solved similar problems, they required vendor-specific connectors. MCP provides a vendor-agnostic standard[10].

**vs. LangChain Tools**: LangChain created developer-facing standards for integrating tools into agent code, while MCP creates model-facing standards that allow running AI agents to discover and use tools at runtime[6].

**vs. RAG Systems**: While RAG provides passive context through retrieved text snippets, MCP enables active context fetching and action execution through defined channels[6].

## Getting Started and Available Servers

The MCP ecosystem includes pre-built servers for popular services like GitHub, PostgreSQL, and various APIs[4]. Developers can also build custom servers using the Python or TypeScript SDKs, with comprehensive documentation available at modelcontextprotocol.io[9].

MCP represents a foundational shift toward more integrated, context-aware AI applications, enabling developers to build sophisticated systems that can seamlessly interact with real-world data and tools while maintaining security and user control.

Citations:
[1] https://www.anthropic.com/news/model-context-protocol
[2] https://www.descope.com/learn/post/mcp
[3] https://www.k2view.com/model-context-protocol/
[4] https://devblogs.microsoft.com/semantic-kernel/integrating-model-context-protocol-tools-with-semantic-kernel-a-step-by-step-guide/
[5] https://composio.dev/blog/mcp-server-step-by-step-guide-to-building-from-scrtch/
[6] https://huggingface.co/blog/Kseniase/mcp
[7] https://stytch.com/blog/model-context-protocol-introduction/
[8] https://www.getambassador.io/blog/model-context-protocol-mcp-connecting-llms-to-apis
[9] https://modelcontextprotocol.io/specification/2025-03-26
[10] https://en.wikipedia.org/wiki/Model_Context_Protocol
[11] https://www.merge.dev/blog/model-context-protocol
[12] https://www.philschmid.de/mcp-introduction
[13] https://docs.anthropic.com/en/docs/build-with-claude/mcp
[14] https://modelcontextprotocol.io/introduction
[15] https://www.ibm.com/think/topics/model-context-protocol
[16] https://modelcontextprotocol.io/tutorials/building-mcp-with-llms
[17] https://docs.anthropic.com/en/docs/agents-and-tools/mcp
[18] https://www.youtube.com/watch?v=tzrwxLNHtRY
[19] https://www.reddit.com/r/Python/comments/1klj6h8/i_built_a_model_context_protocol_mcp_server_to/
[20] https://modelcontextprotocol.io/quickstart/server
[21] https://modelcontextprotocol.io/docs/concepts/tools
[22] https://www.reddit.com/r/LLMDevs/comments/1jbqegg/model_context_protocol_mcp_clearly_explained/
[23] https://www.pulsemcp.com/use-cases

README For Typescript:
MCP TypeScript SDK NPM Version MIT licensed
Table of Contents
Overview
Installation
Quickstart
What is MCP?
Core Concepts
Server
Resources
Tools
Prompts
Running Your Server
stdio
Streamable HTTP
Testing and Debugging
Examples
Echo Server
SQLite Explorer
Advanced Usage
Dynamic Servers
Low-Level Server
Writing MCP Clients
Proxy Authorization Requests Upstream
Backwards Compatibility
Documentation
Contributing
License
Overview
The Model Context Protocol allows applications to provide context for LLMs in a standardized way, separating the concerns of providing context from the actual LLM interaction. This TypeScript SDK implements the full MCP specification, making it easy to:

Build MCP clients that can connect to any MCP server
Create MCP servers that expose resources, prompts and tools
Use standard transports like stdio and Streamable HTTP
Handle all MCP protocol messages and lifecycle events
Installation
npm install @modelcontextprotocol/sdk
Quick Start
Let's create a simple MCP server that exposes a calculator tool and some data:

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// Create an MCP server
const server = new McpServer({
name: "Demo",
version: "1.0.0"
});

// Add an addition tool
server.tool("add",
{ a: z.number(), b: z.number() },
async ({ a, b }) => ({
content: [{ type: "text", text: String(a + b) }]
})
);

// Add a dynamic greeting resource
server.resource(
"greeting",
new ResourceTemplate("greeting://{name}", { list: undefined }),
async (uri, { name }) => ({
contents: [{
uri: uri.href,
text: `Hello, ${name}!`
}]
})
);

// Start receiving messages on stdin and sending messages on stdout
const transport = new StdioServerTransport();
await server.connect(transport);
What is MCP?
The Model Context Protocol (MCP) lets you build servers that expose data and functionality to LLM applications in a secure, standardized way. Think of it like a web API, but specifically designed for LLM interactions. MCP servers can:

Expose data through Resources (think of these sort of like GET endpoints; they are used to load information into the LLM's context)
Provide functionality through Tools (sort of like POST endpoints; they are used to execute code or otherwise produce a side effect)
Define interaction patterns through Prompts (reusable templates for LLM interactions)
And more!
Core Concepts
Server
The McpServer is your core interface to the MCP protocol. It handles connection management, protocol compliance, and message routing:

const server = new McpServer({
name: "My App",
version: "1.0.0"
});
Resources
Resources are how you expose data to LLMs. They're similar to GET endpoints in a REST API - they provide data but shouldn't perform significant computation or have side effects:

// Static resource
server.resource(
"config",
"config://app",
async (uri) => ({
contents: [{
uri: uri.href,
text: "App configuration here"
}]
})
);

// Dynamic resource with parameters
server.resource(
"user-profile",
new ResourceTemplate("users://{userId}/profile", { list: undefined }),
async (uri, { userId }) => ({
contents: [{
uri: uri.href,
text: `Profile data for user ${userId}`
}]
})
);
Tools
Tools let LLMs take actions through your server. Unlike resources, tools are expected to perform computation and have side effects:

// Simple tool with parameters
server.tool(
"calculate-bmi",
{
weightKg: z.number(),
heightM: z.number()
},
async ({ weightKg, heightM }) => ({
content: [{
type: "text",
text: String(weightKg / (heightM * heightM))
}]
})
);

// Async tool with external API call
server.tool(
"fetch-weather",
{ city: z.string() },
async ({ city }) => {
const response = await fetch(`https://api.weather.com/${city}`);
const data = await response.text();
return {
content: [{ type: "text", text: data }]
};
}
);
Prompts
Prompts are reusable templates that help LLMs interact with your server effectively:

server.prompt(
"review-code",
{ code: z.string() },
({ code }) => ({
messages: [{
role: "user",
content: {
type: "text",
text: `Please review this code:\n\n${code}`
}
}]
})
);
Running Your Server
MCP servers in TypeScript need to be connected to a transport to communicate with clients. How you start the server depends on the choice of transport:

stdio
For command-line tools and direct integrations:

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({
name: "example-server",
version: "1.0.0"
});

// ... set up server resources, tools, and prompts ...

const transport = new StdioServerTransport();
await server.connect(transport);
Streamable HTTP
For remote servers, set up a Streamable HTTP transport that handles both client requests and server-to-client notifications.

With Session Management
In some cases, servers need to be stateful. This is achieved by session management.

import express from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js"

const app = express();
app.use(express.json());

// Map to store transports by session ID
const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};

// Handle POST requests for client-to-server communication
app.post('/mcp', async (req, res) => {
// Check for existing session ID
const sessionId = req.headers['mcp-session-id'] as string | undefined;
let transport: StreamableHTTPServerTransport;

if (sessionId && transports[sessionId]) {
// Reuse existing transport
transport = transports[sessionId];
} else if (!sessionId && isInitializeRequest(req.body)) {
// New initialization request
transport = new StreamableHTTPServerTransport({
sessionIdGenerator: () => randomUUID(),
onsessioninitialized: (sessionId) => {
// Store the transport by session ID
transports[sessionId] = transport;
}
});

    // Clean up transport when closed
    transport.onclose = () => {
      if (transport.sessionId) {
        delete transports[transport.sessionId];
      }
    };
    const server = new McpServer({
      name: "example-server",
      version: "1.0.0"
    });

    // ... set up server resources, tools, and prompts ...

    // Connect to the MCP server
    await server.connect(transport);

} else {
// Invalid request
res.status(400).json({
jsonrpc: '2.0',
error: {
code: -32000,
message: 'Bad Request: No valid session ID provided',
},
id: null,
});
return;
}

// Handle the request
await transport.handleRequest(req, res, req.body);
});

// Reusable handler for GET and DELETE requests
const handleSessionRequest = async (req: express.Request, res: express.Response) => {
const sessionId = req.headers['mcp-session-id'] as string | undefined;
if (!sessionId || !transports[sessionId]) {
res.status(400).send('Invalid or missing session ID');
return;
}

const transport = transports[sessionId];
await transport.handleRequest(req, res);
};

// Handle GET requests for server-to-client notifications via SSE
app.get('/mcp', handleSessionRequest);

// Handle DELETE requests for session termination
app.delete('/mcp', handleSessionRequest);

app.listen(3000);
Without Session Management (Stateless)
For simpler use cases where session management isn't needed:

const app = express();
app.use(express.json());

app.post('/mcp', async (req: Request, res: Response) => {
// In stateless mode, create a new instance of transport and server for each request
// to ensure complete isolation. A single instance would cause request ID collisions
// when multiple clients connect concurrently.

try {
const server = getServer();
const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
sessionIdGenerator: undefined,
});
res.on('close', () => {
console.log('Request closed');
transport.close();
server.close();
});
await server.connect(transport);
await transport.handleRequest(req, res, req.body);
} catch (error) {
console.error('Error handling MCP request:', error);
if (!res.headersSent) {
res.status(500).json({
jsonrpc: '2.0',
error: {
code: -32603,
message: 'Internal server error',
},
id: null,
});
}
}
});

app.get('/mcp', async (req: Request, res: Response) => {
console.log('Received GET MCP request');
res.writeHead(405).end(JSON.stringify({
jsonrpc: "2.0",
error: {
code: -32000,
message: "Method not allowed."
},
id: null
}));
});

app.delete('/mcp', async (req: Request, res: Response) => {
console.log('Received DELETE MCP request');
res.writeHead(405).end(JSON.stringify({
jsonrpc: "2.0",
error: {
code: -32000,
message: "Method not allowed."
},
id: null
}));
});

// Start the server
const PORT = 3000;
app.listen(PORT, () => {
console.log(`MCP Stateless Streamable HTTP Server listening on port ${PORT}`);
});
This stateless approach is useful for:

Simple API wrappers
RESTful scenarios where each request is independent
Horizontally scaled deployments without shared session state
Testing and Debugging
To test your server, you can use the MCP Inspector. See its README for more information.

Examples
Echo Server
A simple server demonstrating resources, tools, and prompts:

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const server = new McpServer({
name: "Echo",
version: "1.0.0"
});

server.resource(
"echo",
new ResourceTemplate("echo://{message}", { list: undefined }),
async (uri, { message }) => ({
contents: [{
uri: uri.href,
text: `Resource echo: ${message}`
}]
})
);

server.tool(
"echo",
{ message: z.string() },
async ({ message }) => ({
content: [{ type: "text", text: `Tool echo: ${message}` }]
})
);

server.prompt(
"echo",
{ message: z.string() },
({ message }) => ({
messages: [{
role: "user",
content: {
type: "text",
text: `Please process this message: ${message}`
}
}]
})
);
SQLite Explorer
A more complex example showing database integration:

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import sqlite3 from "sqlite3";
import { promisify } from "util";
import { z } from "zod";

const server = new McpServer({
name: "SQLite Explorer",
version: "1.0.0"
});

// Helper to create DB connection
const getDb = () => {
const db = new sqlite3.Database("database.db");
return {
all: promisify<string, any[]>(db.all.bind(db)),
close: promisify(db.close.bind(db))
};
};

server.resource(
"schema",
"schema://main",
async (uri) => {
const db = getDb();
try {
const tables = await db.all(
"SELECT sql FROM sqlite_master WHERE type='table'"
);
return {
contents: [{
uri: uri.href,
text: tables.map((t: {sql: string}) => t.sql).join("\n")
}]
};
} finally {
await db.close();
}
}
);

server.tool(
"query",
{ sql: z.string() },
async ({ sql }) => {
const db = getDb();
try {
const results = await db.all(sql);
return {
content: [{
type: "text",
text: JSON.stringify(results, null, 2)
}]
};
} catch (err: unknown) {
const error = err as Error;
return {
content: [{
type: "text",
text: `Error: ${error.message}`
}],
isError: true
};
} finally {
await db.close();
}
}
);
Advanced Usage
Dynamic Servers
If you want to offer an initial set of tools/prompts/resources, but later add additional ones based on user action or external state change, you can add/update/remove them after the Server is connected. This will automatically emit the corresponding listChanged notifications:

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const server = new McpServer({
name: "Dynamic Example",
version: "1.0.0"
});

const listMessageTool = server.tool(
"listMessages",
{ channel: z.string() },
async ({ channel }) => ({
content: [{ type: "text", text: await listMessages(channel) }]
})
);

const putMessageTool = server.tool(
"putMessage",
{ channel: z.string(), message: z.string() },
async ({ channel, message }) => ({
content: [{ type: "text", text: await putMessage(channel, string) }]
})
);
// Until we upgrade auth, `putMessage` is disabled (won't show up in listTools)
putMessageTool.disable()

const upgradeAuthTool = server.tool(
"upgradeAuth",
{ permission: z.enum(["write', admin"])},
// Any mutations here will automatically emit `listChanged` notifications
async ({ permission }) => {
const { ok, err, previous } = await upgradeAuthAndStoreToken(permission)
if (!ok) return {content: [{ type: "text", text: `Error: ${err}` }]}

    // If we previously had read-only access, 'putMessage' is now available
    if (previous === "read") {
      putMessageTool.enable()
    }

    if (permission === 'write') {
      // If we've just upgraded to 'write' permissions, we can still call 'upgradeAuth'
      // but can only upgrade to 'admin'.
      upgradeAuthTool.update({
        paramSchema: { permission: z.enum(["admin"]) }, // change validation rules
      })
    } else {
      // If we're now an admin, we no longer have anywhere to upgrade to, so fully remove that tool
      upgradeAuthTool.remove()
    }

}
)

// Connect as normal
const transport = new StdioServerTransport();
await server.connect(transport);
Low-Level Server
For more control, you can use the low-level Server class directly:

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
ListPromptsRequestSchema,
GetPromptRequestSchema
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
{
name: "example-server",
version: "1.0.0"
},
{
capabilities: {
prompts: {}
}
}
);

server.setRequestHandler(ListPromptsRequestSchema, async () => {
return {
prompts: [{
name: "example-prompt",
description: "An example prompt template",
arguments: [{
name: "arg1",
description: "Example argument",
required: true
}]
}]
};
});

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
if (request.params.name !== "example-prompt") {
throw new Error("Unknown prompt");
}
return {
description: "Example prompt",
messages: [{
role: "user",
content: {
type: "text",
text: "Example prompt text"
}
}]
};
});

const transport = new StdioServerTransport();
await server.connect(transport);
Writing MCP Clients
The SDK provides a high-level client interface:

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
command: "node",
args: ["server.js"]
});

const client = new Client(
{
name: "example-client",
version: "1.0.0"
}
);

await client.connect(transport);

// List prompts
const prompts = await client.listPrompts();

// Get a prompt
const prompt = await client.getPrompt({
name: "example-prompt",
arguments: {
arg1: "value"
}
});

// List resources
const resources = await client.listResources();

// Read a resource
const resource = await client.readResource({
uri: "file:///example.txt"
});

// Call a tool
const result = await client.callTool({
name: "example-tool",
arguments: {
arg1: "value"
}
});
Proxy Authorization Requests Upstream
You can proxy OAuth requests to an external authorization provider:

import express from 'express';
import { ProxyOAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/providers/proxyProvider.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';

const app = express();

const proxyProvider = new ProxyOAuthServerProvider({
endpoints: {
authorizationUrl: "https://auth.external.com/oauth2/v1/authorize",
tokenUrl: "https://auth.external.com/oauth2/v1/token",
revocationUrl: "https://auth.external.com/oauth2/v1/revoke",
},
verifyAccessToken: async (token) => {
return {
token,
clientId: "123",
scopes: ["openid", "email", "profile"],
}
},
getClient: async (client_id) => {
return {
client_id,
redirect_uris: ["http://localhost:3000/callback"],
}
}
})

app.use(mcpAuthRouter({
provider: proxyProvider,
issuerUrl: new URL("http://auth.external.com"),
baseUrl: new URL("http://mcp.example.com"),
serviceDocumentationUrl: new URL("https://docs.example.com/"),
}))
This setup allows you to:

Forward OAuth requests to an external provider
Add custom token validation logic
Manage client registrations
Provide custom documentation URLs
Maintain control over the OAuth flow while delegating to an external provider
Backwards Compatibility
Clients and servers with StreamableHttp tranport can maintain backwards compatibility with the deprecated HTTP+SSE transport (from protocol version 2024-11-05) as follows

Client-Side Compatibility
For clients that need to work with both Streamable HTTP and older SSE servers:

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
let client: Client|undefined = undefined
const baseUrl = new URL(url);
try {
client = new Client({
name: 'streamable-http-client',
version: '1.0.0'
});
const transport = new StreamableHTTPClientTransport(
new URL(baseUrl)
);
await client.connect(transport);
console.log("Connected using Streamable HTTP transport");
} catch (error) {
// If that fails with a 4xx error, try the older SSE transport
console.log("Streamable HTTP connection failed, falling back to SSE transport");
client = new Client({
name: 'sse-client',
version: '1.0.0'
});
const sseTransport = new SSEClientTransport(baseUrl);
await client.connect(sseTransport);
console.log("Connected using SSE transport");
}
Server-Side Compatibility
For servers that need to support both Streamable HTTP and older clients:

import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

const server = new McpServer({
name: "backwards-compatible-server",
version: "1.0.0"
});

// ... set up server resources, tools, and prompts ...

const app = express();
app.use(express.json());

// Store transports for each session type
const transports = {
streamable: {} as Record<string, StreamableHTTPServerTransport>,
sse: {} as Record<string, SSEServerTransport>
};

// Modern Streamable HTTP endpoint
app.all('/mcp', async (req, res) => {
// Handle Streamable HTTP transport for modern clients
// Implementation as shown in the "With Session Management" example
// ...
});

// Legacy SSE endpoint for older clients
app.get('/sse', async (req, res) => {
// Create SSE transport for legacy clients
const transport = new SSEServerTransport('/messages', res);
transports.sse[transport.sessionId] = transport;

res.on("close", () => {
delete transports.sse[transport.sessionId];
});

await server.connect(transport);
});

// Legacy message endpoint for older clients
app.post('/messages', async (req, res) => {
const sessionId = req.query.sessionId as string;
const transport = transports.sse[sessionId];
if (transport) {
await transport.handlePostMessage(req, res, req.body);
} else {
res.status(400).send('No transport found for sessionId');
}
});

app.listen(3000);
Note: The SSE transport is now deprecated in favor of Streamable HTTP. New implementations should use Streamable HTTP, and existing SSE implementations should plan to migrate.

Documentation
Model Context Protocol documentation
MCP Specification
Example Servers
Contributing
Issues and pull requests are welcome on GitHub at https://github.com/modelcontextprotocol/typescript-sdk.

License
This project is licensed under the MIT License—see the LICENSE file for details.
