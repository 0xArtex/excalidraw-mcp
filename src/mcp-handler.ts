// MCP Handler - Shared tool handling logic for both stdio and SSE modes
import { z } from 'zod';
import logger from './utils/logger.js';
import { 
  generateId, 
  EXCALIDRAW_ELEMENT_TYPES,
  ServerElement,
  ExcalidrawElementType
} from './types.js';
import {
  createSession,
  getOrCreateSession,
  updateSessionTitle,
  finalizeSession
} from './sessions.js';
import { exportSessionToImage } from './imageExport.js';

// Current session context (set per request)
let currentSessionId: string | null = null;

export function setCurrentSession(sessionId: string): void {
  currentSessionId = sessionId;
}

export function getCurrentSession(): string | null {
  return currentSessionId;
}

// Get public URL from environment
function getPublicUrl(): string {
  return process.env.PUBLIC_URL || process.env.RAILWAY_PUBLIC_DOMAIN 
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : 'http://localhost:3000';
}

// Schema definitions
export const ElementSchema = z.object({
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

export const ElementIdSchema = z.object({
  id: z.string()
});

export const ElementIdsSchema = z.object({
  elementIds: z.array(z.string())
});

export const FinishDiagramSchema = z.object({
  title: z.string().optional()
});

// Helper to convert text to label format
function convertTextToLabel(element: ServerElement): ServerElement {
  const { text, ...rest } = element;
  if (text && element.type !== 'text') {
    return { ...rest, label: { text } } as ServerElement;
  }
  return element;
}

// Tool definitions for MCP
export const mcpTools = [
  {
    name: 'start_diagram',
    description: 'Start a new diagram session. Returns a session ID and live canvas URL.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Optional title for the diagram' }
      }
    }
  },
  {
    name: 'create_element',
    description: 'Create a new Excalidraw element on the canvas',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: Object.values(EXCALIDRAW_ELEMENT_TYPES) },
        x: { type: 'number' },
        y: { type: 'number' },
        width: { type: 'number' },
        height: { type: 'number' },
        backgroundColor: { type: 'string' },
        strokeColor: { type: 'string' },
        strokeWidth: { type: 'number' },
        text: { type: 'string' },
        fontSize: { type: 'number' }
      },
      required: ['type', 'x', 'y']
    }
  },
  {
    name: 'batch_create_elements',
    description: 'Create multiple elements at once - ideal for complex diagrams',
    inputSchema: {
      type: 'object',
      properties: {
        elements: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: Object.values(EXCALIDRAW_ELEMENT_TYPES) },
              x: { type: 'number' },
              y: { type: 'number' },
              width: { type: 'number' },
              height: { type: 'number' },
              backgroundColor: { type: 'string' },
              strokeColor: { type: 'string' },
              text: { type: 'string' }
            },
            required: ['type', 'x', 'y']
          }
        }
      },
      required: ['elements']
    }
  },
  {
    name: 'delete_element',
    description: 'Delete an element from the canvas',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id']
    }
  },
  {
    name: 'finish_diagram',
    description: 'Finalize the diagram and get a shareable link with an image.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Optional title for the diagram' }
      }
    }
  }
];

// Internal API calls to the canvas server (same process)
async function callInternalApi(method: string, path: string, body?: any): Promise<any> {
  const baseUrl = 'http://localhost:' + (process.env.PORT || '3000');
  const url = `${baseUrl}${path}`;
  
  const options: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' }
  };
  
  if (body) {
    options.body = JSON.stringify(body);
  }
  
  const response = await fetch(url, options);
  return response.json();
}

// Handle MCP tool calls
export async function handleMcpToolCall(
  toolName: string, 
  args: any
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  try {
    const publicUrl = getPublicUrl();
    
    switch (toolName) {
      case 'start_diagram': {
        const params = z.object({ title: z.string().optional() }).parse(args || {});
        const session = createSession();
        currentSessionId = session.id;
        
        if (params.title) {
          updateSessionTitle(session.id, params.title);
        }
        
        const canvasUrl = `${publicUrl}/canvas/${session.id}`;
        
        return {
          content: [{
            type: 'text',
            text: `🎨 **New Diagram Session Started!**

**Session ID:** \`${session.id}\`
**Live Canvas:** ${canvasUrl}

${params.title ? `**Title:** ${params.title}\n` : ''}
You can now create elements. When done, call \`finish_diagram\` to get a shareable link and image.`
          }]
        };
      }
      
      case 'create_element': {
        const params = ElementSchema.parse(args);
        
        if (!currentSessionId) {
          const session = createSession();
          currentSessionId = session.id;
        }
        
        const id = generateId();
        const element: ServerElement = {
          id,
          ...params,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          version: 1
        };
        
        const excalidrawElement = convertTextToLabel(element);
        
        // Call internal API
        await callInternalApi('POST', `/api/sessions/${currentSessionId}/elements`, excalidrawElement);
        
        return {
          content: [{ type: 'text', text: `✅ Created ${params.type} at (${params.x}, ${params.y})` }]
        };
      }
      
      case 'batch_create_elements': {
        const params = z.object({ elements: z.array(ElementSchema) }).parse(args);
        
        if (!currentSessionId) {
          const session = createSession();
          currentSessionId = session.id;
        }
        
        const elements = params.elements.map(el => {
          const id = generateId();
          return convertTextToLabel({
            id,
            ...el,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            version: 1
          });
        });
        
        await callInternalApi('POST', `/api/sessions/${currentSessionId}/elements/batch`, { elements });
        
        return {
          content: [{ type: 'text', text: `✅ Created ${elements.length} elements` }]
        };
      }
      
      case 'delete_element': {
        const params = ElementIdSchema.parse(args);
        
        if (!currentSessionId) {
          throw new Error('No active session. Call start_diagram first.');
        }
        
        await callInternalApi('DELETE', `/api/sessions/${currentSessionId}/elements/${params.id}`);
        
        return {
          content: [{ type: 'text', text: `✅ Deleted element ${params.id}` }]
        };
      }
      
      case 'finish_diagram': {
        const params = FinishDiagramSchema.parse(args || {});
        
        if (!currentSessionId) {
          throw new Error('No active session. Call start_diagram first.');
        }
        
        if (params.title) {
          updateSessionTitle(currentSessionId, params.title);
        }
        
        // Export to image
        const exportResult = await exportSessionToImage(currentSessionId);
        
        if (exportResult.success && exportResult.imageUrl) {
          finalizeSession(currentSessionId, exportResult.imageUrl);
        }
        
        const canvasUrl = `${publicUrl}/canvas/${currentSessionId}`;
        
        return {
          content: [{
            type: 'text',
            text: `🎉 **Diagram Complete!**

${params.title ? `**Title:** ${params.title}\n` : ''}
**📎 Shareable Link:** ${canvasUrl}
${exportResult.imageUrl ? `**🖼️ Image:** ${exportResult.imageUrl}\n` : ''}

Share this link with anyone to view the diagram!`
          }]
        };
      }
      
      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  } catch (error) {
    logger.error(`MCP tool error: ${(error as Error).message}`);
    return {
      content: [{ type: 'text', text: `❌ Error: ${(error as Error).message}` }],
      isError: true
    };
  }
}
