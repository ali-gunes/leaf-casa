import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import type { DeviceKind } from './sessionStore.ts';

let geoipModule: { lookup: (ip: string) => { country?: string } | null } | null | undefined;

function lookupGeoCountry(ip: string): string {
  if (!ip || ip === '127.0.0.1' || ip === '::1' || ip.startsWith('192.168.') || ip.startsWith('10.')) {
    return 'LOCAL';
  }
  if (geoipModule === undefined) {
    try {
      // Lazy-load geoip-lite only when needed
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      geoipModule = require('geoip-lite');
    } catch {
      geoipModule = null;
    }
  }
  if (!geoipModule) return 'XX';
  try {
    const res = geoipModule.lookup(ip);
    return res?.country || 'XX';
  } catch {
    return 'XX';
  }
}

export function extractClientAddress(req: IncomingMessage): {
  rawIp: string;
  storedIp: string;
  country: string;
} {
  const cfIp = headerString(req.headers['cf-connecting-ip']);
  const xff = headerString(req.headers['x-forwarded-for']);
  const realIp = headerString(req.headers['x-real-ip']);

  let rawIp =
    cfIp ||
    (xff ? xff.split(',')[0].trim() : '') ||
    realIp ||
    req.socket?.remoteAddress ||
    '0.0.0.0';

  if (rawIp.startsWith('::ffff:')) {
    rawIp = rawIp.slice(7);
  }

  const cfCountry =
    headerString(req.headers['cf-ipcountry']) ||
    headerString(req.headers['x-country-code']) ||
    headerString(req.headers['x-vercel-ip-country']);

  let country = cfCountry ? cfCountry.toUpperCase() : '';
  if (!country || country === 'XX' || country === 'T1') {
    country = lookupGeoCountry(rawIp);
  }

  const logRawIp = (process.env.LOG_RAW_IP ?? 'true').toLowerCase() !== 'false';
  const storedIp = logRawIp
    ? rawIp
    : 'anon-' + crypto.createHash('sha256').update(rawIp).digest('hex').slice(0, 10);

  return { rawIp, storedIp, country };
}

function headerString(val: string | string[] | undefined): string {
  if (!val) return '';
  return Array.isArray(val) ? val[0] || '' : val;
}

export function countryToFlag(countryCode: string): string {
  const code = (countryCode || '').toUpperCase();
  if (code === 'LOCAL') return '🏠';
  if (code.length !== 2 || code === 'XX') return '🌐';
  const first = code.codePointAt(0);
  const second = code.codePointAt(1);
  if (!first || !second || first < 65 || first > 90 || second < 65 || second > 90) {
    return '🌐';
  }
  return String.fromCodePoint(0x1f1e6 + (first - 65), 0x1f1e6 + (second - 65));
}

export interface StatsSnapshot {
  totals: {
    visits: number;
    uniqueIps: number;
    senderVisits: number;
    receiverVisits: number;
    transfersSent: number;
    transfersDownloaded: number;
    bytesRelayed: number;
  };
  countries: Array<{ country: string; flag: string; visits: number; transfers: number }>;
  devices: Array<{ deviceType: string; count: number }>;
  formats: Array<{ format: string; count: number; bytes: number }>;
  daily: Array<{ day: string; visits: number; transfers: number }>;
  recentTransfers: Array<{
    id: number;
    createdAt: string;
    sessionKey: string;
    senderIp: string;
    senderCountry: string;
    receiverIp: string;
    receiverCountry: string;
    deviceType: string;
    format: string;
    sizeBytes: number;
    downloaded: boolean;
  }>;
  recentVisits: Array<{
    id: number;
    createdAt: string;
    ip: string;
    country: string;
    role: string;
    deviceType: string;
  }>;
}

export class AnalyticsStore {
  private db: DatabaseSync;

