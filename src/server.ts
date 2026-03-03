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

// Rate limiting by IP (configurable via RATE_LIMIT_RPM env, default 10 req/min)
const RATE_LIMIT_RPM = parseInt(process.env.RATE_LIMIT_RPM || '10', 10);
const RATE_LIMIT_WINDOW_MS = 60_000;
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

// Cleanup stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of rateLimitMap) {
    if (now > val.resetAt) rateLimitMap.delete(key);
  }
}, 5 * 60_000);

function getRateLimitKey(req: Request): string {
  return req.headers['x-forwarded-for']?.toString().split(',')[0]?.trim() || req.ip || 'unknown';
}

// Apply rate limit only to /api/render
app.use('/api/render', (req: Request, res: Response, next: NextFunction) => {
  const key = getRateLimitKey(req);
  const now = Date.now();
  let entry = rateLimitMap.get(key);

  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    rateLimitMap.set(key, entry);
  }

  entry.count++;
  const remaining = Math.max(0, RATE_LIMIT_RPM - entry.count);
  res.set('X-RateLimit-Limit', String(RATE_LIMIT_RPM));
  res.set('X-RateLimit-Remaining', String(remaining));
  res.set('X-RateLimit-Reset', String(Math.ceil(entry.resetAt / 1000)));

  if (entry.count > RATE_LIMIT_RPM) {
    res.status(429).json({ error: 'Rate limit exceeded', retryAfterMs: entry.resetAt - now });
    return;
  }
  next();
});

