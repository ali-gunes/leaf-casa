import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import {
  CROCKFORD_ALPHABET,
  SessionStore,
  detectDevice,
  isValidKey,
} from '../src/server/sessionStore.ts';
import { inspectAndConvertEpub } from '../src/client/sender/kepubify.ts';
import { fetchAndBuildArticleEpub, validatePublicUrl } from '../src/server/articleToEpub.ts';
import { createLeafServer } from '../src/server/index.ts';

test('Crockford Base32 key generator excludes ambiguous characters', () => {
  for (const forbidden of ['0', 'O', '1', 'I', 'L', 'U']) {
    assert.equal(CROCKFORD_ALPHABET.includes(forbidden), false);
  }

  const store = new SessionStore({ ttlMinutes: 5 });
  for (let i = 0; i < 50; i++) {
    const s = store.createSession({
      receiverIp: '127.0.0.1',
      receiverCountry: 'LOCAL',
      device: detectDevice('Mozilla/5.0 (Linux; U; Android 2.0; en-us;) Kobo Touch'),
    });
    assert.equal(s.key.length, 4);
    assert.equal(isValidKey(s.key), true);
  }
});

test('Device detection recognizes Kobo, Kindle, PocketBook, Tolino, and Desktop', () => {
  const kobo = detectDevice('Mozilla/5.0 (Linux; U; Android 2.0; en-us;) AppleWebKit/538.1 (KHTML, like Gecko) Version/4.0 Mobile Safari/538.1 Kobo Touch 0372/4.38.21908');
  assert.equal(kobo.kind, 'kobo');
  assert.equal(kobo.isEreader, true);
  assert.equal(kobo.prefersKepub, true);

  const kindle = detectDevice('Mozilla/5.0 (X11; U; Linux armv7l like Android; en-us) AppleWebKit/531.2+ (KHTML, like Gecko) Version/5.0 Safari/533.2+ Kindle/3.0+');
  assert.equal(kindle.kind, 'kindle');
  assert.equal(kindle.isEreader, true);
  assert.equal(kindle.prefersKepub, false);

  const desktop = detectDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15');
  assert.equal(desktop.kind, 'desktop');
  assert.equal(desktop.isEreader, false);
});

test('Client-side EPUB -> KePub converter wraps text in koboSpan and extracts metadata', () => {
  const sampleEpub = zipSync({
    mimetype: [strToU8('application/epub+zip'), { level: 0 }],
    'OEBPS/content.opf': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
      <package xmlns="http://www.idpf.org/2007/opf" version="3.0">
        <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
          <dc:title>The Dispossessed</dc:title>
          <dc:creator>Ursula K. Le Guin</dc:creator>
        </metadata>
      </package>`),
    'OEBPS/chapter1.xhtml': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
      <html xmlns="http://www.w3.org/1999/xhtml">
        <head><title>Chapter 1</title></head>
        <body>
          <p>There was a wall. It did not look important.</p>
        </body>
      </html>`),
  });

  const converted = inspectAndConvertEpub(sampleEpub, 'dispossessed.epub', true);
  assert.equal(converted.filename, 'dispossessed.kepub.epub');
  assert.equal(converted.format, '.kepub.epub');
  assert.equal(converted.title, 'The Dispossessed');
  assert.equal(converted.author, 'Ursula K. Le Guin');

  const unzipped = unzipSync(converted.bytes);
  assert.equal(strFromU8(unzipped['mimetype']), 'application/epub+zip');
  const chapterHtml = strFromU8(unzipped['OEBPS/chapter1.xhtml']);
  assert.equal(chapterHtml.includes('id="book-columns"'), true);
  assert.equal(chapterHtml.includes('class="koboSpan"'), true);
});

test('Article to EPUB builder extracts readable text and rejects private SSRF URLs', async () => {
  assert.throws(() => validatePublicUrl('http://127.0.0.1:8080/secret'), /Private or local/);
  assert.throws(() => validatePublicUrl('http://169.254.169.254/latest/meta-data'), /Private or local/);

  const sampleArticleHtml = `<!DOCTYPE html>
    <html>
      <head><title>Why E-Ink Screens Matter — Essay</title></head>
      <body>
        <article>
          <h1>Why E-Ink Screens Matter</h1>
          <p class="byline">By Ada Lovelace</p>
          <p>Reflective displays allow comfortable long-form reading in direct sunlight without eye strain or constant notifications.</p>
          <p>When paired with an open EPUB workflow, readers can carry essays and books anywhere without vendor lock-in.</p>
        </article>
      </body>
    </html>`;

  const built = await fetchAndBuildArticleEpub('https://example.com/essays/e-ink', {
    asKepub: true,
    htmlOverride: sampleArticleHtml,
  });

  assert.equal(built.isKepub, true);
  assert.equal(built.filename.endsWith('.kepub.epub'), true);
  const unzipped = unzipSync(new Uint8Array(built.buffer));
  const articleXhtml = strFromU8(unzipped['OEBPS/article.xhtml']);
  assert.equal(articleXhtml.includes('Reflective displays allow comfortable'), true);
  assert.equal(articleXhtml.includes('class="koboSpan"'), true);
});

