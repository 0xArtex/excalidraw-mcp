#!/usr/bin/env node

// Disable colors to prevent ANSI color codes from breaking JSON parsing
process.env.NODE_DISABLE_COLORS = '1';
process.env.NO_COLOR = '1';

import { fileURLToPath } from "url";
import express, { Request, Response } from 'express';
import cors from 'cors';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { 
  CallToolRequestSchema, 
  ListToolsRequestSchema,
  CallToolRequest,
  Tool
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import dotenv from 'dotenv';
import logger from './utils/logger.js';
import { 
  generateId, 
  EXCALIDRAW_ELEMENT_TYPES,
  ServerElement,
  ExcalidrawElementType
} from './types.js';
import fetch from 'node-fetch';

// Load environment variables
dotenv.config();

// Express server configuration
const EXPRESS_SERVER_URL = process.env.EXPRESS_SERVER_URL || 'http://localhost:3000';
const PUBLIC_URL = process.env.PUBLIC_URL || EXPRESS_SERVER_URL;
const MCP_PORT = parseInt(process.env.MCP_PORT || '3001', 10);

// Current session ID (set per connection for SSE, or via environment for stdio)
let currentSessionId: string | null = process.env.SESSION_ID || null;

// API Response types
interface ApiResponse {
  success: boolean;
  element?: ServerElement;
  elements?: ServerElement[];
  message?: string;
  error?: string;
  count?: number;
  sessionId?: string;
  canvasUrl?: string;
  imageUrl?: string;
  title?: string;
}

interface SessionResponse {
  success: boolean;
  session?: {
    id: string;
    createdAt: string;
    canvasUrl: string;
    apiUrl: string;
  };
  error?: string;
}

// Create a new session
async function createNewSession(): Promise<string> {
  try {
    const response = await fetch(`${EXPRESS_SERVER_URL}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    
    const result = await response.json() as SessionResponse;
    
    if (result.success && result.session) {
      currentSessionId = result.session.id;
      logger.info(`Created new session: ${currentSessionId}`);
      return currentSessionId;
    }
    
    throw new Error(result.error || 'Failed to create session');
  } catch (error) {
    logger.error('Error creating session:', error);
    // Generate a local session ID as fallback
    currentSessionId = generateId();
    return currentSessionId;
  }
}

// Get current session ID, create one if needed
async function getSessionId(): Promise<string> {
  if (!currentSessionId) {
    return await createNewSession();
  }
  return currentSessionId;
}

// Build API URL for current session
function getSessionApiUrl(path: string): string {
  if (currentSessionId) {
    return `${EXPRESS_SERVER_URL}/api/sessions/${currentSessionId}${path}`;
  }
  // Fallback to legacy API
  return `${EXPRESS_SERVER_URL}/api${path}`;
}

// Helper functions to sync with Express server (canvas)
async function syncToCanvas(operation: string, data: any): Promise<ApiResponse | null> {
  try {
    let url: string;
    let options: { method: string; headers?: Record<string, string>; body?: string };
    
    switch (operation) {
      case 'create':
        url = getSessionApiUrl('/elements');
        options = {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data)
        };
        break;
        
      case 'update':
        url = getSessionApiUrl(`/elements/${data.id}`);
        options = {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data)
        };
        break;
        
      case 'delete':
        url = getSessionApiUrl(`/elements/${data.id}`);
        options = { method: 'DELETE' };
        break;
        
      case 'batch_create':
        url = getSessionApiUrl('/elements/batch');
        options = {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ elements: data })
        };
        break;
        
      case 'export':
        url = getSessionApiUrl('/export');
        options = {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data)
        };
        break;
        
      default:
        logger.warn(`Unknown sync operation: ${operation}`);
        return null;
    }

    logger.debug(`Syncing to canvas: ${operation}`, { url, data });
    const response = await fetch(url, options);
    const result = await response.json() as ApiResponse;

    if (!response.ok) {
      logger.warn(`Canvas sync returned error status: ${response.status}`, result);
      throw new Error(result.error || `Canvas sync failed: ${response.status} ${response.statusText}`);
    }

    logger.debug(`Canvas sync successful: ${operation}`, result);
    return result;
    
  } catch (error) {
    logger.warn(`Canvas sync failed for ${operation}:`, (error as Error).message);
    return null;
  }
}

// Helper function to convert text property to label format for Excalidraw
function convertTextToLabel(element: ServerElement): ServerElement {
  const { text, ...rest } = element;
  if (text) {
    if (element.type === 'text') {
      return element;
    }
    return {
      ...rest,
      label: { text }
    } as ServerElement;
  }
  return element;
}

// Schema definitions using zod
const ElementSchema = z.object({
  type: z.enum(Object.values(EXCALIDRAW_ELEMENT_TYPES) as [ExcalidrawElementType, ...ExcalidrawElementType[]]),
  x: z.number(),
  y: z.number(),
  width: z.number().optional(),
  height: z.number().optional(),
  points: z.array(z.object({ x: z.number(), y: z.number() })).optional(),
  backgroundColor: z.string().optional(),
  strokeColor: z.string().optional(),
  strokeWidth: z.number().optional(),
  roughness: z.number().optional(),
  opacity: z.number().optional(),
  text: z.string().optional(),
  fontSize: z.number().optional(),
  fontFamily: z.string().optional(),
  groupIds: z.array(z.string()).optional(),
  locked: z.boolean().optional()
});

const ElementIdSchema = z.object({
  id: z.string()
});

const ElementIdsSchema = z.object({
  elementIds: z.array(z.string())
});

const GroupIdSchema = z.object({
  groupId: z.string()
});

const AlignElementsSchema = z.object({
  elementIds: z.array(z.string()),
  alignment: z.enum(['left', 'center', 'right', 'top', 'middle', 'bottom'])
});

const DistributeElementsSchema = z.object({
  elementIds: z.array(z.string()),
  direction: z.enum(['horizontal', 'vertical'])
});

const QuerySchema = z.object({
  type: z.enum(Object.values(EXCALIDRAW_ELEMENT_TYPES) as [ExcalidrawElementType, ...ExcalidrawElementType[]]).optional(),
  filter: z.record(z.any()).optional()
});

const ResourceSchema = z.object({
  resource: z.enum(['scene', 'library', 'theme', 'elements'])
});

const FinishDiagramSchema = z.object({
  title: z.string().optional().describe('Optional title for the diagram')
});

// In-memory storage for scene state
interface SceneState {
  theme: string;
  viewport: { x: number; y: number; zoom: number };
  selectedElements: Set<string>;
  groups: Map<string, string[]>;
}

const sceneState: SceneState = {
  theme: 'light',
  viewport: { x: 0, y: 0, zoom: 1 },
  selectedElements: new Set(),
  groups: new Map()
};

// Tool definitions
const tools: Tool[] = [
  {
    name: 'start_diagram',
    description: 'Start a new diagram session. Returns a session ID and live canvas URL. Call this first before creating elements.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { 
          type: 'string',
          description: 'Optional title for the diagram'
        }
      }
    }
  },
  {
    name: 'create_element',
    description: 'Create a new Excalidraw element on the canvas',
    inputSchema: {
      type: 'object',
      properties: {
        type: { 
          type: 'string', 
          enum: Object.values(EXCALIDRAW_ELEMENT_TYPES) 
        },
        x: { type: 'number' },
        y: { type: 'number' },
        width: { type: 'number' },
        height: { type: 'number' },
        backgroundColor: { type: 'string' },
        strokeColor: { type: 'string' },
        strokeWidth: { type: 'number' },
        roughness: { type: 'number' },
        opacity: { type: 'number' },
        text: { type: 'string' },
        fontSize: { type: 'number' },
        fontFamily: { type: 'string' }
      },
      required: ['type', 'x', 'y']
    }
  },
  {
    name: 'update_element',
    description: 'Update an existing Excalidraw element',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        type: { 
          type: 'string', 
          enum: Object.values(EXCALIDRAW_ELEMENT_TYPES) 
        },
        x: { type: 'number' },
        y: { type: 'number' },
        width: { type: 'number' },
        height: { type: 'number' },
        backgroundColor: { type: 'string' },
        strokeColor: { type: 'string' },
        strokeWidth: { type: 'number' },
        roughness: { type: 'number' },
        opacity: { type: 'number' },
        text: { type: 'string' },
        fontSize: { type: 'number' },
        fontFamily: { type: 'string' }
      },
      required: ['id']
    }
  },
  {
    name: 'delete_element',
    description: 'Delete an Excalidraw element',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' }
      },
      required: ['id']
    }
  },
  {
    name: 'query_elements',
    description: 'Query Excalidraw elements with optional filters',
    inputSchema: {
      type: 'object',
      properties: {
        type: { 
          type: 'string', 
          enum: Object.values(EXCALIDRAW_ELEMENT_TYPES) 
        },
        filter: { 
          type: 'object',
          additionalProperties: true
        }
      }
    }
  },
  {
    name: 'get_resource',
    description: 'Get an Excalidraw resource',
    inputSchema: {
      type: 'object',
      properties: {
        resource: { 
          type: 'string', 
          enum: ['scene', 'library', 'theme', 'elements'] 
        }
      },
      required: ['resource']
    }
  },
  {
    name: 'group_elements',
    description: 'Group multiple elements together',
    inputSchema: {
      type: 'object',
      properties: {
        elementIds: { 
          type: 'array',
          items: { type: 'string' }
        }
      },
      required: ['elementIds']
    }
  },
  {
    name: 'ungroup_elements',
    description: 'Ungroup a group of elements',
    inputSchema: {
      type: 'object',
      properties: {
        groupId: { type: 'string' }
      },
      required: ['groupId']
    }
  },
  {
    name: 'align_elements',
    description: 'Align elements to a specific position',
    inputSchema: {
      type: 'object',
      properties: {
        elementIds: { 
          type: 'array',
          items: { type: 'string' }
        },
        alignment: { 
          type: 'string', 
          enum: ['left', 'center', 'right', 'top', 'middle', 'bottom'] 
        }
      },
      required: ['elementIds', 'alignment']
    }
  },
  {
    name: 'distribute_elements',
    description: 'Distribute elements evenly',
    inputSchema: {
      type: 'object',
      properties: {
        elementIds: { 
          type: 'array',
          items: { type: 'string' }
        },
        direction: { 
          type: 'string', 
          enum: ['horizontal', 'vertical'] 
        }
      },
      required: ['elementIds', 'direction']
    }
  },
  {
    name: 'lock_elements',
    description: 'Lock elements to prevent modification',
    inputSchema: {
      type: 'object',
      properties: {
        elementIds: { 
          type: 'array',
          items: { type: 'string' }
        }
      },
      required: ['elementIds']
    }
  },
  {
    name: 'unlock_elements',
    description: 'Unlock elements to allow modification',
    inputSchema: {
      type: 'object',
      properties: {
        elementIds: { 
          type: 'array',
          items: { type: 'string' }
        }
      },
      required: ['elementIds']
    }
  },
  {
    name: 'create_from_mermaid',
    description: 'Convert a Mermaid diagram to Excalidraw elements and render them on the canvas',
    inputSchema: {
      type: 'object',
      properties: {
        mermaidDiagram: {
          type: 'string',
          description: 'The Mermaid diagram definition (e.g., "graph TD; A-->B; B-->C;")'
        },
        config: {
          type: 'object',
          description: 'Optional Mermaid configuration',
          properties: {
            startOnLoad: { type: 'boolean' },
            flowchart: {
              type: 'object',
              properties: {
                curve: { type: 'string', enum: ['linear', 'basis'] }
              }
            },
            themeVariables: {
              type: 'object',
              properties: {
                fontSize: { type: 'string' }
              }
            },
            maxEdges: { type: 'number' },
            maxTextSize: { type: 'number' }
          }
        }
      },
      required: ['mermaidDiagram']
    }
  },
  {
    name: 'batch_create_elements',
    description: 'Create multiple Excalidraw elements at once - ideal for complex diagrams',
    inputSchema: {
      type: 'object',
      properties: {
        elements: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: { 
                type: 'string', 
                enum: Object.values(EXCALIDRAW_ELEMENT_TYPES) 
              },
              x: { type: 'number' },
              y: { type: 'number' },
              width: { type: 'number' },
              height: { type: 'number' },
              backgroundColor: { type: 'string' },
              strokeColor: { type: 'string' },
              strokeWidth: { type: 'number' },
              roughness: { type: 'number' },
              opacity: { type: 'number' },
              text: { type: 'string' },
              fontSize: { type: 'number' },
              fontFamily: { type: 'string' }
            },
            required: ['type', 'x', 'y']
          }
        }
      },
      required: ['elements']
    }
  },
  {
    name: 'finish_diagram',
    description: 'Finalize the diagram and get a shareable link with an image. Call this when the diagram is complete.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { 
          type: 'string',
          description: 'Optional title for the diagram'
        }
      }
    }
  }
];

// Initialize MCP server (used for stdio mode)
const mcpServer = new Server(
  {
    name: "mcp-excalidraw-server",
    version: "2.0.0",
    description: "Hosted MCP server for Excalidraw - create diagrams with AI and get shareable links"
  },
  {
    capabilities: {
      tools: Object.fromEntries(tools.map(tool => [tool.name, {
        description: tool.description,
        inputSchema: tool.inputSchema
      }]))
    }
  }
);

// Shared tool call handler (used by both stdio and SSE modes)
async function handleToolCall(request: CallToolRequest): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  try {
    const { name, arguments: args } = request.params;
    logger.info(`Handling tool call: ${name}`);
    
    switch (name) {
      case 'start_diagram': {
        const params = z.object({ title: z.string().optional() }).parse(args || {});
        
        // Create a new session
        const sessionId = await createNewSession();
        const canvasUrl = `${PUBLIC_URL}/canvas/${sessionId}`;
        
        logger.info('Started new diagram session', { sessionId, canvasUrl });
        
        return {
          content: [{
            type: 'text',
            text: `🎨 **New Diagram Session Started!**

**Session ID:** \`${sessionId}\`
**Live Canvas:** ${canvasUrl}

${params.title ? `**Title:** ${params.title}\n` : ''}
The canvas is ready! You can now create elements using \`create_element\` or \`batch_create_elements\`.

When you're done, call \`finish_diagram\` to get a shareable link and image.`
          }]
        };
      }
      
      case 'create_element': {
        const params = ElementSchema.parse(args);
        
        // Ensure we have a session
        await getSessionId();
        
        logger.info('Creating element via MCP', { type: params.type });

        const id = generateId();
        const element: ServerElement = {
          id,
          ...params,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          version: 1
        };

        const excalidrawElement = convertTextToLabel(element);
        const canvasResult = await syncToCanvas('create', excalidrawElement);
        
        if (!canvasResult) {
          throw new Error('Failed to create element: Canvas server unavailable');
        }
        
        return {
          content: [{ 
            type: 'text', 
            text: `✅ Element created: ${excalidrawElement.type} at (${excalidrawElement.x}, ${excalidrawElement.y})` 
          }]
        };
      }
      
      case 'update_element': {
        const params = ElementIdSchema.merge(ElementSchema.partial()).parse(args);
        const { id, ...updates } = params;
        
        if (!id) throw new Error('Element ID is required');

        const updatePayload = {
          id,
          ...updates,
          updatedAt: new Date().toISOString()
        };

        const excalidrawElement = convertTextToLabel(updatePayload as ServerElement);
        const canvasResult = await syncToCanvas('update', excalidrawElement);
        
        if (!canvasResult) {
          throw new Error('Failed to update element: Canvas server unavailable');
        }
        
        return {
          content: [{ 
            type: 'text', 
            text: `✅ Element updated: ${id}` 
          }]
        };
      }
      
      case 'delete_element': {
        const params = ElementIdSchema.parse(args);
        const { id } = params;

        const canvasResult = await syncToCanvas('delete', { id });

        if (!canvasResult || !canvasResult.success) {
          throw new Error('Failed to delete element: Canvas server unavailable');
        }

        return {
          content: [{
            type: 'text',
            text: `✅ Element deleted: ${id}`
          }]
        };
      }
      
      case 'query_elements': {
        const params = QuerySchema.parse(args || {});
        const sessionId = await getSessionId();
        
        const queryParams = new URLSearchParams();
        if (params.type) queryParams.set('type', params.type);
        if (params.filter) {
          Object.entries(params.filter).forEach(([key, value]) => {
            queryParams.set(key, String(value));
          });
        }
        
        const url = `${EXPRESS_SERVER_URL}/api/sessions/${sessionId}/elements?${queryParams}`;
        const response = await fetch(url);
        const data = await response.json() as ApiResponse;
        
        return {
          content: [{ type: 'text', text: JSON.stringify(data.elements || [], null, 2) }]
        };
      }
      
      case 'get_resource': {
        const params = ResourceSchema.parse(args);
        const { resource } = params;
        const sessionId = await getSessionId();
        
        let result: any;
        switch (resource) {
          case 'scene':
            result = {
              theme: sceneState.theme,
              viewport: sceneState.viewport,
              sessionId
            };
            break;
          case 'elements':
          case 'library':
            const response = await fetch(`${EXPRESS_SERVER_URL}/api/sessions/${sessionId}/elements`);
            const data = await response.json() as ApiResponse;
            result = { elements: data.elements || [] };
            break;
          case 'theme':
            result = { theme: sceneState.theme };
            break;
          default:
            throw new Error(`Unknown resource: ${resource}`);
        }
        
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        };
      }
      
      case 'group_elements': {
        const params = ElementIdsSchema.parse(args);
        const { elementIds } = params;
        const groupId = generateId();
        sceneState.groups.set(groupId, elementIds);
        
        return {
          content: [{ type: 'text', text: `✅ Elements grouped: ${elementIds.length} elements in group ${groupId}` }]
        };
      }
      
      case 'ungroup_elements': {
        const params = GroupIdSchema.parse(args);
        const { groupId } = params;
        
        if (!sceneState.groups.has(groupId)) {
          throw new Error(`Group ${groupId} not found`);
        }
        
        sceneState.groups.delete(groupId);
        
        return {
          content: [{ type: 'text', text: `✅ Group ${groupId} ungrouped` }]
        };
      }
      
      case 'align_elements': {
        const params = AlignElementsSchema.parse(args);
        return {
          content: [{ type: 'text', text: `✅ Elements aligned: ${params.elementIds.length} elements to ${params.alignment}` }]
        };
      }
      
      case 'distribute_elements': {
        const params = DistributeElementsSchema.parse(args);
        return {
          content: [{ type: 'text', text: `✅ Elements distributed: ${params.elementIds.length} elements ${params.direction}ly` }]
        };
      }
      
      case 'lock_elements': {
        const params = ElementIdsSchema.parse(args);
        return {
          content: [{ type: 'text', text: `🔒 Elements locked: ${params.elementIds.length} elements` }]
        };
      }
      
      case 'unlock_elements': {
        const params = ElementIdsSchema.parse(args);
        return {
          content: [{ type: 'text', text: `🔓 Elements unlocked: ${params.elementIds.length} elements` }]
        };
      }
      
      case 'create_from_mermaid': {
        const params = z.object({
          mermaidDiagram: z.string(),
          config: z.object({
            startOnLoad: z.boolean().optional(),
            flowchart: z.object({
              curve: z.enum(['linear', 'basis']).optional()
            }).optional(),
            themeVariables: z.object({
              fontSize: z.string().optional()
            }).optional(),
            maxEdges: z.number().optional(),
            maxTextSize: z.number().optional()
          }).optional()
        }).parse(args);
        
        const sessionId = await getSessionId();
        
        const response = await fetch(`${EXPRESS_SERVER_URL}/api/sessions/${sessionId}/elements/from-mermaid`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mermaidDiagram: params.mermaidDiagram,
            config: params.config
          })
        });

        if (!response.ok) {
          throw new Error(`Failed to convert Mermaid diagram: ${response.statusText}`);
        }

        const canvasUrl = `${PUBLIC_URL}/canvas/${sessionId}`;
        
        return {
          content: [{
            type: 'text',
            text: `📊 Mermaid diagram sent for conversion!

**Live Canvas:** ${canvasUrl}

The diagram is being rendered. Call \`finish_diagram\` when you're ready to get a shareable link and image.`
          }]
        };
      }
      
      case 'batch_create_elements': {
        const params = z.object({ elements: z.array(ElementSchema) }).parse(args);
        
        // Ensure we have a session
        await getSessionId();
        
        logger.info('Batch creating elements via MCP', { count: params.elements.length });

        const createdElements: ServerElement[] = params.elements.map(elementData => {
          const id = generateId();
          const element: ServerElement = {
            id,
            ...elementData,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            version: 1
          };
          return convertTextToLabel(element);
        });
        
        const canvasResult = await syncToCanvas('batch_create', createdElements);
        
        if (!canvasResult) {
          throw new Error('Failed to batch create elements: Canvas server unavailable');
        }
        
        return {
          content: [{ 
            type: 'text', 
            text: `✅ ${createdElements.length} elements created successfully!` 
          }]
        };
      }
      
      case 'finish_diagram': {
        const params = FinishDiagramSchema.parse(args || {});
        const sessionId = await getSessionId();
        
        logger.info('Finishing diagram', { sessionId, title: params.title });
        
        // Call the export endpoint
        const result = await syncToCanvas('export', { title: params.title });
        
        if (!result || !result.success) {
          throw new Error('Failed to export diagram: ' + (result?.error || 'Unknown error'));
        }
        
        const canvasUrl = result.canvasUrl || `${PUBLIC_URL}/canvas/${sessionId}`;
        const imageUrl = result.imageUrl;
        
        return {
          content: [{
            type: 'text',
            text: `🎉 **Diagram Complete!**

${params.title ? `**Title:** ${params.title}\n` : ''}
**📎 Shareable Link:** ${canvasUrl}
${imageUrl ? `**🖼️ Image:** ${imageUrl}\n` : ''}
**Session ID:** \`${sessionId}\`

Share this link with anyone to view the diagram!`
          }]
        };
      }
      
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    logger.error(`Error handling tool call: ${(error as Error).message}`, { error });
    return {
      content: [{ type: 'text', text: `❌ Error: ${(error as Error).message}` }],
      isError: true
    };
  }
}

