# Excalidraw MCP Server

A hosted MCP server that enables AI assistants to create diagrams on a live Excalidraw canvas and generate shareable links.

> Built on top of [mcp_excalidraw](https://github.com/yctimlin/mcp_excalidraw) by [@yctimlin](https://github.com/yctimlin). Added shareable links, image export, session management, and Streamable HTTP transport.

## Features

- **Live Canvas**: Real-time Excalidraw canvas accessible via web browser
- **AI Integration**: MCP server allows AI agents (Claude, etc.) to create visual diagrams
- **Shareable Links**: Generate shareable URLs for your diagrams
- **Image Export**: Automatically export diagrams as images
- **Prompt Templates**: Built-in prompts for wireframes, flowcharts, architecture diagrams

## Quick Start

### 1. Install & Run

```bash
git clone git@github.com:0xArtex/excalidraw-mcp.git
npm install
npm run build
npm run canvas
```

The server will start at `http://localhost:3000`

### 2. Connect Your AI Assistant

Add to your MCP client configuration:

**Claude Desktop** (`claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "excalidraw": {
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

**Claude Code** (`.mcp.json` in project root):
```json
{
  "mcpServers": {
    "excalidraw": {
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

**Cursor** (`.cursor/mcp.json`):
```json
{
  "mcpServers": {
    "excalidraw": {
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

### 3. Start Creating

Once connected, your AI assistant can use commands like:
- `/wireframe` - Create a wireframe for a website or app
- `/diagram` - Create a flowchart or diagram
- `/architecture` - Create a system architecture diagram
- `/flowchart` - Create a process flowchart

Or just ask naturally: "Create a diagram showing the user authentication flow"

### Canvas Example

![Excalidraw MCP Canvas](https://i.ibb.co/SW5VHs8/G-ZQFL4bw-AAP5-Ra.png)

## Hosted Deployment

Deploy to any cloud platform (Railway, Render, Fly.io, etc.) and connect remotely:

```json
{
  "mcpServers": {
    "excalidraw": {
      "url": "https://your-deployment-url.com/mcp"
    }
  }
}
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `PUBLIC_URL` | auto-detected | Public URL for shareable links |

## MCP Tools

| Tool | Description |
|------|-------------|
| `start_diagram` | Start a new diagram session, returns live canvas URL |
| `create_element` | Create a shape (rectangle, ellipse, diamond, arrow, text, line) |
| `batch_create_elements` | Create multiple elements at once |
| `delete_element` | Remove an element |
| `finish_diagram` | Finalize and get shareable link with image |

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `POST /mcp` | MCP Streamable HTTP transport |
| `GET /canvas/:sessionId` | View diagram canvas |
| `GET /health` | Health check |

## Development

```bash
# Development mode (watch + hot reload)
npm run dev

# Build
npm run build

# Type check
npm run type-check
```

## Project Structure

```
excalidraw-mcp/
├── src/
│   ├── server.ts        # Express server + MCP endpoints
│   ├── mcp-handler.ts   # MCP tool implementations
│   ├── sessions.ts      # Session management
│   ├── imageExport.ts   # Puppeteer image export
│   └── types.ts         # TypeScript definitions
├── frontend/
│   └── src/
│       └── App.tsx      # React Excalidraw canvas
└── dist/                # Compiled output
```

## License

MIT

## Acknowledgments

- [@yctimlin](https://github.com/yctimlin) - Original [mcp_excalidraw](https://github.com/yctimlin/mcp_excalidraw) project
- [Excalidraw](https://excalidraw.com/) - The drawing library
- [Model Context Protocol](https://modelcontextprotocol.io/) - The MCP specification
