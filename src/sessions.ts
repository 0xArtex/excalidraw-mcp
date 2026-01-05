import { ServerElement } from './types.js';
import logger from './utils/logger.js';

export interface Session {
  id: string;
  elements: Map<string, ServerElement>;
  createdAt: Date;
  lastActivity: Date;
  title?: string;
  imageUrl?: string;
  isFinalized: boolean;
}

// In-memory session storage
const sessions = new Map<string, Session>();

// Session expiry time (24 hours)
const SESSION_EXPIRY_MS = 24 * 60 * 60 * 1000;

// Generate a session ID
export function generateSessionId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 8; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return id;
}

// Create a new session
export function createSession(id?: string): Session {
  const sessionId = id || generateSessionId();
  
  // Check if session already exists
  if (sessions.has(sessionId)) {
    return sessions.get(sessionId)!;
  }
  
  const session: Session = {
    id: sessionId,
    elements: new Map(),
    createdAt: new Date(),
    lastActivity: new Date(),
    isFinalized: false
  };
  
  sessions.set(sessionId, session);
  logger.info(`Session created: ${sessionId}`);
  
  return session;
}

// Get a session by ID
export function getSession(id: string): Session | undefined {
  const session = sessions.get(id);
  if (session) {
    session.lastActivity = new Date();
  }
  return session;
}

// Get or create a session
export function getOrCreateSession(id: string): Session {
  return getSession(id) || createSession(id);
}

// Delete a session
export function deleteSession(id: string): boolean {
  const deleted = sessions.delete(id);
  if (deleted) {
    logger.info(`Session deleted: ${id}`);
  }
  return deleted;
}

// Get all sessions (for admin/debug purposes)
export function getAllSessions(): Session[] {
  return Array.from(sessions.values());
}

// Get session count
export function getSessionCount(): number {
  return sessions.size;
}

// Update session title
export function updateSessionTitle(id: string, title: string): boolean {
  const session = sessions.get(id);
  if (session) {
    session.title = title;
    session.lastActivity = new Date();
    return true;
  }
  return false;
}

// Mark session as finalized with image URL
export function finalizeSession(id: string, imageUrl: string): boolean {
  const session = sessions.get(id);
  if (session) {
    session.isFinalized = true;
    session.imageUrl = imageUrl;
    session.lastActivity = new Date();
    logger.info(`Session finalized: ${id}`, { imageUrl });
    return true;
  }
  return false;
}

// Clean up expired sessions
export function cleanupExpiredSessions(): number {
  const now = Date.now();
  let cleanedCount = 0;
  
  for (const [id, session] of sessions) {
    const age = now - session.lastActivity.getTime();
    if (age > SESSION_EXPIRY_MS) {
      sessions.delete(id);
      cleanedCount++;
      logger.info(`Session expired and cleaned: ${id}`);
    }
  }
  
  if (cleanedCount > 0) {
    logger.info(`Cleaned up ${cleanedCount} expired sessions`);
  }
  
  return cleanedCount;
}

// Start periodic cleanup (every hour)
export function startSessionCleanup(): NodeJS.Timeout {
  return setInterval(() => {
    cleanupExpiredSessions();
  }, 60 * 60 * 1000);
}

// Get session statistics
export function getSessionStats(): {
  totalSessions: number;
  activeSessions: number;
  finalizedSessions: number;
} {
  let activeSessions = 0;
  let finalizedSessions = 0;
  
  const now = Date.now();
  for (const session of sessions.values()) {
    const age = now - session.lastActivity.getTime();
    if (age < 30 * 60 * 1000) { // Active in last 30 minutes
      activeSessions++;
    }
    if (session.isFinalized) {
      finalizedSessions++;
    }
  }
  
  return {
    totalSessions: sessions.size,
    activeSessions,
    finalizedSessions
  };
}

export { sessions };
