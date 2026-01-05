import React, { useState, useEffect, useRef, useMemo } from 'react'
import {
  Excalidraw,
  convertToExcalidrawElements,
  CaptureUpdateAction,
  ExcalidrawImperativeAPI
} from '@excalidraw/excalidraw'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/types/element/types'
import { convertMermaidToExcalidraw, DEFAULT_MERMAID_CONFIG } from './utils/mermaidConverter'
import type { MermaidConfig } from '@excalidraw/mermaid-to-excalidraw'

// Type definitions
type ExcalidrawAPIRefValue = ExcalidrawImperativeAPI;

interface ServerElement {
  id: string;
  type: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  backgroundColor?: string;
  strokeColor?: string;
  strokeWidth?: number;
  roughness?: number;
  opacity?: number;
  text?: string;
  fontSize?: number;
  fontFamily?: string | number;
  label?: {
    text: string;
  };
  createdAt?: string;
  updatedAt?: string;
  version?: number;
  syncedAt?: string;
  source?: string;
  syncTimestamp?: string;
  boundElements?: any[] | null;
  containerId?: string | null;
  locked?: boolean;
}

interface WebSocketMessage {
  type: string;
  element?: ServerElement;
  elements?: ServerElement[];
  elementId?: string;
  count?: number;
  timestamp?: string;
  source?: string;
  mermaidDiagram?: string;
  config?: MermaidConfig;
  sessionId?: string;
  createdAt?: string;
}

interface ApiResponse {
  success: boolean;
  elements?: ServerElement[];
  element?: ServerElement;
  count?: number;
  error?: string;
  message?: string;
}

type SyncStatus = 'idle' | 'syncing' | 'success' | 'error';

// Extract session ID from URL
function getSessionIdFromUrl(): string | null {
  const pathParts = window.location.pathname.split('/');
  const canvasIndex = pathParts.indexOf('canvas');
  if (canvasIndex !== -1 && pathParts[canvasIndex + 1]) {
    return pathParts[canvasIndex + 1];
  }
  return null;
}

// Helper function to clean elements for Excalidraw
const cleanElementForExcalidraw = (element: ServerElement): Partial<ExcalidrawElement> => {
  const {
    createdAt,
    updatedAt,
    version,
    syncedAt,
    source,
    syncTimestamp,
    ...cleanElement
  } = element;
  return cleanElement;
}

// Helper function to validate and fix element binding data
const validateAndFixBindings = (elements: Partial<ExcalidrawElement>[]): Partial<ExcalidrawElement>[] => {
  const elementMap = new Map(elements.map(el => [el.id!, el]));
  
  return elements.map(element => {
    const fixedElement = { ...element };
    
    if (fixedElement.boundElements) {
      if (Array.isArray(fixedElement.boundElements)) {
        fixedElement.boundElements = fixedElement.boundElements.filter((binding: any) => {
          if (!binding || typeof binding !== 'object') return false;
          if (!binding.id || !binding.type) return false;
          const referencedElement = elementMap.get(binding.id);
          if (!referencedElement) return false;
          if (!['text', 'arrow'].includes(binding.type)) return false;
          return true;
        });
        
        if (fixedElement.boundElements.length === 0) {
          fixedElement.boundElements = null;
        }
      } else {
        fixedElement.boundElements = null;
      }
    }
    
    if (fixedElement.containerId) {
      const containerElement = elementMap.get(fixedElement.containerId);
      if (!containerElement) {
        fixedElement.containerId = null;
      }
    }
    
    return fixedElement;
  });
}

