import crypto from 'node:crypto';
import { unzipSync } from 'fflate';

export const CROCKFORD_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
export const KEY_LENGTH = 4;
export const MAX_FILES_PER_SESSION = 15;
export const MAX_SESSION_BYTES = 150 * 1024 * 1024;
export const MAX_SESSIONS_PER_IP = 10;

export type DeviceKind =
  | 'kobo'
  | 'kindle'
  | 'pocketbook'
  | 'tolino'
  | 'ereader'
  | 'mobile'
  | 'desktop';

export interface DeviceInfo {
  kind: DeviceKind;
  label: string;
  isEreader: boolean;
  prefersKepub: boolean;
}

export interface QueuedFile {
  id: string;
  filename: string;
  title?: string;
  author?: string;
  mimeType: string;
  format: '.kepub.epub' | '.epub' | '.pdf' | 'article';
  size: number;
  buffer: Buffer;
  uploadedAt: number;
  downloaded: boolean;
  downloadedAt: number | null;
  transferId?: number;
}

export interface PublicFileMetadata {
  id: string;
  filename: string;
  title?: string;
  author?: string;
  format: '.kepub.epub' | '.epub' | '.pdf' | 'article';
  size: number;
  uploadedAt: number;
  downloaded: boolean;
  downloadedAt: number | null;
}

export type SessionListener = (event: string, payload: unknown) => void;

export interface Session {
  key: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  receiverIp: string;
  receiverCountry: string;
  device: DeviceInfo;
  files: QueuedFile[];
  listeners: Set<SessionListener>;
}

export function detectDevice(userAgentRaw: string | undefined): DeviceInfo {
  const ua = (userAgentRaw || '').toLowerCase();

  if (ua.includes('kobo') || ua.includes('nickel')) {
    return {
      kind: 'kobo',
      label: 'Kobo Reader',
      isEreader: true,
      prefersKepub: true,
    };
  }

  if (
    ua.includes('kindle') ||
    ua.includes('silk/') ||
    ua.includes('kfapw') ||
    ua.includes('kftt') ||
    ua.includes('kfjwi') ||
    (ua.includes('linux; u;') && ua.includes('en-us;') && !ua.includes('android'))
  ) {
    return {
      kind: 'kindle',
      label: 'Kindle Reader',
      isEreader: true,
      prefersKepub: false,
    };
  }

  if (ua.includes('pocketbook')) {
    return {
      kind: 'pocketbook',
      label: 'PocketBook',
      isEreader: true,
      prefersKepub: false,
    };
  }

  if (ua.includes('tolino')) {
    return {
      kind: 'tolino',
      label: 'Tolino Reader',
      isEreader: true,
      prefersKepub: false,
    };
  }

  if (
    ua.includes('nook') ||
    ua.includes('ebook') ||
    ua.includes('ereader') ||
    ua.includes('e-ink') ||
    ua.includes('boox') ||
    ua.includes('remarkable') ||
    ua.includes('cervantes') ||
    ua.includes('netfront')
  ) {
    return {
      kind: 'ereader',
      label: 'E-Reader',
      isEreader: true,
      prefersKepub: false,
    };
  }

  if (ua.includes('iphone') || ua.includes('ipad') || ua.includes('android') || ua.includes('mobile')) {
    return {
      kind: 'mobile',
      label: 'Mobile Browser',
      isEreader: false,
      prefersKepub: false,
    };
  }

  return {
    kind: 'desktop',
    label: 'Desktop Browser',
    isEreader: false,
    prefersKepub: false,
  };
}

export function normalizeKey(input: string | undefined | null): string {
  if (!input) return '';
  return input
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, KEY_LENGTH);
}

export function isValidKey(key: string): boolean {
  if (key.length !== KEY_LENGTH) return false;
  for (let i = 0; i < key.length; i++) {
    if (!CROCKFORD_ALPHABET.includes(key[i])) return false;
  }
  return true;
}

