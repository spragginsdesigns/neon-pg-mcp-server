---
trigger: always_on
---

# Model Context Protocol (MCP)

MCP is an open protocol that standardizes how applications provide context to LLMs, acting like a standardized port for connecting AI models to various data sources and tools.

## Why MCP?

MCP helps build agents and complex workflows by providing:

- A growing list of pre-built integrations.
- Flexibility to switch between LLM providers.
- Best practices for securing data within your infrastructure.

## General Architecture

MCP follows a client-server architecture:

- **MCP Hosts**: Programs (like Claude Desktop, IDEs) that access data through MCP.
- **MCP Clients**: Protocol clients with 1:1 connections to servers.
- **MCP Servers**: Lightweight programs exposing specific capabilities via the MCP.
- **Local Data Sources**: Your computer's files, databases, and services accessible by MCP servers.
- **Remote Services**: External systems (like APIs) accessible by MCP servers.

## Get Started

Choose your path:

- **For Server Developers**: Build your own server for use in Claude for Desktop and other clients.
- **For Client Developers**: Build your own client that integrates with all MCP servers.
- **For Claude Desktop Users**: Use pre-built servers in Claude for Desktop.

## Examples

- **Example Servers**: Gallery of official MCP servers and implementations.
- **Example Clients**: List of clients supporting MCP integrations.

## Tutorials

- Building MCP with LLMs: Learn to use LLMs like Claude to speed up development.
- Debugging Guide: Learn to debug MCP servers and integrations.
- MCP Inspector: Interactive tool for testing and inspecting MCP servers.
- MCP Workshop (Video): 2-hour video tutorial.

## Explore MCP

Dive deeper into core concepts:

- **Core architecture**: Understand how MCP connects clients, servers, and LLMs.
- **Resources**: Expose data and content from servers to LLMs.
- **Prompts**: Create reusable prompt templates and workflows.
- **Tools**: Enable LLMs to perform actions through your server.
- **Sampling**: Let servers request completions from LLMs.
- **Transports**: Learn about MCP’s communication mechanism.

## Contributing

Refer to the Contributing Guide to learn how to help improve MCP.

## Support and Feedback

- **Bug reports and feature requests (open source)**: Create a GitHub issue on the Model Context Protocol repository.
- **Discussions/Q&A about the specification**: Use the specification discussions.
- **Discussions/Q&A about other open source components**: Use the organization discussions.
- **Bug reports, feature requests, and questions for Claude.app/claude.ai integration**: See Anthropic's guide on How to Get Support.
