import puppeteer from 'puppeteer-core';
import type { Browser } from 'puppeteer-core';
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import logger from './utils/logger.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Find Chrome binary in common locations
function findChrome(): string {
  const candidates = [
    // Debian/Ubuntu system Chromium (container-patched, preferred in Docker)
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    // Google Chrome system installations
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    // Puppeteer cache (local dev)
    ...(() => {
      try {
        const home = process.env.HOME || '/root';
        const glob = execSync(`ls ${home}/.cache/puppeteer/chrome/*/chrome-linux64/chrome 2>/dev/null`, { encoding: 'utf8' }).trim().split('\n');
        return glob.filter(Boolean);
      } catch { return []; }
    })(),
  ];
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  throw new Error('Chrome/Chromium not found. Set PUPPETEER_EXECUTABLE_PATH env var.');
}

// Directory to store exported images
const EXPORTS_DIR = process.env.EXPORTS_DIR || path.join(__dirname, '../exports');

// Base URL for the canvas server (internal, for Puppeteer to navigate)
const CANVAS_BASE_URL = process.env.CANVAS_BASE_URL || 'http://localhost:3000';

// Public URL for serving images and edit links
const PUBLIC_URL = process.env.PUBLIC_URL || CANVAS_BASE_URL;

// Resolved internal URL for Puppeteer (determined at first render)
let resolvedCanvasBaseUrl: string | null = null;

// Check if a URL is reachable
async function isReachable(url: string, timeoutMs = 3000): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

// Resolve the best internal URL for Puppeteer to reach our server
async function getCanvasBaseUrl(): Promise<string> {
  if (resolvedCanvasBaseUrl) return resolvedCanvasBaseUrl;

  // Try CANVAS_BASE_URL first (usually localhost)
  if (await isReachable(`${CANVAS_BASE_URL}/health`)) {
    resolvedCanvasBaseUrl = CANVAS_BASE_URL;
    logger.info(`Canvas base URL resolved: ${resolvedCanvasBaseUrl}`);
    return resolvedCanvasBaseUrl;
  }

  // Try common localhost variants
  const port = process.env.PORT || '3000';
  const candidates = [
    `http://127.0.0.1:${port}`,
    `http://0.0.0.0:${port}`,
    `http://localhost:${port}`,
  ];
  for (const candidate of candidates) {
    if (candidate !== CANVAS_BASE_URL && await isReachable(`${candidate}/health`)) {
      resolvedCanvasBaseUrl = candidate;
      logger.info(`Canvas base URL resolved (fallback): ${resolvedCanvasBaseUrl}`);
      return resolvedCanvasBaseUrl;
    }
  }

  // Last resort: use PUBLIC_URL (works in Railway where localhost may not)
  if (PUBLIC_URL !== CANVAS_BASE_URL) {
    resolvedCanvasBaseUrl = PUBLIC_URL;
    logger.info(`Canvas base URL resolved (public fallback): ${resolvedCanvasBaseUrl}`);
    return resolvedCanvasBaseUrl;
  }

  // Give up, use default
  resolvedCanvasBaseUrl = CANVAS_BASE_URL;
  logger.warn(`Canvas base URL unresolved, using default: ${resolvedCanvasBaseUrl}`);
  return resolvedCanvasBaseUrl;
}

let browser: Browser | null = null;

// Initialize Puppeteer browser
async function getBrowser(): Promise<Browser> {
  if (!browser || !browser.connected) {
    logger.info('Launching Puppeteer browser...');
    
    const launchOptions: Parameters<typeof puppeteer.launch>[0] = {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--disable-crashpad',
        '--no-default-browser-check',
        '--no-first-run',
        '--disable-extensions',
        '--disable-default-apps'
      ]
    };
    
    // Resolve Chrome/Chromium executable path
    const execPath = process.env.PUPPETEER_EXECUTABLE_PATH 
      || process.env.CHROME_PATH
      || findChrome();
    launchOptions.executablePath = execPath;
    logger.info(`Using Chrome at: ${execPath}`);
    
    browser = await puppeteer.launch(launchOptions);
    logger.info('Puppeteer browser launched');
  }
  return browser;
}

// Ensure exports directory exists
async function ensureExportsDir(): Promise<void> {
  try {
    await fs.mkdir(EXPORTS_DIR, { recursive: true });
  } catch (error) {
    // Directory may already exist
  }
}