export class SessionStore {
  private sessions = new Map<string, Session>();
  private ttlMs: number;
  private maxMemoryBytes: number;
  private currentMemoryBytes = 0;
  private gcTimer: NodeJS.Timeout;

  constructor(options?: { ttlMinutes?: number; maxMemoryPoolMb?: number }) {
    const ttlMinutes = options?.ttlMinutes ?? Number(process.env.SESSION_TTL_MINUTES || 15);
    const maxMemoryMb = options?.maxMemoryPoolMb ?? Number(process.env.MAX_MEMORY_POOL_MB || 512);
    this.ttlMs = Math.max(1, ttlMinutes) * 60 * 1000;
    this.maxMemoryBytes = Math.max(32, maxMemoryMb) * 1024 * 1024;

    this.gcTimer = setInterval(() => this.sweepExpired(), 30_000);
    this.gcTimer.unref();
  }

  private generateUniqueKey(): string {
    for (let attempt = 0; attempt < 64; attempt++) {
      const bytes = crypto.randomBytes(KEY_LENGTH);
      let code = '';
      for (let i = 0; i < KEY_LENGTH; i++) {
        code += CROCKFORD_ALPHABET[bytes[i] % CROCKFORD_ALPHABET.length];
      }
      if (!this.sessions.has(code)) {
        return code;
      }
    }
    throw new Error('Unable to allocate an ephemeral pairing key.');
  }

  createSession(params: {
    receiverIp: string;
    receiverCountry: string;
    device: DeviceInfo;
    preferredKey?: string;
  }): Session {
    this.sweepExpired();

    const now = Date.now();
    const preferred = normalizeKey(params.preferredKey);

    if (preferred && isValidKey(preferred)) {
      const existing = this.sessions.get(preferred);
      if (existing && existing.expiresAt > now) {
        existing.lastSeenAt = now;
        existing.expiresAt = now + this.ttlMs;
        return existing;
      }
    }

    // Prevent a single IP from exhausting active sessions; evict oldest empty session from same IP first
    if (params.receiverIp) {
      const ipSessions = Array.from(this.sessions.values())
        .filter((s) => s.receiverIp === params.receiverIp)
        .sort((a, b) => a.files.length - b.files.length || a.createdAt - b.createdAt);
      while (ipSessions.length >= MAX_SESSIONS_PER_IP) {
        const oldest = ipSessions.shift();
        if (oldest) this.deleteSession(oldest.key);
      }
    }

    const key = this.generateUniqueKey();
    const session: Session = {
      key,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + this.ttlMs,
      receiverIp: params.receiverIp,
      receiverCountry: params.receiverCountry,
      device: params.device,
      files: [],
      listeners: new Set(),
    };

    this.sessions.set(key, session);
    return session;
  }

  getSession(rawKey: string, touch = true): Session | undefined {
    const key = normalizeKey(rawKey);
    if (!isValidKey(key)) return undefined;

    const session = this.sessions.get(key);
    if (!session) return undefined;

    const now = Date.now();
    if (session.expiresAt <= now) {
      this.deleteSession(key);
      return undefined;
    }

    if (touch) {
      session.lastSeenAt = now;
      session.expiresAt = now + this.ttlMs;
    }
    return session;
  }

  overrideDevicePreference(rawKey: string, prefersKepub: boolean, label?: string): Session | undefined {
    const session = this.getSession(rawKey, true);
    if (!session) return undefined;
    session.device = {
      ...session.device,
      prefersKepub,
      kind: prefersKepub ? 'kobo' : session.device.kind === 'kobo' ? 'ereader' : session.device.kind,
      label: label || (prefersKepub ? 'Kobo Reader' : session.device.label),
    };
    this.notify(session, 'status', this.serializeSession(session));
    return session;
  }

