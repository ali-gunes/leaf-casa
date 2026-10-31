import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import {
  SessionStore,
  detectDevice,
  normalizeKey,
  sanitizeFilename,
  validateBookBuffer,
  type BookFormat,
  type Session,
} from './sessionStore.ts';
import { AnalyticsStore, extractClientAddress, countryToFlag } from './analytics.ts';
import { fetchAndBuildArticleEpub } from './articleToEpub.ts';
import { convertEpubBufferToMobi } from './epubToMobi.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface AppConfig {
  appName: string;
  baseUrl: string;
  githubUrl: string;
  port: number;
  host: string;
  maxFileSizeMb: number;
  statsUser: string;
  statsPassword: string;
  dbPath?: string;
}

export function loadConfig(overrides?: Partial<AppConfig>): AppConfig {
  return {
    appName: process.env.PUBLIC_APP_NAME || 'Leaf Casa',
    baseUrl: (process.env.PUBLIC_BASE_URL || 'https://leaf.casa').replace(/\/+$/, ''),
    githubUrl: process.env.PUBLIC_GITHUB_URL || 'https://github.com/ali-gunes/leaf-casa',
    port: Number(process.env.PORT || 3000),
    host: process.env.HOST || '0.0.0.0',
    maxFileSizeMb: Number(process.env.MAX_FILE_SIZE_MB || 100),
    statsUser: process.env.STATS_USER || 'admin',
    statsPassword: process.env.STATS_PASSWORD || '',
    dbPath: process.env.DB_PATH,
    ...overrides,
  };
}

export async function generateQrSvg(url: string): Promise<string> {
  return QRCode.toString(url, {
    type: 'svg',
    margin: 1,
    errorCorrectionLevel: 'M',
    color: {
      dark: '#000000',
      light: '#FFFFFF',
    },
  });
}

function resolveAssetPath(relativeFromRoot: string): string {
  const candidates = [
    path.resolve(process.cwd(), relativeFromRoot),
    path.resolve(__dirname, '..', '..', relativeFromRoot),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[0];
}

function safeCompare(a: string, b: string): boolean {
  const hashA = crypto.createHash('sha256').update(a).digest();
  const hashB = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

class SlidingWindowRateLimiter {
  private buckets = new Map<string, { count: number; resetAt: number }>();

  constructor() {
    const timer = setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of this.buckets.entries()) {
        if (entry.resetAt <= now) this.buckets.delete(key);
      }
    }, 60_000);
    timer.unref();
  }

  allow(bucketKey: string, maxRequests: number, windowMs: number): boolean {
    const now = Date.now();
    const existing = this.buckets.get(bucketKey);
    if (!existing || existing.resetAt <= now) {
      this.buckets.set(bucketKey, { count: 1, resetAt: now + windowMs });
      return true;
    }
    if (existing.count >= maxRequests) {
      return false;
    }
    existing.count++;
    return true;
  }
}

