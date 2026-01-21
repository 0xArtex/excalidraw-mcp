import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import logger from './utils/logger.js';
import { 
  generateId, 
  EXCALIDRAW_ELEMENT_TYPES,
  ServerElement,
  ExcalidrawElementType,
  WebSocketMessage,
  ElementCreatedMessage,
  ElementUpdatedMessage,
  ElementDeletedMessage,
  BatchCreatedMessage,
  SyncStatusMessage,
  InitialElementsMessage
} from './types.js';
import {
  createSession,
  getSession,
  getOrCreateSession,
  deleteSession,
  getAllSessions,
  getSessionCount,
  getSessionStats,
  updateSessionTitle,
  finalizeSession,
  startSessionCleanup,
  generateSessionId,
  Session
} from './sessions.js';
import { exportSessionToImage, startExportCleanup, closeBrowser } from './imageExport.js';
import { z } from 'zod';

// Load environment variables
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

// Middleware
app.use(cors());

// Conditional body parsing - skip for SSE endpoints that need raw body
app.use((req, res, next) => {
  // SSE message endpoints need raw body access
  if (req.path === '/sse/message' || req.path.startsWith('/messages/')) {
    next();
  } else {
    express.json()(req, res, next);
  }
});

// Serve static files from the build directory
const staticDir = path.join(__dirname, '../dist');
app.use(express.static(staticDir));
// Also serve frontend assets
app.use(express.static(path.join(__dirname, '../dist/frontend')));
// Serve exported images
app.use('/exports', express.static(path.join(__dirname, '../exports')));

// WebSocket connections per session
const sessionClients = new Map<string, Set<WebSocket>>();

// Broadcast to all connected clients in a session
function broadcastToSession(sessionId: string, message: WebSocketMessage): void {
  const clients = sessionClients.get(sessionId);
  if (!clients) return;
  
  const data = JSON.stringify(message);
  clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
}

// WebSocket connection handling
wss.on('connection', (ws: WebSocket, req) => {
  // Extract session ID from URL query params
  const url = new URL(req.url || '', `http://${req.headers.host}`);
  const sessionId = url.searchParams.get('sessionId') || generateSessionId();
  
  // Get or create session
  const session = getOrCreateSession(sessionId);
  
  // Add client to session's client set
  if (!sessionClients.has(sessionId)) {
    sessionClients.set(sessionId, new Set());
  }
  sessionClients.get(sessionId)!.add(ws);
  
  logger.info(`New WebSocket connection for session: ${sessionId}`);
  
  // Send session info to new client
  const sessionInfoMessage = {
    type: 'session_info',
    sessionId: session.id,
    createdAt: session.createdAt.toISOString()
  };
  ws.send(JSON.stringify(sessionInfoMessage));
  
  // Send current elements to new client
  const initialMessage: InitialElementsMessage = {
    type: 'initial_elements',
    elements: Array.from(session.elements.values())
  };
  ws.send(JSON.stringify(initialMessage));
  
  // Send sync status to new client
  const syncMessage: SyncStatusMessage = {
    type: 'sync_status',
    elementCount: session.elements.size,
    timestamp: new Date().toISOString()
  };
  ws.send(JSON.stringify(syncMessage));
  
  ws.on('close', () => {
    const clients = sessionClients.get(sessionId);
    if (clients) {
    clients.delete(ws);
      if (clients.size === 0) {
        sessionClients.delete(sessionId);
      }
    }
    logger.info(`WebSocket connection closed for session: ${sessionId}`);
  });
  
  ws.on('error', (error) => {
    logger.error('WebSocket error:', error);
    const clients = sessionClients.get(sessionId);
    if (clients) {
    clients.delete(ws);
    }
  });
});

// Schema validation
const CreateElementSchema = z.object({
  id: z.string().optional(),
  type: z.enum(Object.values(EXCALIDRAW_ELEMENT_TYPES) as [ExcalidrawElementType, ...ExcalidrawElementType[]]),
  x: z.number(),
  y: z.number(),
  width: z.number().optional(),
  height: z.number().optional(),
  backgroundColor: z.string().optional(),
  strokeColor: z.string().optional(),
  strokeWidth: z.number().optional(),
  roughness: z.number().optional(),
  opacity: z.number().optional(),
  text: z.string().optional(),
  label: z.object({
    text: z.string()
  }).optional(),
  fontSize: z.number().optional(),
  fontFamily: z.string().optional(),
  groupIds: z.array(z.string()).optional(),
  locked: z.boolean().optional()
});