  addFile(
    rawKey: string,
    file: {
      filename: string;
      title?: string;
      author?: string;
      mimeType: string;
      format: '.kepub.epub' | '.epub' | '.pdf' | 'article';
      buffer: Buffer;
      transferId?: number;
    }
  ): QueuedFile {
    const session = this.getSession(rawKey, true);
    if (!session) {
      throw new Error('Session not found or expired.');
    }

    if (session.files.length >= MAX_FILES_PER_SESSION) {
      throw new Error(`Session queue limit reached (maximum ${MAX_FILES_PER_SESSION} files per session).`);
    }

    const sessionBytes = session.files.reduce((acc, f) => acc + f.size, 0);
    if (sessionBytes + file.buffer.byteLength > MAX_SESSION_BYTES) {
      throw new Error('Session storage quota exceeded (maximum 150 MB per session).');
    }

    // Evict already-downloaded buffers first if memory pool is under pressure
    if (this.currentMemoryBytes + file.buffer.byteLength > this.maxMemoryBytes) {
      this.reclaimDownloadedBuffers();
    }

    if (this.currentMemoryBytes + file.buffer.byteLength > this.maxMemoryBytes) {
      throw new Error('Relay memory pool is temporarily full. Please wait a moment and try again.');
    }

    const queued: QueuedFile = {
      id: crypto.randomBytes(6).toString('hex'),
      filename: sanitizeFilename(file.filename),
      title: file.title,
      author: file.author,
      mimeType: file.mimeType,
      format: file.format,
      size: file.buffer.byteLength,
      buffer: file.buffer,
      uploadedAt: Date.now(),
      downloaded: false,
      downloadedAt: null,
      transferId: file.transferId,
    };

    session.files.push(queued);
    this.currentMemoryBytes += file.buffer.byteLength;

    this.notify(session, 'queue', this.serializeSession(session));
    return queued;
  }

  markDownloaded(rawKey: string, fileId: string): QueuedFile | undefined {
    const session = this.getSession(rawKey, true);
    if (!session) return undefined;

    const target = session.files.find((f) => f.id === fileId);
    if (!target) return undefined;

    if (!target.downloaded) {
      target.downloaded = true;
      target.downloadedAt = Date.now();
      this.notify(session, 'queue', this.serializeSession(session));
    }

    return target;
  }

  subscribe(rawKey: string, listener: SessionListener): (() => void) | undefined {
    const session = this.getSession(rawKey, true);
    if (!session) return undefined;

    session.listeners.add(listener);
    return () => {
      session.listeners.delete(listener);
    };
  }

  serializeSession(session: Session) {
    const files: PublicFileMetadata[] = session.files.map((f) => ({
      id: f.id,
      filename: f.filename,
      title: f.title,
      author: f.author,
      format: f.format,
      size: f.size,
      uploadedAt: f.uploadedAt,
      downloaded: f.downloaded,
      downloadedAt: f.downloadedAt,
    }));

    const pendingCount = files.filter((f) => !f.downloaded).length;
    const nextFile = files.find((f) => !f.downloaded) || null;

    return {
      key: session.key,
      expiresAt: session.expiresAt,
      ttlSeconds: Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1000)),
      device: session.device,
      files,
      totalCount: files.length,
      pendingCount,
      nextFile,
    };
  }

  getActiveStats() {
    this.sweepExpired();
    let queuedFiles = 0;
    for (const s of this.sessions.values()) {
      queuedFiles += s.files.length;
    }
    return {
      activeSessions: this.sessions.size,
      queuedFiles,
      memoryUsedBytes: this.currentMemoryBytes,
    };
  }

  deleteSession(key: string): void {
    const session = this.sessions.get(key);
    if (!session) return;

    for (const f of session.files) {
      this.currentMemoryBytes = Math.max(0, this.currentMemoryBytes - f.buffer.byteLength);
    }
    session.files = [];
    session.listeners.clear();
    this.sessions.delete(key);
  }

  private reclaimDownloadedBuffers(): void {
    const now = Date.now();
    for (const [key, session] of this.sessions.entries()) {
      if (session.expiresAt <= now) {
        this.deleteSession(key);
        continue;
      }
      // Remove already-downloaded files from sessions to free RAM under pressure
      const remaining: QueuedFile[] = [];
      for (const f of session.files) {
        if (f.downloaded) {
          this.currentMemoryBytes = Math.max(0, this.currentMemoryBytes - f.buffer.byteLength);
        } else {
          remaining.push(f);
        }
      }
      session.files = remaining;
    }
  }

  sweepExpired(): void {
    const now = Date.now();
    for (const [key, session] of this.sessions.entries()) {
      if (session.expiresAt <= now) {
        this.deleteSession(key);
      }
    }
  }

  private notify(session: Session, event: string, payload: unknown): void {
    for (const listener of session.listeners) {
      try {
        listener(event, payload);
      } catch {
        // Ignore closed stream listener errors
      }
    }
  }
}