// Body size limit (5MB)
app.use(express.json({ limit: '5mb' }));

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
  locked: z.boolean().optional(),
  points: z.array(z.array(z.number())).optional(),
  startArrowhead: z.string().nullable().optional(),
  endArrowhead: z.string().nullable().optional(),
  startBinding: z.any().optional(),
  endBinding: z.any().optional(),
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
    
    // Auto-calculate width/height from points for arrows/lines/freedraw
    const extra: any = {};
    if (params.points && ['arrow', 'line', 'freedraw'].includes(params.type)) {
      const xs = params.points.map((p) => p[0] ?? 0);
      const ys = params.points.map((p) => p[1] ?? 0);
      if (!(params as any).width) extra.width = Math.max(...xs) - Math.min(...xs);
      if (!(params as any).height) extra.height = Math.max(...ys) - Math.min(...ys);
      if (params.type === 'freedraw') {
        extra.simulatePressure = true;
        extra.pressures = [];
        extra.lastCommittedPoint = params.points[params.points.length - 1];
      }
    }
    
    const element: ServerElement = {
      id,
      ...params,
      ...extra,
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

// ==================== STATELESS RENDER API ====================

// POST /api/render - Stateless rendering: takes elements, returns PNG + edit URL
// Nothing is stored. Elements exist only for the duration of the request.
app.post('/api/render', async (req: Request, res: Response) => {
  try {
    const { elements: inputElements, background, theme } = req.body;

    if (!inputElements || !Array.isArray(inputElements) || inputElements.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'elements array is required and must not be empty'
      });
    }

    const MAX_ELEMENTS = parseInt(process.env.MAX_ELEMENTS || '2000', 10);
    if (inputElements.length > MAX_ELEMENTS) {
      return res.status(400).json({
        success: false,
        error: `Too many elements (${inputElements.length}). Maximum is ${MAX_ELEMENTS}.`
      });
    }

    // Create a temporary session
    const tempSessionId = `render-${generateId()}`;
    const session = getOrCreateSession(tempSessionId);

    // Normalize simplified element format to full Excalidraw format
    const normalizedElements: any[] = [];
    for (const el of inputElements) {
      const id = el.id || generateId();
      
      // Map shorthand props to Excalidraw props
      const normalized: any = {
        ...el,
        id,
        version: el.version || 1,
        versionNonce: el.versionNonce || Math.floor(Math.random() * 1000000),
        isDeleted: false,
        groupIds: el.groupIds || [],
        frameId: el.frameId || null,
        roundness: el.roundness ?? (['rectangle', 'diamond', 'ellipse'].includes(el.type) ? { type: 3 } : null),
        boundElements: el.boundElements || null,
        updated: el.updated || Date.now(),
        link: el.link || null,
        locked: el.locked || false,
        strokeColor: el.stroke || el.strokeColor || '#1e1e1e',
        backgroundColor: el.bg || el.backgroundColor || 'transparent',
        fillStyle: (el.bg || el.backgroundColor) ? (el.fillStyle || 'solid') : (el.fillStyle || 'solid'),
        strokeWidth: el.strokeWidth || 2,
        roughness: el.roughness ?? 1,
        opacity: el.opacity || 100,
        angle: el.angle || 0,
        seed: el.seed || Math.floor(Math.random() * 1000000),
      };

      // Remove shorthand props
      delete normalized.bg;
      delete normalized.stroke;
      delete normalized.label;

      // Set type-specific defaults
      if (['arrow', 'line', 'freedraw'].includes(el.type)) {
        normalized.points = el.points || [[0, 0]];
        if (el.type === 'arrow') {
          normalized.startBinding = el.startBinding || null;
          normalized.endBinding = el.endBinding || null;
          normalized.startArrowhead = el.startArrowhead || null;
          normalized.endArrowhead = el.endArrowhead || 'arrow';
        }
        if (el.type === 'freedraw') {
          normalized.simulatePressure = el.simulatePressure ?? true;
          normalized.pressures = el.pressures || [];
          const pts = normalized.points;
          if (pts.length > 0) {
            normalized.lastCommittedPoint = pts[pts.length - 1];
          }
        }
      }

      if (el.type === 'text') {
        normalized.fontSize = el.fontSize || 20;
        normalized.fontFamily = el.fontFamily || 1;
        normalized.textAlign = el.textAlign || 'left';
        normalized.verticalAlign = el.verticalAlign || 'top';
        normalized.text = el.text || '';
        normalized.rawText = el.text || '';
      }

      normalizedElements.push(normalized);

      // Handle label: create a text element visually centered in the shape
      // We use containerId binding AND calculate accurate initial coordinates
      // so text appears centered even before Excalidraw recalculates
      if (el.label && ['rectangle', 'ellipse', 'diamond'].includes(el.type)) {
        const labelText = typeof el.label === 'string' ? el.label : el.label?.text || '';
        if (labelText) {
          const labelId = generateId();
          const fontSize = el.fontSize || 16;
          const shapeX = el.x || 0;
          const shapeY = el.y || 0;
          const shapeW = el.width || 100;
          const shapeH = el.height || 50;
          
          const textHeight = fontSize * 1.35;
          // Excalidraw's hand-drawn font has extra ascender space,
          // so we add a small downward offset to visually center
          const verticalFudge = fontSize * 0.10;
          
          const labelElement: any = {
            id: labelId,
            type: 'text',
            // Position text at shape center; containerId + textAlign:center handles the rest
            x: shapeX + shapeW / 2,
            y: shapeY + shapeH / 2 - textHeight / 2 + verticalFudge,
            width: shapeW,
            height: textHeight,
            text: labelText,
            rawText: labelText,
            originalText: labelText,
            autoResize: true,
            fontSize,
            fontFamily: el.fontFamily || 1,
            textAlign: 'center',
            verticalAlign: 'middle',
            containerId: id,
            strokeColor: el.stroke || el.strokeColor || '#1e1e1e',
            backgroundColor: 'transparent',
            fillStyle: 'solid',
            strokeWidth: 1,
            roughness: 0,
            opacity: 100,
            angle: 0,
            seed: Math.floor(Math.random() * 1000000),
            version: 1,
            versionNonce: Math.floor(Math.random() * 1000000),
            isDeleted: false,
            groupIds: el.groupIds || [],
            frameId: null,
            roundness: null,
            boundElements: null,
            updated: Date.now(),
            link: null,
            locked: false,
          };
          normalized.boundElements = [{ id: labelId, type: 'text' }];
          normalizedElements.push(labelElement);
        }
      }
    }

    // Add all normalized elements to the session
    for (const element of normalizedElements) {
      const serverElement: ServerElement = {
        ...element,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      session.elements.set(element.id, serverElement);
    }

    // Export to image (with 5 min timeout)
    const RENDER_TIMEOUT_MS = parseInt(process.env.RENDER_TIMEOUT_MS || '300000', 10);
    const result = await Promise.race([
      exportSessionToImage(tempSessionId),
      new Promise<{ success: false; error: string }>((_, resolve) =>
        setTimeout(() => resolve({ success: false, error: 'Render timed out' }), RENDER_TIMEOUT_MS)
      )
    ]) as Awaited<ReturnType<typeof exportSessionToImage>>;

    // Generate excalidraw.com edit URL
    const baseUrl = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
    const editUrl = `${baseUrl}/canvas/${tempSessionId}`;

    // Keep session alive for 30 min for editing, then auto-cleanup handles it
    // (Don't delete immediately — the edit URL needs it)

    // Also delete the exported image file after reading it
    let imageBuffer: Buffer | null = null;
    if (result.success && result.imagePath) {
      try {
        const fs = await import('fs/promises');
        imageBuffer = await fs.readFile(result.imagePath);
        await fs.unlink(result.imagePath).catch(() => {});
      } catch (e) {
        // Image read failed
      }
    }

    if (!result.success || !imageBuffer) {
      return res.status(500).json({
        success: false,
        error: result.error || 'Failed to render image'
      });
    }

    // Check if client wants JSON response with base64 image
    const wantsJson = req.headers.accept?.includes('application/json') || req.query.format === 'json';

    if (wantsJson) {
      return res.json({
        success: true,
        png: imageBuffer.toString('base64'),
        editUrl,
        elements: inputElements.length
      });
    }

    // Default: return PNG directly with edit URL in header
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('X-Edit-Url', editUrl);
    res.setHeader('Content-Disposition', 'inline; filename="diagram.png"');
    res.send(imageBuffer);

  } catch (error) {
    logger.error('Error in stateless render:', error);
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

// Serve the frontend for stateless view (elements in URL hash)
app.get('/canvas/view', (req: Request, res: Response) => {
  const htmlFile = path.join(__dirname, '../dist/frontend/index.html');
  res.sendFile(htmlFile, (err) => {
    if (err) {
      logger.error('Error serving frontend:', err);
      res.status(404).send('Frontend not found. Please run "npm run build" first.');
    }
  });
});

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