  constructor(dbPath?: string) {
    const resolvedPath = dbPath || process.env.DB_PATH || path.join(process.cwd(), 'data', 'stats.db');
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });

    this.db = new DatabaseSync(resolvedPath);
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;

      CREATE TABLE IF NOT EXISTS visits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        ip TEXT NOT NULL,
        country TEXT NOT NULL,
        role TEXT NOT NULL,
        device_type TEXT NOT NULL,
        user_agent TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_visits_created_at ON visits(created_at);
      CREATE INDEX IF NOT EXISTS idx_visits_country ON visits(country);

      CREATE TABLE IF NOT EXISTS transfers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        session_key TEXT NOT NULL,
        sender_ip TEXT NOT NULL,
        sender_country TEXT NOT NULL,
        receiver_ip TEXT NOT NULL,
        receiver_country TEXT NOT NULL,
        device_type TEXT NOT NULL,
        format TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        downloaded INTEGER NOT NULL DEFAULT 0,
        downloaded_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_transfers_created_at ON transfers(created_at);
    `);
  }

  logVisit(params: {
    ip: string;
    country: string;
    role: 'sender' | 'receiver';
    deviceType: DeviceKind | string;
    userAgent?: string;
  }): void {
    setImmediate(() => {
      try {
        const stmt = this.db.prepare(`
          INSERT INTO visits (ip, country, role, device_type, user_agent)
          VALUES (?, ?, ?, ?, ?)
        `);
        stmt.run(
          params.ip,
          params.country || 'XX',
          params.role,
          params.deviceType,
          (params.userAgent || '').slice(0, 280)
        );
      } catch {
        // Non-blocking analytics failure
      }
    });
  }

  logTransfer(params: {
    sessionKey: string;
    senderIp: string;
    senderCountry: string;
    receiverIp: string;
    receiverCountry: string;
    deviceType: string;
    format: '.kepub.epub' | '.epub' | '.pdf' | 'article';
    sizeBytes: number;
  }): number | undefined {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO transfers (
          session_key, sender_ip, sender_country, receiver_ip, receiver_country,
          device_type, format, size_bytes, downloaded
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
      `);
      const res = stmt.run(
        params.sessionKey,
        params.senderIp,
        params.senderCountry || 'XX',
        params.receiverIp,
        params.receiverCountry || 'XX',
        params.deviceType,
        params.format,
        params.sizeBytes
      );
      return Number(res.lastInsertRowid);
    } catch {
      return undefined;
    }
  }

  markTransferDownloaded(transferId: number | undefined): void {
    if (!transferId) return;
    setImmediate(() => {
      try {
        const stmt = this.db.prepare(`
          UPDATE transfers
          SET downloaded = 1, downloaded_at = datetime('now')
          WHERE id = ?
        `);
        stmt.run(transferId);
      } catch {
        // Ignore analytics update error
      }
    });
  }

  getStats(): StatsSnapshot {
    const visitRow = this.db
      .prepare(
        `SELECT
          COUNT(*) AS total,
          COUNT(DISTINCT ip) AS unique_ips,
          SUM(CASE WHEN role = 'sender' THEN 1 ELSE 0 END) AS sender_visits,
          SUM(CASE WHEN role = 'receiver' THEN 1 ELSE 0 END) AS receiver_visits
        FROM visits`
      )
      .get() as Record<string, number | null>;

    const transferRow = this.db
      .prepare(
        `SELECT
          COUNT(*) AS sent,
          SUM(CASE WHEN downloaded = 1 THEN 1 ELSE 0 END) AS downloaded,
          COALESCE(SUM(size_bytes), 0) AS bytes_relayed
        FROM transfers`
      )
      .get() as Record<string, number | null>;

    const countryRows = this.db
      .prepare(
        `SELECT
          c.country AS country,
          COALESCE(v.visit_count, 0) AS visits,
          COALESCE(t.transfer_count, 0) AS transfers
        FROM (
          SELECT country FROM visits
          UNION
          SELECT sender_country AS country FROM transfers
          UNION
          SELECT receiver_country AS country FROM transfers
        ) c
        LEFT JOIN (
          SELECT country, COUNT(*) AS visit_count FROM visits GROUP BY country
        ) v ON v.country = c.country
        LEFT JOIN (
          SELECT receiver_country AS country, COUNT(*) AS transfer_count FROM transfers GROUP BY receiver_country
        ) t ON t.country = c.country
        ORDER BY visits DESC, transfers DESC
        LIMIT 12`
      )
      .all() as Array<{ country: string; visits: number; transfers: number }>;

    const deviceRows = this.db
      .prepare(
        `SELECT device_type AS deviceType, COUNT(*) AS count
         FROM visits
         GROUP BY device_type
         ORDER BY count DESC`
      )
      .all() as Array<{ deviceType: string; count: number }>;

    const formatRows = this.db
      .prepare(
        `SELECT format, COUNT(*) AS count, COALESCE(SUM(size_bytes), 0) AS bytes
         FROM transfers
         GROUP BY format
         ORDER BY count DESC`
      )
      .all() as Array<{ format: string; count: number; bytes: number }>;

    const dailyVisitRows = this.db
      .prepare(
        `SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS count
         FROM visits
         WHERE created_at >= datetime('now', '-14 days')
         GROUP BY day
         ORDER BY day ASC`
      )
      .all() as Array<{ day: string; count: number }>;

    const dailyTransferRows = this.db
      .prepare(
        `SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS count
         FROM transfers
         WHERE created_at >= datetime('now', '-14 days')
         GROUP BY day
         ORDER BY day ASC`
      )
      .all() as Array<{ day: string; count: number }>;

    const dayMap = new Map<string, { visits: number; transfers: number }>();
    for (let i = 13; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
      dayMap.set(d, { visits: 0, transfers: 0 });
    }
    for (const r of dailyVisitRows) {
      const entry = dayMap.get(r.day) || { visits: 0, transfers: 0 };
      entry.visits = Number(r.count);
      dayMap.set(r.day, entry);
    }
    for (const r of dailyTransferRows) {
      const entry = dayMap.get(r.day) || { visits: 0, transfers: 0 };
      entry.transfers = Number(r.count);
      dayMap.set(r.day, entry);
    }

    const recentTransferRows = this.db
      .prepare(
        `SELECT
          id, created_at, session_key, sender_ip, sender_country,
          receiver_ip, receiver_country, device_type, format, size_bytes, downloaded
         FROM transfers
         ORDER BY id DESC
         LIMIT 25`
      )
      .all() as Array<Record<string, unknown>>;

    const recentVisitRows = this.db
      .prepare(
        `SELECT id, created_at, ip, country, role, device_type
         FROM visits
         ORDER BY id DESC
         LIMIT 25`
      )
      .all() as Array<Record<string, unknown>>;

    return {
      totals: {
        visits: Number(visitRow?.total || 0),
        uniqueIps: Number(visitRow?.unique_ips || 0),
        senderVisits: Number(visitRow?.sender_visits || 0),
        receiverVisits: Number(visitRow?.receiver_visits || 0),
        transfersSent: Number(transferRow?.sent || 0),
        transfersDownloaded: Number(transferRow?.downloaded || 0),
        bytesRelayed: Number(transferRow?.bytes_relayed || 0),
      },
      countries: countryRows.map((c) => ({
        country: c.country,
        flag: countryToFlag(c.country),
        visits: Number(c.visits),
        transfers: Number(c.transfers),
      })),
      devices: deviceRows.map((d) => ({
        deviceType: String(d.deviceType),
        count: Number(d.count),
      })),
      formats: formatRows.map((f) => ({
        format: String(f.format),
        count: Number(f.count),
        bytes: Number(f.bytes),
      })),
      daily: Array.from(dayMap.entries()).map(([day, counts]) => ({
        day,
        visits: counts.visits,
        transfers: counts.transfers,
      })),
      recentTransfers: recentTransferRows.map((r) => ({
        id: Number(r.id),
        createdAt: String(r.created_at),
        sessionKey: String(r.session_key),
        senderIp: String(r.sender_ip),
        senderCountry: String(r.sender_country),
        receiverIp: String(r.receiver_ip),
        receiverCountry: String(r.receiver_country),
        deviceType: String(r.device_type),
        format: String(r.format),
        sizeBytes: Number(r.size_bytes),
        downloaded: Number(r.downloaded) === 1,
      })),
      recentVisits: recentVisitRows.map((r) => ({
        id: Number(r.id),
        createdAt: String(r.created_at),
        ip: String(r.ip),
        country: String(r.country),
        role: String(r.role),
        deviceType: String(r.device_type),
      })),
    };
  }

  close(): void {
    this.db.close();
  }
}