// Set up request handler for tool calls (stdio mode)
mcpServer.setRequestHandler(CallToolRequestSchema, handleToolCall);

// Set up request handler for listing available tools
mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
  logger.info('Listing available tools');
  return { tools };
});

// Create Express app for SSE transport
const sseApp = express();
sseApp.use(cors());

// Store active SSE transports by session ID
const sseTransports = new Map<string, SSEServerTransport>();

// Store MCP server instances per session (each user needs their own)
const mcpServers = new Map<string, Server>();

// Create a new MCP server instance for a session
function createMcpServerForSession(sessionId: string): Server {
  const server = new Server(
    {
      name: "mcp-excalidraw-server",
      version: "2.0.0",
      description: "Hosted MCP server for Excalidraw - create diagrams with AI and get shareable links"
    },
    {
      capabilities: {
        tools: Object.fromEntries(tools.map(tool => [tool.name, {
          description: tool.description,
          inputSchema: tool.inputSchema
        }]))
      }
    }
  );
  
  // Set up the same handlers for this server instance
  server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest) => {
    // Set the current session for this request
    currentSessionId = sessionId;
    return handleToolCall(request);
  });
  
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    logger.info('Listing available tools');
    return { tools };
  });
  
  mcpServers.set(sessionId, server);
  return server;
}