const UpdateElementSchema = z.object({
  id: z.string(),
  type: z.enum(Object.values(EXCALIDRAW_ELEMENT_TYPES) as [ExcalidrawElementType, ...ExcalidrawElementType[]]).optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  backgroundColor: z.string().optional(),
  strokeColor: z.string().optional(),
  strokeWidth: z.number().optional(),
  roughness: z.number().optional(),
  opacity: z.number().optional(),
  text: z.string().optional(),
  label: z.object({
    text: z.string()
  }).optional(),
  fontSize: z.number().optional(),
  fontFamily: z.string().optional(),
  groupIds: z.array(z.string()).optional(),
  locked: z.boolean().optional()
});

// ==================== SESSION ROUTES ====================

// Create a new session
app.post('/api/sessions', (req: Request, res: Response) => {
  try {
    const session = createSession();
    res.json({
      success: true,
      session: {
        id: session.id,
        createdAt: session.createdAt.toISOString(),
        canvasUrl: `/canvas/${session.id}`,
        apiUrl: `/api/sessions/${session.id}/elements`
      }
    });
  } catch (error) {
    logger.error('Error creating session:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Get session info
app.get('/api/sessions/:sessionId', (req: Request, res: Response) => {
  try {
    const sessionId = req.params.sessionId as string;
    const session = getSession(sessionId);
    
    if (!session) {
      return res.status(404).json({
        success: false,
        error: `Session ${sessionId} not found`
      });
    }
    
    res.json({
      success: true,
      session: {
        id: session.id,
        createdAt: session.createdAt.toISOString(),
        lastActivity: session.lastActivity.toISOString(),
        elementCount: session.elements.size,
        title: session.title,
        imageUrl: session.imageUrl,
        isFinalized: session.isFinalized,
        canvasUrl: `/canvas/${session.id}`
      }
    });
  } catch (error) {
    logger.error('Error getting session:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Get session stats
app.get('/api/sessions', (req: Request, res: Response) => {
  try {
    const stats = getSessionStats();
    res.json({
      success: true,
      stats
    });
  } catch (error) {
    logger.error('Error getting session stats:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// ==================== SESSION-BASED ELEMENT ROUTES ====================

// Get all elements for a session
app.get('/api/sessions/:sessionId/elements', (req: Request, res: Response) => {
  try {
    const sessionId = req.params.sessionId as string;
    const session = getSession(sessionId);
    
    if (!session) {
      return res.status(404).json({
        success: false,
        error: `Session ${sessionId} not found`
      });
    }
    
    const elementsArray = Array.from(session.elements.values());
    res.json({
      success: true,
      elements: elementsArray,
      count: elementsArray.length
    });
  } catch (error) {
    logger.error('Error fetching elements:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Create new element in a session
app.post('/api/sessions/:sessionId/elements', (req: Request, res: Response) => {
  try {
    const sessionId = req.params.sessionId as string;
    const session = getOrCreateSession(sessionId);
    
    const params = CreateElementSchema.parse(req.body);
    logger.info('Creating element via API', { sessionId, type: params.type });

    const id = params.id || generateId();
    const element: ServerElement = {
      id,
      ...params,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1
    };

    session.elements.set(id, element);
    
    // Broadcast to all connected clients in this session
    const message: ElementCreatedMessage = {
      type: 'element_created',
      element: element
    };
    broadcastToSession(sessionId, message);
    
    res.json({
      success: true,
      element: element
    });
  } catch (error) {
    logger.error('Error creating element:', error);
    res.status(400).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Update element in a session
app.put('/api/sessions/:sessionId/elements/:id', (req: Request, res: Response) => {
  try {
    const sessionId = req.params.sessionId as string;
    const id = req.params.id as string;
    const session = getSession(sessionId);
    
    if (!session) {
      return res.status(404).json({
        success: false,
        error: `Session ${sessionId} not found`
      });
    }
    
    const updates = UpdateElementSchema.parse({ id, ...req.body });
    
    const existingElement = session.elements.get(id);
    if (!existingElement) {
      return res.status(404).json({
        success: false,
        error: `Element with ID ${id} not found`
      });
    }

    const updatedElement: ServerElement = {
      ...existingElement,
      ...updates,
      updatedAt: new Date().toISOString(),
      version: (existingElement.version || 0) + 1
    };

    session.elements.set(id, updatedElement);
    
    const message: ElementUpdatedMessage = {
      type: 'element_updated',
      element: updatedElement
    };
    broadcastToSession(sessionId, message);
    
    res.json({
      success: true,
      element: updatedElement
    });
  } catch (error) {
    logger.error('Error updating element:', error);
    res.status(400).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Delete element from a session
app.delete('/api/sessions/:sessionId/elements/:id', (req: Request, res: Response) => {
  try {
    const sessionId = req.params.sessionId as string;
    const id = req.params.id as string;
    const session = getSession(sessionId);
    
    if (!session) {
      return res.status(404).json({
        success: false,
        error: `Session ${sessionId} not found`
      });
    }
    
    if (!session.elements.has(id)) {
      return res.status(404).json({
        success: false,
        error: `Element with ID ${id} not found`
      });
    }
    
    session.elements.delete(id);
    
    const message: ElementDeletedMessage = {
      type: 'element_deleted',
      elementId: id
    };
    broadcastToSession(sessionId, message);
    
    res.json({
      success: true,
      message: `Element ${id} deleted successfully`
    });
  } catch (error) {
    logger.error('Error deleting element:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Batch create elements in a session
app.post('/api/sessions/:sessionId/elements/batch', (req: Request, res: Response) => {
  try {
    const sessionId = req.params.sessionId as string;
    const session = getOrCreateSession(sessionId);
    const { elements: elementsToCreate } = req.body;
    
    if (!Array.isArray(elementsToCreate)) {
      return res.status(400).json({
        success: false,
        error: 'Expected an array of elements'
      });
    }
    
    const createdElements: ServerElement[] = [];
    
    elementsToCreate.forEach(elementData => {
      const params = CreateElementSchema.parse(elementData);
      const id = generateId();
      const element: ServerElement = {
        id,
        ...params,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        version: 1
      };
      
      session.elements.set(id, element);
      createdElements.push(element);
    });
    
    const message: BatchCreatedMessage = {
      type: 'elements_batch_created',
      elements: createdElements
    };
    broadcastToSession(sessionId, message);
    
    res.json({
      success: true,
      elements: createdElements,
      count: createdElements.length
    });
  } catch (error) {
    logger.error('Error batch creating elements:', error);
    res.status(400).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Convert Mermaid diagram to Excalidraw elements
app.post('/api/sessions/:sessionId/elements/from-mermaid', (req: Request, res: Response) => {
  try {
    const sessionId = req.params.sessionId as string;
    const session = getOrCreateSession(sessionId);
    const { mermaidDiagram, config } = req.body;
    
    if (!mermaidDiagram || typeof mermaidDiagram !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Mermaid diagram definition is required'
      });
    }
    
    logger.info('Received Mermaid conversion request', { 
      sessionId,
      diagramLength: mermaidDiagram.length,
      hasConfig: !!config 
    });
    
    // Broadcast to all WebSocket clients in this session to process the Mermaid diagram
    broadcastToSession(sessionId, {
      type: 'mermaid_convert',
      mermaidDiagram,
      config: config || {},
      timestamp: new Date().toISOString()
    });
    
    res.json({
      success: true,
      mermaidDiagram,
      config: config || {},
      message: 'Mermaid diagram sent to frontend for conversion.'
    });
  } catch (error) {
    logger.error('Error processing Mermaid diagram:', error);
    res.status(400).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Sync elements from frontend
app.post('/api/sessions/:sessionId/elements/sync', (req: Request, res: Response) => {
  try {
    const sessionId = req.params.sessionId as string;
    const session = getOrCreateSession(sessionId);
    const { elements: frontendElements, timestamp } = req.body;
    
    logger.info(`Sync request received for session ${sessionId}: ${frontendElements.length} elements`, {
      timestamp,
      elementCount: frontendElements.length
    });
    
    if (!Array.isArray(frontendElements)) {
      return res.status(400).json({
        success: false,
        error: 'Expected elements to be an array'
      });
    }
    
    const beforeCount = session.elements.size;
    session.elements.clear();
    
    let successCount = 0;
    
    frontendElements.forEach((element: any) => {
      try {
        const elementId = element.id || generateId();
        const processedElement: ServerElement = {
          ...element,
          id: elementId,
          syncedAt: new Date().toISOString(),
          source: 'frontend_sync',
          syncTimestamp: timestamp,
          version: 1
        };
        
        session.elements.set(elementId, processedElement);
        successCount++;
      } catch (elementError) {
        logger.warn(`Failed to process element:`, elementError);
      }
    });
    
    logger.info(`Sync completed for session ${sessionId}: ${successCount}/${frontendElements.length} elements synced`);
    
    broadcastToSession(sessionId, {
      type: 'elements_synced',
      count: successCount,
      timestamp: new Date().toISOString(),
      source: 'manual_sync'
    });
    
    res.json({
      success: true,
      message: `Successfully synced ${successCount} elements`,
      count: successCount,
      syncedAt: new Date().toISOString(),
      beforeCount,
      afterCount: session.elements.size
    });
    
  } catch (error) {
    logger.error('Sync error:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message,
      details: 'Internal server error during sync operation'
    });
  }
});

// Export session to image
app.post('/api/sessions/:sessionId/export', async (req: Request, res: Response) => {
  try {
    const sessionId = req.params.sessionId as string;
    const { title } = req.body;
    const session = getSession(sessionId);
    
    if (!session) {
      return res.status(404).json({
        success: false,
        error: `Session ${sessionId} not found`
      });
    }
    
    // Update title if provided
    if (title) {
      updateSessionTitle(sessionId, title);
    }
    
    // Export to image
    const result = await exportSessionToImage(sessionId);
    
    if (!result.success) {
      return res.status(500).json({
        success: false,
        error: result.error
      });
    }
    
    // Mark session as finalized
    finalizeSession(sessionId, result.imageUrl!);
    
    const baseUrl = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
    
    res.json({
      success: true,
      sessionId,
      title: session.title,
      canvasUrl: `${baseUrl}/canvas/${sessionId}`,
      imageUrl: result.imageUrl,
      message: 'Diagram exported successfully!'
    });
  } catch (error) {
    logger.error('Error exporting session:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// ==================== LEGACY ROUTES (for backward compatibility) ====================

// Default session for legacy API calls
const DEFAULT_SESSION_ID = 'default';

// Get all elements (legacy)
app.get('/api/elements', (req: Request, res: Response) => {
  try {
    const session = getOrCreateSession(DEFAULT_SESSION_ID);
    const elementsArray = Array.from(session.elements.values());
    res.json({
      success: true,
      elements: elementsArray,
      count: elementsArray.length
    });
  } catch (error) {
    logger.error('Error fetching elements:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Create new element (legacy)
app.post('/api/elements', (req: Request, res: Response) => {
  try {
    const session = getOrCreateSession(DEFAULT_SESSION_ID);
    const params = CreateElementSchema.parse(req.body);
    logger.info('Creating element via API (legacy)', { type: params.type });

    const id = params.id || generateId();
    const element: ServerElement = {
      id,
      ...params,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1
    };

    session.elements.set(id, element);
    
    const message: ElementCreatedMessage = {
      type: 'element_created',
      element: element
    };
    broadcastToSession(DEFAULT_SESSION_ID, message);
    
    res.json({
      success: true,
      element: element
    });
  } catch (error) {
    logger.error('Error creating element:', error);
    res.status(400).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// ==================== CANVAS ROUTES ====================

// Serve the frontend for session-based canvas
app.get('/canvas/:sessionId', (req: Request, res: Response) => {
  const htmlFile = path.join(__dirname, '../dist/frontend/index.html');
  res.sendFile(htmlFile, (err) => {
    if (err) {
      logger.error('Error serving frontend:', err);
      res.status(404).send('Frontend not found. Please run "npm run build" first.');
    }
  });
});

// Serve the frontend (default - creates new session)
app.get('/', (req: Request, res: Response) => {
  // Redirect to a new session
  const newSessionId = generateSessionId();
  res.redirect(`/canvas/${newSessionId}`);
});

// Health check endpoint
app.get('/health', (req: Request, res: Response) => {
  const stats = getSessionStats();
  const publicUrl = process.env.PUBLIC_URL || 
    (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : `http://localhost:${process.env.PORT || 3000}`);
  
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    sessions: stats,
    websocket_clients: Array.from(sessionClients.values()).reduce((acc, set) => acc + set.size, 0),
    mcp_clients: sseTransports.size,
    endpoints: {
      canvas: `${publicUrl}/canvas/:sessionId`,
      mcp_sse: `${publicUrl}/sse`,
      health: `${publicUrl}/health`
    }
  });
});

// Sync status endpoint
app.get('/api/sync/status', (req: Request, res: Response) => {
  const stats = getSessionStats();
  res.json({
    success: true,
    sessions: stats,
    timestamp: new Date().toISOString(),
    memoryUsage: {
      heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      heapTotal: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
    },
    websocketClients: Array.from(sessionClients.values()).reduce((acc, set) => acc + set.size, 0)
  });
});

// Error handling middleware
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error'
  });
});

// ==================== MCP ENDPOINTS ====================
// These endpoints allow remote AI agents to connect via Streamable HTTP or SSE transport

import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ListPromptsRequestSchema, GetPromptRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { handleMcpToolCall, mcpTools, mcpPrompts, getPromptContent, setCurrentSession } from './mcp-handler.js';
import { randomUUID } from 'crypto';
import { IncomingMessage, ServerResponse } from 'http';

// Store active transports and servers
const streamableTransports = new Map<string, StreamableHTTPServerTransport>();
const sseTransports = new Map<string, SSEServerTransport>();
const mcpServers = new Map<string, McpServer>();

// Create MCP server instance
function createMcpServer(): McpServer {
  const mcpServer = new McpServer(
    {
      name: "mcp-excalidraw-server",
      version: "2.0.0",
      description: "Create diagrams with AI and get shareable links"
    },
    {
      capabilities: {
        tools: {},
        prompts: {}
      }
    }
  );
  
  mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    return handleMcpToolCall(request.params.name, request.params.arguments);
  });
  
  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: mcpTools };
  });
  
  // Prompt handlers - these appear as slash commands in Claude Code
  mcpServer.setRequestHandler(ListPromptsRequestSchema, async () => {
    return { prompts: mcpPrompts };
  });
  
  mcpServer.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const messages = getPromptContent(name, args || {});
    return { messages };
  });
  
  return mcpServer;
}

// ==================== MCP TRANSPORTS ====================
// Per MCP spec: Support both Streamable HTTP (modern) and legacy SSE on same endpoint

// POST /sse - Streamable HTTP transport (modern clients try this first)
app.post('/sse', async (req: Request, res: Response) => {
  logger.info('MCP Streamable HTTP request (POST /sse)');
  
  // Check for existing session
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  let transport = sessionId ? streamableTransports.get(sessionId) : undefined;
  
  if (!transport) {
    // New session - create transport
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID()
    });
    
    const mcpServer = createMcpServer();
    
    // Connect and store
    await mcpServer.connect(transport);
    
    // Store transport after connection (session ID is generated during first request)
    const newSessionId = transport.sessionId;
    if (newSessionId) {
      streamableTransports.set(newSessionId, transport);
      mcpServers.set(newSessionId, mcpServer);
      logger.info(`New Streamable HTTP session: ${newSessionId}`);
    }
  }
  
  try {
    await transport.handleRequest(
      req as unknown as IncomingMessage,
      res as unknown as ServerResponse,
      req.body
    );
  } catch (error) {
    logger.error('Error handling Streamable HTTP request:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to process request' });
    }
  }
});

// GET /sse - Legacy SSE transport (fallback for older clients)  
app.get('/sse', async (req: Request, res: Response) => {
  logger.info('MCP Legacy SSE connection request (GET /sse)');
  
  try {
    const sessionId = randomUUID();
    
    // Create transport - message endpoint for client to POST messages
    const messageEndpoint = `/sse/message`;
    const transport = new SSEServerTransport(messageEndpoint, res);
    
    // Store transport
    sseTransports.set(sessionId, transport);
    (transport as any)._sessionId = sessionId;
    
    const mcpServer = createMcpServer();
    mcpServers.set(sessionId, mcpServer);
    
    // Cleanup on close
    res.on('close', () => {
      logger.info(`SSE connection closed: ${sessionId}`);
      sseTransports.delete(sessionId);
      mcpServers.delete(sessionId);
    });
    
    // Connect MCP server to transport
    await mcpServer.connect(transport);
    logger.info(`Legacy SSE connected: ${sessionId}`);
  } catch (error) {
    logger.error('Error setting up SSE connection:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to establish SSE connection' });
    }
  }
});

// POST /sse/message - Handle legacy SSE messages
app.post('/sse/message', async (req: Request, res: Response) => {
  logger.info('MCP Legacy SSE message received');
  
  // Get the most recent transport
  const transports = Array.from(sseTransports.values());
  
  if (transports.length === 0) {
    return res.status(404).json({ error: 'No active SSE session' });
  }
  
  const transport = transports[transports.length - 1];
  if (!transport) {
    return res.status(404).json({ error: 'Transport not found' });
  }
  
  const sessionId = (transport as any)._sessionId;
  if (sessionId) {
    setCurrentSession(sessionId);
  }
  
  try {
    await transport.handlePostMessage(req, res);
  } catch (error) {
    logger.error('Error handling SSE message:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to process message' });
    }
  }
});

// DELETE /sse - Handle session termination (Streamable HTTP)
app.delete('/sse', async (req: Request, res: Response) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  
  if (sessionId) {
    const transport = streamableTransports.get(sessionId);
    if (transport) {
      await transport.close();
      streamableTransports.delete(sessionId);
      mcpServers.delete(sessionId);
      logger.info(`Session terminated: ${sessionId}`);
    }
  }
  
  res.status(200).end();
});

// ==================== /mcp ENDPOINT (Streamable HTTP) ====================
// Stateless transport - new transport per request, no session tracking

app.all('/mcp', async (req: Request, res: Response) => {
  logger.info(`MCP Streamable HTTP: ${req.method} /mcp`);
  
  try {
    // Create stateless transport (no session ID generator = stateless mode)
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined // Stateless mode
    });
    
    // Create and connect MCP server for this request
    const mcpServer = createMcpServer();
    
    // Handle the close event
    transport.onclose = () => {
      logger.info('Streamable HTTP transport closed');
    };
    
    // Connect server to transport
    await mcpServer.connect(transport);
    
    // Handle the request
    await transport.handleRequest(
      req as unknown as IncomingMessage,
      res as unknown as ServerResponse,
      req.body
    );
  } catch (error) {
    logger.error('Error handling /mcp request:', error);
    if (!res.headersSent) {
      res.status(500).json({ 
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal error' },
        id: null
      });
    }
  }
});

// MCP health check
app.get('/mcp/health', (req: Request, res: Response) => {
  res.json({
    status: 'healthy',
    streamableSessions: streamableTransports.size,
    sseSessions: sseTransports.size,
    timestamp: new Date().toISOString()
  });
});

// Start server
const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0'; // Listen on all interfaces for Docker

server.listen(PORT, HOST, () => {
  logger.info(`Canvas server running on http://${HOST}:${PORT}`);
  logger.info(`WebSocket server running on ws://${HOST}:${PORT}`);
  
  // Start cleanup jobs
  startSessionCleanup();
  startExportCleanup();
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down...');
  await closeBrowser();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down...');
  await closeBrowser();
  process.exit(0);
});

export default app;
