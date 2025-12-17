import { spawn, spawnSync } from 'child_process';
import { existsSync } from 'fs';

/**
 * Manages browser detection and installation for Playwright.
 * Uses singleton pattern to encapsulate state that was previously global.
 * Single responsibility: Browser availability management.
 */
export class BrowserManager {
  private static instance: BrowserManager | null = null;
  
  private browsersEnsured = false;
  private chromiumPath: string | null = null;

  private constructor() {
    // Private constructor for singleton
  }

  /**
   * Get the singleton instance of BrowserManager.
   */
  static getInstance(): BrowserManager {
    if (!BrowserManager.instance) {
      BrowserManager.instance = new BrowserManager();
    }
    return BrowserManager.instance;
  }

  /**
   * Reset the singleton instance (useful for testing).
   */
  static resetInstance(): void {
    BrowserManager.instance = null;
  }

  /**
   * Get the path to the Chromium executable (if found/set).
   */
  getChromiumPath(): string | null {
    return this.chromiumPath;
  }

  /**
   * Find system-installed Chromium/Chrome browser.
   * Returns the path if found, null otherwise.
   */
  private findSystemChromium(): string | null {
    const platform = process.platform;
    
    const candidates: string[] = [];
    
    if (platform === 'win32') {
      // Windows paths
      candidates.push(
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
        'C:\\Program Files\\Chromium\\Application\\chrome.exe',
        `${process.env.LOCALAPPDATA}\\Chromium\\Application\\chrome.exe`,
      );
    } else if (platform === 'darwin') {
      // macOS paths
      candidates.push(
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        `${process.env.HOME}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
        `${process.env.HOME}/Applications/Chromium.app/Contents/MacOS/Chromium`,
      );
    } else {
      // Linux paths
      candidates.push(
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/snap/bin/chromium',
        '/var/lib/flatpak/exports/bin/com.github.nickvergessen.chromium',
      );
      
      // Also try 'which' command on Linux/macOS
      try {
        const result = spawnSync('which', ['chromium'], { encoding: 'utf-8' });
        if (result.status === 0 && result.stdout.trim()) {
          candidates.unshift(result.stdout.trim());
        }
      } catch {
        // Ignore errors from which command
      }
      
      try {
        const result = spawnSync('which', ['chromium-browser'], { encoding: 'utf-8' });
        if (result.status === 0 && result.stdout.trim()) {
          candidates.unshift(result.stdout.trim());
        }
      } catch {
        // Ignore errors from which command
      }
      
      try {
        const result = spawnSync('which', ['google-chrome'], { encoding: 'utf-8' });
        if (result.status === 0 && result.stdout.trim()) {
          candidates.unshift(result.stdout.trim());
        }
      } catch {
        // Ignore errors from which command
      }
    }
    
    for (const candidate of candidates) {
      if (candidate && existsSync(candidate)) {
        return candidate;
      }
    }
    
    return null;
  }

  /**
   * Ensure Playwright browsers are available.
   * First tries to find system Chromium, then falls back to installing Playwright's bundled browser.
   * Works across Windows, macOS, and Linux.
   */
  async ensureBrowsers(): Promise<void> {
    if (this.browsersEnsured) {
      return;
    }

    // First, check for system Chromium
    console.log('  [Playwright] Checking for browser...');
    this.chromiumPath = this.findSystemChromium();
    
    if (this.chromiumPath) {
      console.log(`  [Playwright] Found system browser: ${this.chromiumPath}`);
      this.browsersEnsured = true;
      return;
    }
    
    // No system browser found, install Playwright's bundled one
    console.log('  [Playwright] No system browser found, installing Chromium...');
    
    const isWindows = process.platform === 'win32';
    
    return new Promise((resolve) => {
      const proc = spawn(
        isWindows ? 'cmd.exe' : 'npx',
        isWindows 
          ? ['/c', 'npx', 'playwright', 'install', 'chromium']
          : ['playwright', 'install', 'chromium'],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: false,
        }
      );

      let stdout = '';
      let stderr = '';

      proc.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0) {
          this.browsersEnsured = true;
          if (stdout.includes('Downloading') || stdout.includes('Installing')) {
            console.log('  [Playwright] Browser installed successfully');
          } else {
            console.log('  [Playwright] Browser ready');
          }
          resolve();
        } else {
          console.warn(`  [Playwright] Browser install returned code ${code}`);
          if (stderr) {
            console.warn(`  [Playwright] ${stderr.slice(0, 200)}`);
          }
          this.browsersEnsured = true;
          resolve();
        }
      });

      proc.on('error', (err) => {
        console.warn(`  [Playwright] Could not run browser install: ${err.message}`);
        this.browsersEnsured = true;
        resolve();
      });
    });
  }
}