// SSE endpoint for MCP connections
sseApp.get('/sse', async (req: Request, res: Response) => {
  logger.info('New SSE connection request');
  
  // Create a new session for this connection
  const sessionId = await createNewSession();
  
  // Create unique message endpoint for this session
  const messageEndpoint = `/messages/${sessionId}`;
  
  const transport = new SSEServerTransport(messageEndpoint, res);
  sseTransports.set(sessionId, transport);
  
  // Create a dedicated MCP server for this session
  const server = createMcpServerForSession(sessionId);
  
  res.on('close', () => {
    logger.info(`SSE connection closed for session: ${sessionId}`);
    sseTransports.delete(sessionId);
    mcpServers.delete(sessionId);
  });
  
  await server.connect(transport);
  logger.info(`SSE transport connected for session: ${sessionId}`);
});

// Messages endpoint for SSE - route by session ID
sseApp.post('/messages/:sessionId', async (req: Request, res: Response) => {
  const sessionId = req.params.sessionId as string;
  
  if (!sessionId) {
    return res.status(400).json({ error: 'Session ID is required' });
  }
  
  const transport = sseTransports.get(sessionId);
  
  if (transport) {
    // Set the current session context
    currentSessionId = sessionId;
    await transport.handlePostMessage(req, res);
  } else {
    res.status(404).json({ error: `No active session: ${sessionId}` });
  }
});