export function sanitizeFilename(name: string): string {
  const cleaned = name
    .replace(/[\x00-\x1f\x7f\r\n\t/\\?%*:|"<>]/g, '_')
    .replace(/^\.+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
  return cleaned || 'book.epub';
}

/**
 * Validates binary magic bytes and internal structure so renamed files
 * (e.g., an .mp4 or .exe renamed to .epub or .pdf) are rejected.
 */
export function validateBookBuffer(
  buffer: Buffer,
  expectedFormat: '.kepub.epub' | '.epub' | '.pdf'
): { valid: boolean; reason?: string } {
  if (buffer.byteLength < 8) {
    return { valid: false, reason: 'File is too small to be a valid eBook or PDF.' };
  }

  if (expectedFormat === '.pdf') {
    // PDF specification allows %PDF- header within the first 1024 bytes
    const headerWindow = buffer.subarray(0, Math.min(1024, buffer.byteLength)).toString('latin1');
    if (!headerWindow.includes('%PDF-')) {
      return {
        valid: false,
        reason: 'Invalid PDF file: missing %PDF header (file may be renamed or corrupted).',
      };
    }
    return { valid: true };
  }

  // EPUB / KePub must start with ZIP local file header signature PK\x03\x04
  if (
    buffer[0] !== 0x50 ||
    buffer[1] !== 0x4b ||
    buffer[2] !== 0x03 ||
    buffer[3] !== 0x04
  ) {
    return {
      valid: false,
      reason: 'Invalid EPUB file: not a valid ZIP container (file may be renamed or corrupted).',
    };
  }

  // Verify EPUB structure without decompressing oversized zip bombs
  let fileCount = 0;
  let totalUncompressedBytes = 0;
  const maxUncompressedBytes = 250 * 1024 * 1024; // 250 MB uncompressed cap
  let hasEpubMarker = false;

  try {
    const entries = unzipSync(new Uint8Array(buffer), {
      filter(file) {
        fileCount++;
        if (fileCount > 4000) {
          throw new Error('Archive contains too many files (>4000) to be a safe EPUB.');
        }
        totalUncompressedBytes += file.originalSize;
        if (totalUncompressedBytes > maxUncompressedBytes) {
          throw new Error('Uncompressed EPUB size exceeds safety limit (possible zip bomb).');
        }
        const lowerName = file.name.toLowerCase();
        if (
          lowerName === 'mimetype' ||
          lowerName === 'meta-inf/container.xml' ||
          lowerName.endsWith('.opf')
        ) {
          hasEpubMarker = true;
        }
        // We only need to inspect markers, no need to decompress every chapter on the server
        return false;
      },
    });
    void entries;
  } catch (err: any) {
    return {
      valid: false,
      reason: err?.message || 'Corrupted or unsafe EPUB archive.',
    };
  }

  if (!hasEpubMarker) {
    return {
      valid: false,
      reason: 'Invalid EPUB archive: missing META-INF/container.xml or OPF package metadata.',
    };
  }

  return { valid: true };
}