export function createLeafServer(customConfig?: Partial<AppConfig>) {
  const config = loadConfig(customConfig);
  const sessions = new SessionStore();
  const analytics = new AnalyticsStore(config.dbPath);
  const qrCache = new Map<string, string>();
  const rateLimiter = new SlidingWindowRateLimiter();

  async function getQrForSessionKey(key: string): Promise<string> {
    const cached = qrCache.get(key);
    if (cached) return cached;
    const targetUrl = `${config.baseUrl}/?key=${encodeURIComponent(key)}`;
    const svg = await generateQrSvg(targetUrl);
    if (qrCache.size > 500) {
      qrCache.clear();
    }
    qrCache.set(key, svg);
    return svg;
  }

  async function formatSessionResponse(session: Session) {
    const qrSvg = await getQrForSessionKey(session.key);
    return {
      ...sessions.serializeSession(session),
      qrSvg,
    };
  }

  function checkStatsAuth(req: IncomingMessage, url: URL): boolean {
    if (!config.statsPassword) return true;

    const queryToken = url.searchParams.get('key') || url.searchParams.get('password');
    if (queryToken && safeCompare(queryToken, config.statsPassword)) {
      return true;
    }

    const authHeader = req.headers.authorization || '';
    if (!authHeader.startsWith('Basic ')) return false;

    const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
    const sepIndex = decoded.indexOf(':');
    if (sepIndex === -1) return false;

    const user = decoded.slice(0, sepIndex);
    const pass = decoded.slice(sepIndex + 1);
    return safeCompare(user, config.statsUser) && safeCompare(pass, config.statsPassword);
  }

  const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const rawMethod = req.method || 'GET';
      const method = rawMethod === 'HEAD' ? 'GET' : rawMethod;
      const hostHeader = req.headers.host || 'localhost';
      const url = new URL(req.url || '/', `http://${hostHeader}`);
      const pathname = url.pathname;

      // Healthcheck
      if (pathname === '/healthz') {
        return sendJson(res, 200, {
          ok: true,
          ...sessions.getActiveStats(),
          rssMb: Math.round((process.memoryUsage().rss / (1024 * 1024)) * 10) / 10,
        });
      }

      // Static Assets
      if (method === 'GET' && pathname === '/assets/editorial.css') {
        return serveStaticFile(res, resolveAssetPath('src/client/styles/editorial.css'), 'text/css; charset=utf-8');
      }
      if (method === 'GET' && pathname === '/assets/eink.css') {
        return serveStaticFile(res, resolveAssetPath('src/client/styles/eink.css'), 'text/css; charset=utf-8');
      }
      if (method === 'GET' && pathname === '/assets/ereader.js') {
        return serveStaticFile(res, resolveAssetPath('src/client/receiver/ereader.js'), 'application/javascript; charset=utf-8');
      }
      if (method === 'GET' && pathname === '/assets/sender.js') {
        return serveStaticFile(res, resolveAssetPath('dist/client/sender.js'), 'application/javascript; charset=utf-8');
      }
      if (method === 'GET' && pathname === '/assets/logo.png') {
        return serveStaticFile(res, resolveAssetPath('src/client/assets/logo.png'), 'image/png');
      }
      if (method === 'GET' && (pathname === '/favicon.png' || pathname === '/favicon.ico')) {
        return serveStaticFile(res, resolveAssetPath('src/client/assets/favicon.png'), 'image/png');
      }

      // API: Generate or refresh session key
      if ((method === 'POST' || method === 'GET') && pathname === '/api/generate') {
        const clientAddr = extractClientAddress(req);
        if (!rateLimiter.allow(`gen:${clientAddr.rawIp}`, 25, 60_000)) {
          return sendJson(res, 429, { error: 'Too many session requests. Please wait a moment.' });
        }
        const device = detectDevice(req.headers['user-agent']);
        const preferredKey = url.searchParams.get('key') || undefined;
        const session = sessions.createSession({
          receiverIp: clientAddr.storedIp,
          receiverCountry: clientAddr.country,
          device,
          preferredKey,
        });
        const payload = await formatSessionResponse(session);
        return sendJson(res, 200, payload);
      }

      // API: Get session status
      if (method === 'GET' && pathname.startsWith('/api/status/')) {
        const clientAddr = extractClientAddress(req);
        if (!rateLimiter.allow(`status:${clientAddr.rawIp}`, 90, 60_000)) {
          return sendJson(res, 429, { error: 'Too many status requests. Please slow down.' });
        }
        const key = normalizeKey(decodeURIComponent(pathname.slice('/api/status/'.length)));
        const session = sessions.getSession(key, true);
        if (!session) {
          return sendJson(res, 404, { error: 'Session not found or expired' });
        }
        const payload = await formatSessionResponse(session);
        return sendJson(res, 200, payload);
      }

      // API: Server-Sent Events stream
      if (method === 'GET' && pathname.startsWith('/api/stream/')) {
        const key = normalizeKey(decodeURIComponent(pathname.slice('/api/stream/'.length)));
        const session = sessions.getSession(key, true);
        if (!session) {
          return sendJson(res, 404, { error: 'Session not found or expired' });
        }

        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });

        const initialPayload = await formatSessionResponse(session);
        res.write(`data: ${JSON.stringify(initialPayload)}\n\n`);

        const unsubscribe = sessions.subscribe(key, async (_event, _data) => {
          const updated = sessions.getSession(key, false);
          if (!updated) return;
          const formatted = await formatSessionResponse(updated);
          res.write(`data: ${JSON.stringify(formatted)}\n\n`);
        });

        const heartbeat = setInterval(() => {
          res.write(': heartbeat\n\n');
        }, 20_000);
        heartbeat.unref();

        req.on('close', () => {
          clearInterval(heartbeat);
          if (unsubscribe) unsubscribe();
        });
        return;
      }

      // API: Override device preference (KePub toggle)
      if (method === 'POST' && pathname.startsWith('/api/device/')) {
        const key = normalizeKey(decodeURIComponent(pathname.slice('/api/device/'.length)));
        const bodyBuf = await readBodyBuffer(req, 16 * 1024);
        const body = JSON.parse(bodyBuf.toString('utf8') || '{}');
        const updated = sessions.overrideDevicePreference(key, Boolean(body.prefersKepub));
        if (!updated) {
          return sendJson(res, 404, { error: 'Session not found or expired' });
        }
        return sendJson(res, 200, await formatSessionResponse(updated));
      }

      // API: Upload book buffer to session
      if (method === 'POST' && pathname.startsWith('/api/upload/')) {
        const senderAddr = extractClientAddress(req);
        if (!rateLimiter.allow(`upload:${senderAddr.rawIp}`, 25, 60_000)) {
          return sendJson(res, 429, { error: 'Upload rate limit exceeded. Please wait a minute.' });
        }

        const key = normalizeKey(decodeURIComponent(pathname.slice('/api/upload/'.length)));
        const session = sessions.getSession(key, true);
        if (!session) {
          return sendJson(res, 404, { error: 'Session not found or expired' });
        }

        const maxBytes = config.maxFileSizeMb * 1024 * 1024;
        const declaredLength = Number(req.headers['content-length'] || 0);
        if (declaredLength > maxBytes) {
          return sendJson(res, 413, {
            error: `Payload exceeds maximum size of ${config.maxFileSizeMb} MB`,
          });
        }

        const fileBuffer = await readBodyBuffer(req, maxBytes);
        if (fileBuffer.byteLength === 0) {
          return sendJson(res, 400, { error: 'Uploaded file is empty' });
        }

        const rawName = safeDecodeURIComponent(String(req.headers['x-file-name'] || 'book.epub'));
        let filename = sanitizeFilename(rawName);
        const lowerName = filename.toLowerCase();
        const rawFormat = String(req.headers['x-book-format'] || '').toLowerCase();
        let format: Exclude<BookFormat, 'article'> =
          rawFormat === '.kepub.epub' || lowerName.endsWith('.kepub.epub')
            ? '.kepub.epub'
            : rawFormat === '.pdf' || lowerName.endsWith('.pdf')
              ? '.pdf'
              : rawFormat === '.mobi' || lowerName.endsWith('.mobi')
                ? '.mobi'
                : rawFormat === '.azw' || lowerName.endsWith('.azw')
                  ? '.azw'
                  : rawFormat === '.prc' || lowerName.endsWith('.prc')
                    ? '.prc'
                    : rawFormat === '.txt' || lowerName.endsWith('.txt')
                      ? '.txt'
                      : '.epub';

        // Inspect real binary magic bytes and EPUB structure to block disguised files (e.g., renamed .mp4/.exe)
        const validation = validateBookBuffer(fileBuffer, format);
        if (!validation.valid) {
          return sendJson(res, 415, { error: validation.reason || 'Unsupported or corrupted file format.' });
        }

        let finalBuffer = fileBuffer;
        let title = req.headers['x-book-title']
          ? safeDecodeURIComponent(String(req.headers['x-book-title'])).slice(0, 200)
          : undefined;
        let author = req.headers['x-book-author']
          ? safeDecodeURIComponent(String(req.headers['x-book-author'])).slice(0, 200)
          : undefined;

        // Kindle Experimental Web Browser only allows .AZW, .PRC, .MOBI, or .TXT downloads
        if (session.device.kind === 'kindle') {
          if (format === '.pdf') {
            return sendJson(res, 415, {
              error:
                "Kindle's Experimental Web Browser blocks .PDF downloads (Amazon only allows .MOBI, .AZW, .PRC, or .TXT in the built-in browser). Please upload an .EPUB, .MOBI, or .TXT file instead.",
            });
          }
          if (format === '.epub' || format === '.kepub.epub') {
            const mobi = convertEpubBufferToMobi(fileBuffer, filename);
            finalBuffer = mobi.buffer;
            filename = sanitizeFilename(mobi.filename);
            format = '.mobi';
            title = title || mobi.title;
            author = author || mobi.author;
          }
        }

        const mimeType =
          format === '.pdf'
            ? 'application/pdf'
            : format === '.mobi' || format === '.prc'
              ? 'application/x-mobipocket-ebook'
              : format === '.azw'
                ? 'application/vnd.amazon.ebook'
                : format === '.txt'
                  ? 'text/plain; charset=utf-8'
                  : 'application/epub+zip';

        const transferId = analytics.logTransfer({
          sessionKey: session.key,
          senderIp: senderAddr.storedIp,
          senderCountry: senderAddr.country,
          receiverIp: session.receiverIp,
          receiverCountry: session.receiverCountry,
          deviceType: session.device.kind,
          format,
          sizeBytes: finalBuffer.byteLength,
        });

        const queued = sessions.addFile(session.key, {
          filename,
          title,
          author,
          mimeType,
          format,
          buffer: finalBuffer,
          transferId,
        });

        return sendJson(res, 200, {
          ok: true,
          file: {
            id: queued.id,
            filename: queued.filename,
            format: queued.format,
            size: queued.size,
          },
        });
      }

      // API: Convert Web Article URL -> EPUB/KePub and add to session queue
      if (method === 'POST' && pathname.startsWith('/api/article/')) {
        const senderAddr = extractClientAddress(req);
        if (!rateLimiter.allow(`article:${senderAddr.rawIp}`, 15, 60_000)) {
          return sendJson(res, 429, { error: 'Article conversion rate limit exceeded. Please wait a minute.' });
        }

        const key = normalizeKey(decodeURIComponent(pathname.slice('/api/article/'.length)));
        const session = sessions.getSession(key, true);
        if (!session) {
          return sendJson(res, 404, { error: 'Session not found or expired' });
        }

        const bodyBuf = await readBodyBuffer(req, 64 * 1024);
        const body = JSON.parse(bodyBuf.toString('utf8') || '{}');
        const articleUrl = String(body.url || '').trim();
        const isKindleSession = session.device.kind === 'kindle';
        const asKepub = isKindleSession
          ? false
          : body.asKepub !== undefined
            ? Boolean(body.asKepub)
            : session.device.prefersKepub;

        if (!articleUrl) {
          return sendJson(res, 400, { error: 'Article URL is required' });
        }

        const built = await fetchAndBuildArticleEpub(articleUrl, { asKepub });
        let articleBuffer = built.buffer;
        let articleFilename = built.filename;
        let articleMime = 'application/epub+zip';

        if (isKindleSession) {
          const mobi = convertEpubBufferToMobi(built.buffer, built.filename);
          articleBuffer = mobi.buffer;
          articleFilename = sanitizeFilename(mobi.filename);
          articleMime = 'application/x-mobipocket-ebook';
        }

        const transferId = analytics.logTransfer({
          sessionKey: session.key,
          senderIp: senderAddr.storedIp,
          senderCountry: senderAddr.country,
          receiverIp: session.receiverIp,
          receiverCountry: session.receiverCountry,
          deviceType: session.device.kind,
          format: 'article',
          sizeBytes: articleBuffer.byteLength,
        });

        const queued = sessions.addFile(session.key, {
          filename: articleFilename,
          title: built.title,
          author: built.author,
          mimeType: articleMime,
          format: 'article',
          buffer: articleBuffer,
          transferId,
        });

        return sendJson(res, 200, {
          ok: true,
          file: {
            id: queued.id,
            filename: queued.filename,
            title: queued.title,
            author: queued.author,
            format: queued.format,
            size: queued.size,
          },
        });
      }

      // API: Download file on E-Reader & mark [✓ Downloaded]
      if (method === 'GET' && pathname.startsWith('/api/download/')) {
        const rest = pathname.slice('/api/download/'.length);
        const parts = rest.split('/');
        const key = normalizeKey(decodeURIComponent(parts[0] || ''));
        const fileId = decodeURIComponent(parts[1] || '');

        const file = sessions.markDownloaded(key, fileId);
        if (!file) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('File or session expired.');
          return;
        }

        analytics.markTransferDownloaded(file.transferId);

        const asciiFallback = file.filename.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '');
        const encodedFilename = encodeURIComponent(file.filename);
        const session = sessions.getSession(key, false);
        const reqDevice = detectDevice(req.headers['user-agent']);
        const isKindleClient = session?.device.kind === 'kindle' || reqDevice.kind === 'kindle';

        // Kindle Experimental Web Browser requires simple Content-Disposition without RFC 5987 filename*=
        const contentDisposition = isKindleClient
          ? `attachment; filename="${asciiFallback}"`
          : `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodedFilename}`;

        res.writeHead(200, {
          'Content-Type': file.mimeType,
          'Content-Length': String(file.buffer.byteLength),
          'Content-Disposition': contentDisposition,
          'Cache-Control': 'no-store',
        });
        res.end(file.buffer);
        return;
      }

      // Protected /stats JSON & HTML Dashboard
      if (method === 'GET' && (pathname === '/stats' || pathname === '/api/stats')) {
        const clientAddr = extractClientAddress(req);
        if (!checkStatsAuth(req, url)) {
          if (!rateLimiter.allow(`stats-fail:${clientAddr.rawIp}`, 10, 5 * 60_000)) {
            return sendJson(res, 429, { error: 'Too many failed authentication attempts.' });
          }
          res.writeHead(401, {
            'WWW-Authenticate': `Basic realm="${config.appName} Analytics"`,
            'Content-Type': 'text/plain; charset=utf-8',
          });
          res.end('Authentication required');
          return;
        }

        const stats = analytics.getStats();
        const active = sessions.getActiveStats();

        if (pathname === '/api/stats') {
          return sendJson(res, 200, { ...stats, active });
        }

        const html = renderStatsDashboard(config, stats, active);
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(html);
        return;
      }

      // Main Views: E-Reader Receiver vs. Warm Editorial Sender
      if (method === 'GET' && (pathname === '/' || pathname === '/send' || pathname === '/receive')) {
        const clientAddr = extractClientAddress(req);
        const device = detectDevice(req.headers['user-agent']);
        const viewParam = url.searchParams.get('view');
        const prefillKey = normalizeKey(url.searchParams.get('key'));

        const forceReceiver = pathname === '/receive' || viewParam === 'ereader' || viewParam === 'receiver';
        const forceSender = pathname === '/send' || viewParam === 'sender' || Boolean(prefillKey);

        const isReceiverMode = forceReceiver || (!forceSender && device.isEreader);

        analytics.logVisit({
          ip: clientAddr.storedIp,
          country: clientAddr.country,
          role: isReceiverMode ? 'receiver' : 'sender',
          deviceType: device.kind,
          userAgent: req.headers['user-agent'],
        });

        if (isReceiverMode) {
          const session = sessions.createSession({
            receiverIp: clientAddr.storedIp,
            receiverCountry: clientAddr.country,
            device,
          });
          const qrSvg = await getQrForSessionKey(session.key);
          const html = renderReceiverPage(config, session, qrSvg);
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          res.end(html);
          return;
        }

        const html = renderSenderPage(config, prefillKey);
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache',
        });
        res.end(html);
        return;
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (err: any) {
      const msg = String(err?.message || 'Internal server error');
      const status = msg.includes('exceeds maximum') || msg.includes('quota exceeded')
        ? 413
        : msg.includes('queue limit reached')
          ? 429
          : 400;
      sendJson(res, status, { error: msg });
    }
  });

  // Harden HTTP timeouts against Slowloris / hanging sockets
  server.headersTimeout = 15_000;
  server.requestTimeout = 60_000;
  server.keepAliveTimeout = 10_000;

  return {
    server,
    config,
    sessions,
    analytics,
  };
}