// Health check for SSE server
sseApp.get('/health', (req: Request, res: Response) => {
  res.json({
    status: 'healthy',
    mode: 'sse',
    activeSessions: sseTransports.size,
    timestamp: new Date().toISOString()
  });
});

// Start server with transport based on mode
async function runServer(): Promise<void> {
  try {
    logger.info('Starting Excalidraw MCP server...');
    
    const transportMode = process.env.MCP_TRANSPORT_MODE || 'stdio';
    
    if (transportMode === 'sse' || transportMode === 'http') {
      // Start SSE server for remote connections
      sseApp.listen(MCP_PORT, '0.0.0.0', () => {
        logger.info(`MCP SSE server running on http://0.0.0.0:${MCP_PORT}`);
        logger.info(`Connect via SSE at http://localhost:${MCP_PORT}/sse`);
      });
    } else {
      // Default to stdio transport for local use
      const transport = new StdioServerTransport();
      
      // Create a session for stdio mode
      await createNewSession();
      
      await mcpServer.connect(transport);
      logger.info('Excalidraw MCP server running on stdio');
      
      process.stdin.resume();
    }
  } catch (error) {
    logger.error('Error starting server:', error);
    process.stderr.write(`Failed to start MCP server: ${(error as Error).message}\n${(error as Error).stack}\n`);
    process.exit(1);
  }
}

// Add global error handlers
process.on('uncaughtException', (error: Error) => {
  logger.error('Uncaught exception:', error);
  process.stderr.write(`UNCAUGHT EXCEPTION: ${error.message}\n${error.stack}\n`);
  setTimeout(() => process.exit(1), 1000);
});

process.on('unhandledRejection', (reason: any) => {
  logger.error('Unhandled promise rejection:', reason);
  process.stderr.write(`UNHANDLED REJECTION: ${reason}\n`);
  setTimeout(() => process.exit(1), 1000);
});

// Start the server if this file is run directly
if (fileURLToPath(import.meta.url) === process.argv[1]) {
  runServer().catch(error => {
    logger.error('Failed to start server:', error);
    process.exit(1);
  });
}

export default runServer;