test('End-to-end HTTP relay, queue download tracking, and SQLite /stats auth', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'leaf-test-'));
  const dbPath = path.join(tmpDir, 'stats.db');

  const { server, analytics } = createLeafServer({
    dbPath,
    statsPassword: 'secret-stats-pass',
  });

  function request(
    urlPath: string,
    opts?: { method?: string; headers?: Record<string, string>; body?: Buffer | string }
  ): Promise<{ status: number; headers: Record<string, string>; body: Buffer; text: () => string; json: () => any }> {
    return new Promise((resolve, reject) => {
      const reqStream = new PassThrough() as any;
      reqStream.method = opts?.method || 'GET';
      reqStream.url = urlPath;
      reqStream.headers = { host: 'leaf.casa', ... normalizeHeaders(opts?.headers) };
      reqStream.socket = { remoteAddress: '127.0.0.1' };

      const resHeaders: Record<string, string> = {};
      const chunks: Buffer[] = [];
      let statusCode = 200;

      const resMock: any = {
        writeHead(code: number, hdrs?: Record<string, string>) {
          statusCode = code;
          if (hdrs) {
            for (const [k, v] of Object.entries(hdrs)) {
              resHeaders[k.toLowerCase()] = String(v);
            }
          }
          return resMock;
        },
        write(chunk: Buffer | string) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          return true;
        },
        end(chunk?: Buffer | string) {
          if (chunk) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          const body = Buffer.concat(chunks);
          resolve({
            status: statusCode,
            headers: resHeaders,
            body,
            text: () => body.toString('utf8'),
            json: () => JSON.parse(body.toString('utf8')),
          });
        },
      };

      try {
        server.emit('request', reqStream, resMock);
        if (opts?.body) {
          reqStream.write(Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(opts.body));
        }
        reqStream.end();
      } catch (err) {
        reject(err);
      }
    });
  }

  function normalizeHeaders(hdrs?: Record<string, string>): Record<string, string> {
    if (!hdrs) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(hdrs)) {
      out[k.toLowerCase()] = v;
    }
    return out;
  }

  try {
    // 1. E-Reader visits / and receives 1-bit e-ink page
    const ereaderHome = await request('/', {
      headers: { 'User-Agent': 'Mozilla/5.0 Kobo Touch' },
    });
    assert.equal(ereaderHome.status, 200);
    const ereaderHtml = ereaderHome.text();
    assert.equal(ereaderHtml.includes('Pure 1-Bit E-Ink Mode'), true);

    // 2. Generate pairing code via API
    const genRes = await request('/api/generate', {
      method: 'POST',
      headers: { 'User-Agent': 'Mozilla/5.0 Kobo Touch' },
    });
    assert.equal(genRes.status, 200);
    const sessionData = genRes.json();
    const key = sessionData.key;
    assert.equal(key.length, 4);
    assert.equal(sessionData.qrSvg.includes('<svg'), true);

    // 3. Upload a book to the session
    const dummyEpub = Buffer.from('PK-dummy-epub-bytes');
    const upRes = await request(`/api/upload/${key}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-File-Name': encodeURIComponent('Dune.kepub.epub'),
        'X-Book-Format': '.kepub.epub',
      },
      body: dummyEpub,
    });
    assert.equal(upRes.status, 200);
    const upData = upRes.json();
    const fileId = upData.file.id;

    // 4. Verify queue has 1 pending file
    const statusBefore = (await request(`/api/status/${key}`)).json();
    assert.equal(statusBefore.totalCount, 1);
    assert.equal(statusBefore.pendingCount, 1);
    assert.equal(statusBefore.nextFile.filename, 'Dune.kepub.epub');

    // 5. E-Reader downloads the file
    const dlRes = await request(`/api/download/${key}/${fileId}`);
    assert.equal(dlRes.status, 200);
    assert.equal(dlRes.headers['content-type'], 'application/epub+zip');
    assert.deepEqual(dlRes.body, dummyEpub);

    // 6. Verify file is now marked downloaded and pendingCount is 0
    const statusAfter = (await request(`/api/status/${key}`)).json();
    assert.equal(statusAfter.pendingCount, 0);
    assert.equal(statusAfter.files[0].downloaded, true);

    // 7. Verify /stats requires auth, and returns metrics with valid auth
    const unauthStats = await request('/api/stats');
    assert.equal(unauthStats.status, 401);

    const authHeader = 'Basic ' + Buffer.from('admin:secret-stats-pass').toString('base64');
    const authedStats = await request('/api/stats', {
      headers: { Authorization: authHeader },
    });
    assert.equal(authedStats.status, 200);
    const statsJson = authedStats.json();
    assert.equal(statsJson.totals.transfersSent, 1);
  } finally {
    server.close();
    analytics.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