function App(): JSX.Element {
  const [excalidrawAPI, setExcalidrawAPI] = useState<ExcalidrawAPIRefValue | null>(null)
  const [isConnected, setIsConnected] = useState<boolean>(false)
  const websocketRef = useRef<WebSocket | null>(null)
  
  // Session state
  const sessionId = useMemo(() => getSessionIdFromUrl(), []);
  const [sessionCreatedAt, setSessionCreatedAt] = useState<string | null>(null);
  
  // Sync state management
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('idle')
  const [lastSyncTime, setLastSyncTime] = useState<Date | null>(null)

  // Build API URL based on session
  const getApiUrl = (path: string): string => {
    if (sessionId) {
      return `/api/sessions/${sessionId}${path}`;
    }
    return `/api${path}`;
  };

  // WebSocket connection
  useEffect(() => {
    connectWebSocket()
    return () => {
      if (websocketRef.current) {
        websocketRef.current.close()
      }
    }
  }, [sessionId])

  // Load existing elements when Excalidraw API becomes available
  useEffect(() => {
    if (excalidrawAPI) {
      loadExistingElements()
      
      if (!isConnected) {
        connectWebSocket()
      }
    }
  }, [excalidrawAPI, isConnected])

  const loadExistingElements = async (): Promise<void> => {
    try {
      const response = await fetch(getApiUrl('/elements'))
      const result: ApiResponse = await response.json()
      
      if (result.success && result.elements && result.elements.length > 0) {
        const cleanedElements = result.elements.map(cleanElementForExcalidraw)
        const convertedElements = convertToExcalidrawElements(cleanedElements, { regenerateIds: false })
        excalidrawAPI?.updateScene({ elements: convertedElements })
      }
    } catch (error) {
      console.error('Error loading existing elements:', error)
    }
  }

  const connectWebSocket = (): void => {
    if (websocketRef.current && websocketRef.current.readyState === WebSocket.OPEN) {
      return
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = sessionId 
      ? `${protocol}//${window.location.host}?sessionId=${sessionId}`
      : `${protocol}//${window.location.host}`
    
    websocketRef.current = new WebSocket(wsUrl)
    
    websocketRef.current.onopen = () => {
      setIsConnected(true)
      
      if (excalidrawAPI) {
        setTimeout(loadExistingElements, 100)
      }
    }
    
    websocketRef.current.onmessage = (event: MessageEvent) => {
      try {
        const data: WebSocketMessage = JSON.parse(event.data)
        handleWebSocketMessage(data)
      } catch (error) {
        console.error('Error parsing WebSocket message:', error, event.data)
      }
    }
    
    websocketRef.current.onclose = (event: CloseEvent) => {
      setIsConnected(false)
      
      if (event.code !== 1000) {
        setTimeout(connectWebSocket, 3000)
      }
    }
    
    websocketRef.current.onerror = (error: Event) => {
      console.error('WebSocket error:', error)
      setIsConnected(false)
    }
  }

  const handleWebSocketMessage = async (data: WebSocketMessage): Promise<void> => {
    if (!excalidrawAPI && data.type !== 'session_info') {
      return
    }

    try {
      const currentElements = excalidrawAPI?.getSceneElements() || [];

      switch (data.type) {
        case 'session_info':
          if (data.sessionId) {
            console.log(`Connected to session: ${data.sessionId}`);
            setSessionCreatedAt(data.createdAt || null);
          }
          break;
          
        case 'initial_elements':
          if (data.elements && data.elements.length > 0) {
            const cleanedElements = data.elements.map(cleanElementForExcalidraw)
            const validatedElements = validateAndFixBindings(cleanedElements)
            const convertedElements = convertToExcalidrawElements(validatedElements)
            excalidrawAPI?.updateScene({
              elements: convertedElements,
              captureUpdate: CaptureUpdateAction.NEVER
            })
          }
          break

        case 'element_created':
          if (data.element) {
            const cleanedNewElement = cleanElementForExcalidraw(data.element)
            const newElement = convertToExcalidrawElements([cleanedNewElement])
            const updatedElementsAfterCreate = [...currentElements, ...newElement]
            excalidrawAPI?.updateScene({ 
              elements: updatedElementsAfterCreate,
              captureUpdate: CaptureUpdateAction.NEVER
            })
          }
          break
          
        case 'element_updated':
          if (data.element) {
            const cleanedUpdatedElement = cleanElementForExcalidraw(data.element)
            const convertedUpdatedElement = convertToExcalidrawElements([cleanedUpdatedElement])[0]
            const updatedElements = currentElements.map(el =>
              el.id === data.element!.id ? convertedUpdatedElement : el
            )
            excalidrawAPI?.updateScene({
              elements: updatedElements,
              captureUpdate: CaptureUpdateAction.NEVER
            })
          }
          break

        case 'element_deleted':
          if (data.elementId) {
            const filteredElements = currentElements.filter(el => el.id !== data.elementId)
            excalidrawAPI?.updateScene({
              elements: filteredElements,
              captureUpdate: CaptureUpdateAction.NEVER
            })
          }
          break

        case 'elements_batch_created':
          if (data.elements) {
            const cleanedBatchElements = data.elements.map(cleanElementForExcalidraw)
            const batchElements = convertToExcalidrawElements(cleanedBatchElements)
            const updatedElementsAfterBatch = [...currentElements, ...batchElements]
            excalidrawAPI?.updateScene({ 
              elements: updatedElementsAfterBatch,
              captureUpdate: CaptureUpdateAction.NEVER
            })
          }
          break
          
        case 'elements_synced':
          console.log(`Sync confirmed by server: ${data.count} elements`)
          break
          
        case 'sync_status':
          console.log(`Server sync status: ${data.count} elements`)
          break
          
        case 'mermaid_convert':
          console.log('Received Mermaid conversion request from MCP')
          if (data.mermaidDiagram) {
            try {
              const result = await convertMermaidToExcalidraw(data.mermaidDiagram, data.config || DEFAULT_MERMAID_CONFIG)

              if (result.error) {
                console.error('Mermaid conversion error:', result.error)
                return
              }

              if (result.elements && result.elements.length > 0) {
                const convertedElements = convertToExcalidrawElements(result.elements, { regenerateIds: false })
                excalidrawAPI?.updateScene({
                  elements: convertedElements,
                  captureUpdate: CaptureUpdateAction.IMMEDIATELY
                })

                if (result.files) {
                  excalidrawAPI?.addFiles(Object.values(result.files))
                }

                console.log('Mermaid diagram converted successfully:', result.elements.length, 'elements')
                await syncToBackend()
              }
            } catch (error) {
              console.error('Error converting Mermaid diagram from WebSocket:', error)
            }
          }
          break
          
        default:
          console.log('Unknown WebSocket message type:', data.type)
      }
    } catch (error) {
      console.error('Error processing WebSocket message:', error, data)
    }
  }

  const convertToBackendFormat = (element: ExcalidrawElement): ServerElement => {
    return {
      ...element
    } as ServerElement
  }

  const formatSyncTime = (time: Date | null): string => {
    if (!time) return ''
    return time.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
  }

  const syncToBackend = async (): Promise<void> => {
    if (!excalidrawAPI) {
      console.warn('Excalidraw API not available')
      return
    }
    
    setSyncStatus('syncing')
    
    try {
      const currentElements = excalidrawAPI.getSceneElements()
      console.log(`Syncing ${currentElements.length} elements to backend`)
      
      const activeElements = currentElements.filter(el => !el.isDeleted)
      const backendElements = activeElements.map(convertToBackendFormat)
      
      const response = await fetch(getApiUrl('/elements/sync'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          elements: backendElements,
          timestamp: new Date().toISOString()
        })
      })
      
      if (response.ok) {
        const result: ApiResponse = await response.json()
        setSyncStatus('success')
        setLastSyncTime(new Date())
        console.log(`Sync successful: ${result.count} elements synced`)
        
        setTimeout(() => setSyncStatus('idle'), 2000)
      } else {
        const error: ApiResponse = await response.json()
        setSyncStatus('error')
        console.error('Sync failed:', error.error)
      }
    } catch (error) {
      setSyncStatus('error')
      console.error('Sync error:', error)
    }
  }

  const clearCanvas = async (): Promise<void> => {
    if (excalidrawAPI) {
      try {
        const response = await fetch(getApiUrl('/elements'))
        const result: ApiResponse = await response.json()
        
        if (result.success && result.elements) {
          const deletePromises = result.elements.map(element => 
            fetch(getApiUrl(`/elements/${element.id}`), { method: 'DELETE' })
          )
          await Promise.all(deletePromises)
        }
        
        excalidrawAPI.updateScene({ 
          elements: [],
          captureUpdate: CaptureUpdateAction.IMMEDIATELY
        })
      } catch (error) {
        console.error('Error clearing canvas:', error)
        excalidrawAPI.updateScene({ 
          elements: [],
          captureUpdate: CaptureUpdateAction.IMMEDIATELY
        })
      }
    }
  }

  const copyShareLink = (): void => {
    const shareUrl = window.location.href;
    navigator.clipboard.writeText(shareUrl).then(() => {
      alert('Share link copied to clipboard!');
    }).catch(err => {
      console.error('Failed to copy link:', err);
    });
  }

  return (
    <div className="app">
      {/* Header */}
      <div className="header">
        <h1>Excalidraw Canvas</h1>
        <div className="controls">
          {/* Session Info */}
          {sessionId && (
            <div className="session-info">
              <span className="session-badge">Session: {sessionId}</span>
              <button className="btn-copy" onClick={copyShareLink} title="Copy share link">
                📋 Share
              </button>
            </div>
          )}
          
          <div className="status">
            <div className={`status-dot ${isConnected ? 'status-connected' : 'status-disconnected'}`}></div>
            <span>{isConnected ? 'Connected' : 'Disconnected'}</span>
          </div>
          
          {/* Sync Controls */}
          <div className="sync-controls">
            <button 
              className={`btn-primary ${syncStatus === 'syncing' ? 'btn-loading' : ''}`}
              onClick={syncToBackend}
              disabled={syncStatus === 'syncing' || !excalidrawAPI}
            >
              {syncStatus === 'syncing' && <span className="spinner"></span>}
              {syncStatus === 'syncing' ? 'Syncing...' : 'Sync'}
            </button>
            
            {/* Sync Status */}
            <div className="sync-status">
              {syncStatus === 'success' && (
                <span className="sync-success">✅</span>
              )}
              {syncStatus === 'error' && (
                <span className="sync-error">❌</span>
              )}
              {lastSyncTime && syncStatus === 'idle' && (
                <span className="sync-time">
                  {formatSyncTime(lastSyncTime)}
                </span>
              )}
            </div>
          </div>
          
          <button className="btn-secondary" onClick={clearCanvas}>Clear</button>
        </div>
      </div>

      {/* Canvas Container */}
      <div className="canvas-container">
        <Excalidraw
          excalidrawAPI={(api: ExcalidrawAPIRefValue) => setExcalidrawAPI(api)}
          initialData={{
            elements: [],
            appState: {
              theme: 'light',
              viewBackgroundColor: '#ffffff'
            }
          }}
        />
      </div>
    </div>
  )
}

export default App