// Export a session's canvas to an image
export async function exportSessionToImage(sessionId: string): Promise<{
  success: boolean;
  imagePath?: string;
  imageUrl?: string;
  error?: string;
}> {
  try {
    await ensureExportsDir();
    
    const browser = await getBrowser();
    const page = await browser.newPage();
    
    // Set viewport size
    await page.setViewport({
      width: 1920,
      height: 1080,
      deviceScaleFactor: 2 // For higher quality
    });
    
    const baseUrl = await getCanvasBaseUrl();
    const canvasUrl = `${baseUrl}/canvas/${sessionId}`;
    logger.info(`Navigating to canvas: ${canvasUrl}`);
    
    await page.goto(canvasUrl, {
      waitUntil: 'networkidle0',
      timeout: 30000
    });
    
    // Wait for Excalidraw to load
    await page.waitForSelector('.excalidraw', { timeout: 10000 });
    
    // Generate filename early so export path can use it
    const timestamp = Date.now();
    const filename = `${sessionId}-${timestamp}.png`;
    const imagePath = path.join(EXPORTS_DIR, filename);
    
    // Wait for Excalidraw to signal it's ready (set by App.tsx after scrollToContent)
    try {
      await page.waitForFunction(() => (window as any).__EXCALIDRAW_READY__ === true, { timeout: 8000 });
      logger.info('Excalidraw signaled ready');
    } catch {
      logger.warn('Excalidraw ready signal timeout, proceeding anyway');
    }
    
    // Extra wait for rendering to settle
    await new Promise(resolve => setTimeout(resolve, 500));

    // Use Excalidraw's standalone exportToBlob for pixel-perfect rendering
    // This handles text centering, binding, and all layout correctly
    // The standalone function is exposed on window.__EXCALIDRAW_EXPORT_TO_BLOB__
    // and doesn't require the imperative API
    const exportedPng = await page.evaluate(async () => {
      const exportToBlob = (window as any).__EXCALIDRAW_EXPORT_TO_BLOB__;
      if (!exportToBlob) {
        console.warn('exportToBlob not found on window');
        return null;
      }
      
      // Get elements from the Excalidraw API if available, or from the DOM
      let elements: any[] = [];
      let appState: any = {};
      
      const api = (window as any).__EXCALIDRAW_API__;
      if (api && api.getSceneElements) {
        elements = api.getSceneElements();
        appState = api.getAppState();
      } else {
        // Try to get elements from React fiber as last resort
        const excalidrawEl = document.querySelector('.excalidraw');
        if (excalidrawEl) {
          const fiberKey = Object.keys(excalidrawEl).find(k => k.startsWith('__reactFiber'));
          if (fiberKey) {
            let fiber = (excalidrawEl as any)[fiberKey];
            for (let i = 0; i < 80 && fiber; i++) {
              // Look for memoizedState that has elements array
              let state = fiber.memoizedState;
              while (state) {
                if (state.queue?.lastRenderedState?.getSceneElements) {
                  const stateApi = state.queue.lastRenderedState;
                  elements = stateApi.getSceneElements();
                  appState = stateApi.getAppState();
                  break;
                }
                state = state.next;
              }
              if (elements.length > 0) break;
              fiber = fiber.return;
            }
          }
        }
      }
      
      if (!elements || elements.length === 0) {
        console.warn('No elements found for export');
        return null;
      }
      
      try {
        const blob = await exportToBlob({
          elements,
          appState: {
            ...appState,
            exportBackground: true,
            viewBackgroundColor: appState.viewBackgroundColor || '#ffffff',
          },
          files: null,
          mimeType: 'image/png',
          quality: 1,
        });
        
        if (blob) {
          const reader = new FileReader();
          return new Promise<string>((resolve) => {
            reader.onloadend = () => resolve(reader.result as string);
            reader.readAsDataURL(blob);
          });
        }
      } catch (e) {
        console.error('exportToBlob failed:', e);
      }
      return null;
    });
    
    if (exportedPng) {
      logger.info('Using Excalidraw native exportToBlob for pixel-perfect rendering');
      // Use Excalidraw's native export - decode base64 data URL
      const base64Data = exportedPng.split(',')[1] || '';
      const pngBuffer = Buffer.from(base64Data, 'base64');
      await fs.writeFile(imagePath, pngBuffer);
      await page.close();
      
      return {
        success: true,
        imagePath,
        imageUrl: `/exports/${filename}`
      };
    }
    
    logger.warn('exportToBlob failed or unavailable, falling back to screenshot');
    // Fallback: screenshot approach (text may not be perfectly centered)
    
    // Find the canvas element and take a screenshot of just the drawing area
    const excalidrawElement = await page.$('.excalidraw');
    
    if (!excalidrawElement) {
      throw new Error('Excalidraw canvas not found');
    }
    
    // imagePath and filename already declared above
    
    // Take screenshot
    await excalidrawElement.screenshot({
      path: imagePath,
      type: 'png'
    });
    
    await page.close();
    
    const imageUrl = `${PUBLIC_URL}/exports/${filename}`;
    
    logger.info(`Image exported successfully`, { sessionId, imagePath, imageUrl });
    
    return {
      success: true,
      imagePath,
      imageUrl
    };
    
  } catch (error) {
    logger.error('Error exporting image:', error);
    return {
      success: false,
      error: (error as Error).message
    };
  }
}

// Close browser on shutdown
export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close();
    browser = null;
    logger.info('Puppeteer browser closed');
  }
}

// Clean up old exports (older than 24 hours)
export async function cleanupOldExports(): Promise<number> {
  try {
    await ensureExportsDir();
    const files = await fs.readdir(EXPORTS_DIR);
    const now = Date.now();
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours
    
    let cleanedCount = 0;
    
    for (const file of files) {
      const filePath = path.join(EXPORTS_DIR, file);
      const stats = await fs.stat(filePath);
      const age = now - stats.mtimeMs;
      
      if (age > maxAge) {
        await fs.unlink(filePath);
        cleanedCount++;
      }
    }
    
    if (cleanedCount > 0) {
      logger.info(`Cleaned up ${cleanedCount} old export files`);
    }
    
    return cleanedCount;
  } catch (error) {
    logger.error('Error cleaning up exports:', error);
    return 0;
  }
}

// Start periodic cleanup
export function startExportCleanup(): NodeJS.Timeout {
  return setInterval(() => {
    cleanupOldExports();
  }, 60 * 60 * 1000); // Every hour
}
