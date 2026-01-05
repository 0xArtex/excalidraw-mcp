import puppeteer, { Browser } from 'puppeteer';
import logger from './utils/logger.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Directory to store exported images
const EXPORTS_DIR = process.env.EXPORTS_DIR || path.join(__dirname, '../exports');

// Base URL for the canvas server
const CANVAS_BASE_URL = process.env.CANVAS_BASE_URL || 'http://localhost:3000';

// Public URL for serving images (TO-DO: change to CDN URL in production)
const PUBLIC_URL = process.env.PUBLIC_URL || CANVAS_BASE_URL;

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
        '--disable-software-rasterizer'
      ]
    };
    
    // Use custom Chrome path if provided (for Docker)
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
      launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    }
    
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
    
    const canvasUrl = `${CANVAS_BASE_URL}/canvas/${sessionId}`;
    logger.info(`Navigating to canvas: ${canvasUrl}`);
    
    await page.goto(canvasUrl, {
      waitUntil: 'networkidle0',
      timeout: 30000
    });
    
    // Wait for Excalidraw to load
    await page.waitForSelector('.excalidraw', { timeout: 10000 });
    
    // Wait a bit more for elements to render
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Find the canvas element and take a screenshot of just the drawing area
    const excalidrawElement = await page.$('.excalidraw');
    
    if (!excalidrawElement) {
      throw new Error('Excalidraw canvas not found');
    }
    
    // Generate filename
    const timestamp = Date.now();
    const filename = `${sessionId}-${timestamp}.png`;
    const imagePath = path.join(EXPORTS_DIR, filename);
    
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