function safeDecodeURIComponent(val: string): string {
  try {
    return decodeURIComponent(val);
  } catch {
    return val;
  }
}

function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function serveStaticFile(res: ServerResponse, filePath: string, contentType: string): void {
  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Asset not found');
    return;
  }
  const content = fs.readFileSync(filePath);
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': String(content.byteLength),
    'Cache-Control': 'public, max-age=300',
  });
  res.end(content);
}

function readBodyBuffer(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > maxBytes) {
        req.destroy();
        reject(new Error(`Payload exceeds maximum size of ${Math.round(maxBytes / (1024 * 1024))} MB`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function domainDisplay(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return 'leaf.casa';
  }
}

function renderReceiverPage(config: AppConfig, session: Session, qrSvg: string): string {
  const domain = domainDisplay(config.baseUrl);
  const spacedKey = session.key.split('').join(' ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(config.appName)} - E-Reader Receiver (${escapeHtml(domain)})</title>
  <link rel="icon" type="image/png" href="/favicon.png">
  <link rel="stylesheet" href="/assets/eink.css">
</head>
<body>
  <header class="eink-header">
    <div class="eink-brand">
      <span class="eink-brand-title">${escapeHtml(config.appName)}</span>
      <span class="eink-brand-domain">${escapeHtml(domain)}</span>
    </div>
    <div class="eink-nav">
      <a class="eink-switch-link" href="/?view=sender">[ Switch to Sender View ]</a>
    </div>
  </header>

  <main>
    <section class="eink-pairing-box" aria-label="Pairing Code">
      <div class="eink-code-col">
        <div class="eink-label">1. Open ${escapeHtml(domain)} on your phone or computer</div>
        <div class="eink-code-display" id="eink-code">${escapeHtml(spacedKey)}</div>
        <div class="eink-hint" id="eink-status-text">
          Device: <strong>${escapeHtml(session.device.label)}${session.device.prefersKepub ? ' (KePub Ready)' : ''}</strong> &middot; Waiting for files
        </div>
        <div>
          <a href="/receive" class="eink-secondary-btn" id="eink-refresh-btn">Refresh Queue</a>
          <a href="/receive" class="eink-secondary-btn" id="eink-new-code-btn">New Code</a>
        </div>
      </div>
      <div class="eink-qr-col">
        <div class="eink-qr-wrap" id="eink-qr" aria-label="QR Code for instant pairing">
          ${qrSvg}
        </div>
      </div>
    </section>

    <div id="eink-next-action"></div>

    <section aria-label="Book Queue">
      <h2 class="eink-section-title">Received Books &amp; Articles</h2>
      <div class="eink-empty-box" id="eink-empty-box">
        No books sent yet. Enter code <strong>${escapeHtml(session.key)}</strong> or scan the QR code on your phone or computer to send EPUB, PDF, or web articles.
      </div>
      <ul class="eink-queue-list" id="eink-queue-list"></ul>
    </section>
  </main>

  <footer class="eink-footer">
    Pure 1-Bit E-Ink Mode &middot; Files are held only in memory and cleared automatically after 15 minutes &middot; <a href="${escapeHtml(config.githubUrl)}" target="_blank" rel="noopener noreferrer">Source</a>
  </footer>

  <script>
    window.__LEAF_INITIAL_KEY__ = "${escapeHtml(session.key)}";
  </script>
  <script src="/assets/ereader.js"></script>
</body>
</html>`;
}

function renderSenderPage(config: AppConfig, prefillKey: string): string {
  const domain = domainDisplay(config.baseUrl);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(config.appName)} (${escapeHtml(domain)}) - Send Books &amp; Articles to Your E-Reader</title>
  <link rel="icon" type="image/png" href="/favicon.png">
  <link rel="apple-touch-icon" href="/assets/logo.png">
  <link rel="stylesheet" href="/assets/editorial.css">
</head>
<body>
  <div class="window-drop-overlay" id="window-drop-overlay" aria-hidden="true">
    <div class="window-drop-inner">
      <h2>Drop to Queue Books</h2>
      <p>Release anywhere to prepare your EPUB or PDF for your e-reader</p>
    </div>
  </div>

  <div class="editorial-shell">
    <header class="topbar">
      <a href="/" class="brand-lockup">
        <img src="/assets/logo.png" alt="" class="brand-logo-img" width="30" height="30">
        <span class="brand-name">${escapeHtml(config.appName)}</span>
        
      </a>
      <a href="/?view=ereader" class="role-switcher" title="Switch to high-contrast 1-bit E-Reader Receiver Mode">
        <span>E-Reader Mode</span>
        <span aria-hidden="true">⇄</span>
      </a>
    </header>

    <section class="hero-intro">
      <h1 class="hero-title">Send books &amp; articles to your e-reader.</h1>
      <p class="hero-subtitle">
        Open <strong>${escapeHtml(domain)}</strong> on your Kobo, Kindle, PocketBook, or Tolino browser, then enter the 4-character pairing code below.
      </p>
    </section>

    <main>
      <section class="card-panel" aria-labelledby="step-pair-heading">
        <div class="section-header">
          <span class="step-label" id="step-pair-heading">Step 1 · Pair with E-Reader</span>
          <label class="kepub-toggle-label" for="kepub-toggle" title="Converts standard EPUBs into Kobo KePub format right inside your browser">
            <input type="checkbox" id="kepub-toggle">
            <span>Convert EPUB → KePub (<code>.kepub.epub</code>)</span>
          </label>
        </div>

        <div class="code-slots-wrap" role="group" aria-label="4-character e-reader pairing code">
          <label for="slot-0" class="visually-hidden">Character 1</label>
          <input id="slot-0" class="code-slot" type="text" inputmode="text" maxlength="4" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="·">
          <label for="slot-1" class="visually-hidden">Character 2</label>
          <input id="slot-1" class="code-slot" type="text" inputmode="text" maxlength="4" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="·">
          <label for="slot-2" class="visually-hidden">Character 3</label>
          <input id="slot-2" class="code-slot" type="text" inputmode="text" maxlength="4" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="·">
          <label for="slot-3" class="visually-hidden">Character 4</label>
          <input id="slot-3" class="code-slot" type="text" inputmode="text" maxlength="4" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="·">
        </div>

        <div class="connection-bar" id="connection-bar" role="status" aria-live="polite">
          <div>
            <span class="status-dot" aria-hidden="true"></span>
            <span id="connection-text">Enter the 4-character code shown on your e-reader</span>
          </div>
        </div>
      </section>

      <section class="card-panel" aria-labelledby="step-send-heading">
        <div class="section-header">
          <span class="step-label" id="step-send-heading">Step 2 · Drop Books or Paste an Article URL</span>
        </div>

        <div class="dropzone" id="dropzone">
          <input
            type="file"
            id="file-input"
            class="dropzone-input"
            accept=".epub,.pdf,.mobi,.azw,.prc,.txt,application/epub+zip,application/pdf,application/x-mobipocket-ebook,text/plain"
            multiple
            aria-label="Choose EPUB, PDF, MOBI, or TXT files"
          >
          <div class="dropzone-icon" aria-hidden="true">✦</div>
          <div class="dropzone-title">Drop EPUB or PDF files anywhere</div>
          <p class="dropzone-hint">
            Or click to browse · Drop first or type code first, files transmit automatically
          </p>
        </div>

        <div class="article-block">
          <div class="article-header">
            <span class="article-title">Or send a web article</span>
            <span class="article-desc">Strips ads &amp; clutter from any link and delivers a clean eBook to your reader.</span>
          </div>
          <form class="article-form" id="article-form">
            <label for="article-url-input" class="visually-hidden">Web article URL</label>
            <input
              type="url"
              id="article-url-input"
              class="article-input"
              placeholder="https://example.com/essay-or-news-article"
              autocomplete="off"
            >
            <button type="submit" id="article-submit-btn" class="btn-leaf">
              Send as eBook
            </button>
          </form>
        </div>
      </section>

      <section class="card-panel" id="sender-queue-section" style="display: none;" aria-labelledby="queue-heading">
        <div class="section-header">
          <span class="step-label" id="queue-heading">Transfer Queue</span>
        </div>
        <ul class="queue-list" id="sender-queue-list"></ul>
      </section>
    </main>

    <footer class="editorial-footer">
      <p>
        Open Source &middot; Zero accounts &middot; In-browser KePub conversion &middot; Ephemeral 15-minute memory relay
      </p>
      <div class="editorial-footer-links">
        <a href="${escapeHtml(config.githubUrl)}" target="_blank" rel="noopener noreferrer">Source</a>
        <span aria-hidden="true">&middot;</span>
        <a href="/?view=ereader">E-Reader Receiver View</a>
      </div>
    </footer>
  </div>

  <script>
    window.__LEAF_PREFILL_KEY__ = "${escapeHtml(prefillKey)}";
  </script>
  <script src="/assets/sender.js" defer></script>
</body>
</html>`;
}

function renderStatsDashboard(
  config: AppConfig,
  stats: ReturnType<AnalyticsStore['getStats']>,
  active: ReturnType<SessionStore['getActiveStats']>
): string {
  const domain = domainDisplay(config.baseUrl);
  const mbRelayed = (stats.totals.bytesRelayed / (1024 * 1024)).toFixed(2);
  const activeMemMb = (active.memoryUsedBytes / (1024 * 1024)).toFixed(2);
  const maxDaily = Math.max(1, ...stats.daily.map((d) => Math.max(d.visits, d.transfers)));
  const maxCountryVisits = Math.max(1, ...stats.countries.map((c) => c.visits));
  const maxDeviceVisits = Math.max(1, ...stats.devices.map((d) => d.count));
  const maxFormatCount = Math.max(1, ...stats.formats.map((f) => f.count));

  const deliveryRate =
    stats.totals.transfersSent > 0
      ? Math.round((stats.totals.transfersDownloaded / stats.totals.transfersSent) * 100)
      : 0;
  const avgSizeKb =
    stats.totals.transfersSent > 0
      ? Math.round(stats.totals.bytesRelayed / stats.totals.transfersSent / 1024)
      : 0;
  const rawIpEnabled = (process.env.LOG_RAW_IP ?? 'true').toLowerCase() !== 'false';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(config.appName)} Analytics - ${escapeHtml(domain)}</title>
  <link rel="icon" type="image/png" href="/favicon.png">
  <link rel="stylesheet" href="/assets/editorial.css">
</head>
<body>
  <div class="stats-shell">
    <header class="topbar">
      <a href="/" class="brand-lockup">
        <img src="/assets/logo.png" alt="" class="brand-logo-img" width="30" height="30">
        <span class="brand-name">${escapeHtml(config.appName)}</span>
        <span class="brand-domain">/stats</span>
      </a>
      <a href="/" class="role-switcher">← Back to Relay</a>
    </header>

    <section class="privacy-banner" aria-label="Privacy and Data Retention Policy">
      <div>
        <strong>Privacy-First Operational Telemetry:</strong> Book files, filenames, titles, and article URLs are never written to disk.
      </div>
      <div class="privacy-pills">
        <span class="privacy-pill">Client Trackers: 0</span>
        <span class="privacy-pill">Book Storage: RAM-Only (15m TTL)</span>
        <span class="privacy-pill">IP Mode: ${rawIpEnabled ? 'Raw (LOG_RAW_IP=true)' : 'SHA-256 Hash (LOG_RAW_IP=false)'}</span>
      </div>
    </section>

    <section class="kpi-grid" aria-label="Summary Metrics">
      <div class="kpi-card">
        <div class="kpi-label">Total Visits</div>
        <div class="kpi-value">${stats.totals.visits.toLocaleString()}</div>
        <div class="kpi-sub">${stats.totals.senderVisits} senders · ${stats.totals.receiverVisits} e-readers · ${stats.totals.botVisits} likely bots</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Unique IPs</div>
        <div class="kpi-value">${stats.totals.uniqueIps.toLocaleString()}</div>
        <div class="kpi-sub">${rawIpEnabled ? 'Direct IP count' : 'Anonymized hash count'}</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Books &amp; Articles Sent</div>
        <div class="kpi-value">${stats.totals.transfersSent.toLocaleString()}</div>
        <div class="kpi-sub">${stats.totals.transfersDownloaded.toLocaleString()} downloaded (${deliveryRate}% delivery rate)</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Volume Relayed</div>
        <div class="kpi-value">${mbRelayed} MB</div>
        <div class="kpi-sub">Avg ${avgSizeKb} KB/book · ${active.activeSessions} live (${activeMemMb} MB RAM)</div>
      </div>
    </section>

    <section class="card-panel" style="margin-bottom: 24px;">
      <div class="section-header">
        <span class="step-label">Daily Activity (Last 14 Days)</span>
      </div>
      <div class="daily-chart" role="img" aria-label="14-day activity bar chart">
        ${stats.daily
      .map((d) => {
        const heightPct = Math.max(4, Math.round(((d.visits + d.transfers) / maxDaily) * 100));
        return `
              <div class="daily-col" title="${escapeHtml(d.day)}: ${d.visits} visits, ${d.transfers} transfers">
                <div class="daily-bar" style="height: ${heightPct}%;"></div>
                <span class="daily-date">${escapeHtml(d.day.slice(5))}</span>
              </div>
            `;
      })
      .join('')}
      </div>
    </section>

    <div class="stats-two-col">
      <section class="card-panel">
        <div class="section-header">
          <span class="step-label">Top Countries</span>
        </div>
        ${stats.countries.length === 0
      ? '<p class="kpi-sub">No traffic recorded yet.</p>'
      : stats.countries
        .map((c) => {
          const pct = Math.max(4, Math.round((c.visits / maxCountryVisits) * 100));
          const botNote =
            c.botVisits > 0
              ? ` (${c.botVisits} likely ${c.botVisits === 1 ? 'bot' : 'bots'})`
              : '';
          return `
                  <div class="bar-row">
                    <div class="bar-row-top">
                      <span>${c.flag} <strong>${escapeHtml(c.country)}</strong></span>
                      <span>${c.visits} visits${botNote} · ${c.transfers} books</span>
                    </div>
                    <div class="bar-track"><div class="bar-fill" style="width: ${pct}%;"></div></div>
                  </div>
                `;
        })
        .join('')
    }
      </section>

      <section class="card-panel">
        <div class="section-header">
          <span class="step-label">Device &amp; Format Breakdown</span>
        </div>
        ${stats.devices
      .map((d) => {
        const pct = Math.max(4, Math.round((d.count / maxDeviceVisits) * 100));
        return `
            <div class="bar-row">
              <div class="bar-row-top">
                <span>Device: <strong>${escapeHtml(d.deviceType)}</strong></span>
                <span>${d.count} visits</span>
              </div>
              <div class="bar-track"><div class="bar-fill" style="width: ${pct}%;"></div></div>
            </div>
          `;
      })
      .join('')}
        ${stats.formats
      .map((f) => {
        const pct = Math.max(4, Math.round((f.count / maxFormatCount) * 100));
        return `
            <div class="bar-row">
              <div class="bar-row-top">
                <span>Format: <code>${escapeHtml(f.format)}</code></span>
                <span>${f.count} sent (${(f.bytes / (1024 * 1024)).toFixed(1)} MB)</span>
              </div>
              <div class="bar-track"><div class="bar-fill" style="width: ${pct}%;"></div></div>
            </div>
          `;
      })
      .join('')}
      </section>
    </div>

    <section style="margin-bottom: 28px;">
      <div tabindex="0" role="region" aria-labelledby="recent-transfers-caption" class="table-wrapper">
        <table style="--label-2: 'Time (UTC)'; --label-3: 'Sender'; --label-4: 'Receiver'; --label-5: 'Format & Size'; --label-6: 'Status';">
          <caption id="recent-transfers-caption">Recent Book &amp; Article Transfers</caption>
          <thead>
            <tr>
              <th>Session</th>
              <th>Time (UTC)</th>
              <th>Sender</th>
              <th>Receiver</th>
              <th>Format &amp; Size</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            ${stats.recentTransfers.length === 0
      ? '<tr><th>-</th><td colspan="5">No transfers recorded yet.</td></tr>'
      : stats.recentTransfers
        .map(
          (t) => `
                      <tr>
                        <th>${escapeHtml(t.sessionKey)}</th>
                        <td>${escapeHtml(t.createdAt)}</td>
                        <td>${countryToFlag(t.senderCountry)} ${escapeHtml(t.senderCountry)} (${escapeHtml(t.senderIp)})</td>
                        <td>${countryToFlag(t.receiverCountry)} ${escapeHtml(t.receiverCountry)} · ${escapeHtml(t.deviceType)}</td>
                        <td><code>${escapeHtml(t.format)}</code> · ${Math.round(t.sizeBytes / 1024)} KB</td>
                        <td>${t.downloaded ? '✓ Downloaded' : 'Queued'}</td>
                      </tr>
                    `
        )
        .join('')
    }
          </tbody>
        </table>
      </div>
    </section>

    <section>
      <div tabindex="0" role="region" aria-labelledby="recent-visits-caption" class="table-wrapper">
        <table style="--label-2: 'Time (UTC)'; --label-3: 'Country & IP'; --label-4: 'Role'; --label-5: 'Device';">
          <caption id="recent-visits-caption">Recent Visits</caption>
          <thead>
            <tr>
              <th>ID</th>
              <th>Time (UTC)</th>
              <th>Country &amp; IP</th>
              <th>Role</th>
              <th>Device</th>
            </tr>
          </thead>
          <tbody>
            ${stats.recentVisits.length === 0
      ? '<tr><th>-</th><td colspan="4">No visits recorded yet.</td></tr>'
      : stats.recentVisits
        .map(
          (v) => `
                      <tr title="${escapeHtml(v.userAgent || 'No User-Agent')}">
                        <th>#${v.id}</th>
                        <td>${escapeHtml(v.createdAt)}</td>
                        <td>${countryToFlag(v.country)} ${escapeHtml(v.country)} (${escapeHtml(v.ip)})</td>
                        <td>${escapeHtml(v.role)}${v.isBot ? ' · likely bot' : ''}</td>
                        <td>${escapeHtml(v.deviceType)}</td>
                      </tr>
                    `
        )
        .join('')
    }
          </tbody>
        </table>
      </div>
    </section>
  </div>
</body>
</html>`;
}

// Start server when run directly
const isMain =
  process.argv[1] &&
  (path.resolve(process.argv[1]) === path.resolve(__filename) ||
    process.argv[1].endsWith('server/index.ts') ||
    process.argv[1].endsWith('server/index.js'));

if (isMain) {
  const { server, config } = createLeafServer();
  server.listen(config.port, config.host, () => {
    console.log(`${config.appName} relay listening on http://${config.host}:${config.port} (${config.baseUrl})`);
  });
}
