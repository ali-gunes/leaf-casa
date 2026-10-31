import crypto from 'node:crypto';
import { unzipSync } from 'fflate';
import { parseHTML } from 'linkedom';

export interface MobiConversionResult {
  buffer: Buffer;
  filename: string;
  title?: string;
  author?: string;
}

const PALMDOC_RECORD_SIZE = 4096;

function decodeUtf8(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('utf8');
}

function resolveRelativePath(baseFilePath: string, relativeHref: string): string {
  const cleanHref = relativeHref.split('#')[0].split('?')[0];
  const baseParts = baseFilePath.split('/');
  baseParts.pop(); // remove filename

  for (const part of cleanHref.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      baseParts.pop();
    } else {
      baseParts.push(part);
    }
  }
  return baseParts.join('/');
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Cleans chapter HTML into lightweight Mobipocket-compatible markup.
 */
function sanitizeChapterHtmlForMobi(rawHtml: string): string {
  try {
    const { document } = parseHTML(rawHtml);

    const removeSelectors = ['script', 'style', 'head', 'svg', 'iframe', 'object', 'embed', 'noscript', 'img', 'image'];
    for (const sel of removeSelectors) {
      const nodes = document.querySelectorAll(sel);
      for (const node of Array.from(nodes)) {
        node.remove();
      }
    }

    const body = document.querySelector('body') || document.documentElement;
    if (!body) return '';

    const html = body.innerHTML.trim();
    return html;
  } catch {
    return '';
  }
}

/**
 * Splits UTF-8 HTML content into <= 4096-byte PalmDOC records without splitting
 * multi-byte UTF-8 characters across record boundaries (pads with ASCII spaces).
 */
function splitIntoPalmDocRecords(htmlUtf8: Buffer): Buffer[] {
  if (htmlUtf8.byteLength === 0) {
    return [Buffer.from('<p></p>', 'utf8')];
  }

  const records: Buffer[] = [];
  let offset = 0;

  while (offset < htmlUtf8.byteLength) {
    const remaining = htmlUtf8.byteLength - offset;
    if (remaining <= PALMDOC_RECORD_SIZE) {
      records.push(htmlUtf8.subarray(offset));
      break;
    }

    let sliceLen = PALMDOC_RECORD_SIZE;
    // If byte at offset + sliceLen is a UTF-8 continuation byte (10xxxxxx),
    // walk back to the start of the multi-byte sequence and pad with spaces
    while (sliceLen > 0 && (htmlUtf8[offset + sliceLen] & 0xc0) === 0x80) {
      sliceLen--;
    }

    if (sliceLen === 0) {
      sliceLen = PALMDOC_RECORD_SIZE;
    }

    const chunk = Buffer.alloc(PALMDOC_RECORD_SIZE, 0x20); // fill trailing gap with spaces
    htmlUtf8.copy(chunk, 0, offset, offset + sliceLen);
    records.push(chunk);
    offset += sliceLen;
  }

  return records;
}

/**
 * Builds an EXTH header block containing Author (100) and Updated Title (503),
 * padded to a 4-byte boundary as required by the MOBI specification.
 */
function buildExthHeader(title: string, author: string): Buffer {
  const records: Array<{ type: number; data: Buffer }> = [
    { type: 100, data: Buffer.from(author || 'Unknown Author', 'utf8') },
    { type: 503, data: Buffer.from(title || 'Untitled Book', 'utf8') },
  ];

  let rawLen = 12; // 'EXTH' (4) + length (4) + count (4)
  for (const r of records) {
    rawLen += 8 + r.data.byteLength;
  }

  const paddedLen = Math.ceil(rawLen / 4) * 4;
  const buf = Buffer.alloc(paddedLen, 0);

  buf.write('EXTH', 0, 'ascii');
  buf.writeUInt32BE(rawLen, 4);
  buf.writeUInt32BE(records.length, 8);

  let pos = 12;
  for (const r of records) {
    buf.writeUInt32BE(r.type, pos);
    buf.writeUInt32BE(8 + r.data.byteLength, pos + 4);
    r.data.copy(buf, pos + 8);
    pos += 8 + r.data.byteLength;
  }

  return buf;
}

/**
 * Converts an EPUB archive Buffer into a Mobipocket (.mobi) binary Buffer
 * compatible with Kindle's Experimental Web Browser and native reader.
 */
export function convertEpubBufferToMobi(
  epubBuffer: Buffer,
  originalFilename = 'book.epub'
): MobiConversionResult {
  const entries = unzipSync(new Uint8Array(epubBuffer));
  const fileMap = new Map<string, Uint8Array>();
  for (const [entryPath, data] of Object.entries(entries)) {
    fileMap.set(entryPath, data);
  }

  // Locate OPF package file via META-INF/container.xml or .opf extension
  let opfPath = '';
  const containerBytes = fileMap.get('META-INF/container.xml') || fileMap.get('meta-inf/container.xml');
  if (containerBytes) {
    try {
      const { document } = parseHTML(decodeUtf8(containerBytes));
      const rootfile = document.querySelector('rootfile');
      const fullPath = rootfile?.getAttribute('full-path');
      if (fullPath && fileMap.has(fullPath)) {
        opfPath = fullPath;
      }
    } catch {
      // Fallback below
    }
  }

  if (!opfPath) {
    for (const key of fileMap.keys()) {
      if (key.toLowerCase().endsWith('.opf')) {
        opfPath = key;
        break;
      }
    }
  }

  let title = '';
  let author = '';
  const chapterFiles: string[] = [];

  if (opfPath && fileMap.has(opfPath)) {
    try {
      const opfXml = decodeUtf8(fileMap.get(opfPath)!);
      const { document } = parseHTML(opfXml);

      const titleEl = document.querySelector('dc\\:title, title');
      const creatorEl = document.querySelector('dc\\:creator, creator');
      if (titleEl?.textContent) title = titleEl.textContent.trim();
      if (creatorEl?.textContent) author = creatorEl.textContent.trim();

      const manifestById = new Map<string, string>();
      const items = document.querySelectorAll('manifest > item, item');
      for (const item of Array.from(items)) {
        const id = item.getAttribute('id');
        const href = item.getAttribute('href');
        const mediaType = (item.getAttribute('media-type') || '').toLowerCase();
        if (
          id &&
          href &&
          (mediaType.includes('html') ||
            href.toLowerCase().endsWith('.xhtml') ||
            href.toLowerCase().endsWith('.html') ||
            href.toLowerCase().endsWith('.htm'))
        ) {
          manifestById.set(id, resolveRelativePath(opfPath, href));
        }
      }

      const itemrefs = document.querySelectorAll('spine > itemref, itemref');
      for (const ref of Array.from(itemrefs)) {
        const idref = ref.getAttribute('idref');
        if (idref && manifestById.has(idref)) {
          chapterFiles.push(manifestById.get(idref)!);
        }
      }

      if (chapterFiles.length === 0) {
        for (const resolvedPath of manifestById.values()) {
          chapterFiles.push(resolvedPath);
        }
      }
    } catch {
      // Fallback to scanning HTML entries below
    }
  }

  if (chapterFiles.length === 0) {
    for (const key of fileMap.keys()) {
      const lower = key.toLowerCase();
      if (
        (lower.endsWith('.xhtml') || lower.endsWith('.html') || lower.endsWith('.htm')) &&
        !lower.includes('nav.') &&
        !lower.includes('toc.')
      ) {
        chapterFiles.push(key);
      }
    }
  }

  const baseName = originalFilename
    .replace(/\.kepub\.epub$/i, '')
    .replace(/\.epub$/i, '')
    .trim();

  if (!title) title = baseName || 'Untitled Book';
  if (!author) author = 'Leaf Relay';

  const renderedChapters: string[] = [];
  for (const chapterPath of chapterFiles) {
    const bytes = fileMap.get(chapterPath);
    if (!bytes) continue;
    const cleaned = sanitizeChapterHtmlForMobi(decodeUtf8(bytes));
    if (cleaned) {
      renderedChapters.push(cleaned);
    }
  }

  if (renderedChapters.length === 0) {
    renderedChapters.push(`<h1>${escapeHtml(title)}</h1><p>Converted by Leaf for Kindle.</p>`);
  }

  const fullHtml =
    `<html><head><title>${escapeHtml(title)}</title></head><body>` +
    renderedChapters.join('<mbp:pagebreak/>') +
    `</body></html>`;

  const htmlUtf8 = Buffer.from(fullHtml, 'utf8');
  const textRecords = splitIntoPalmDocRecords(htmlUtf8);
  const textRecordCount = textRecords.length;
  const totalTextBytes = textRecords.reduce((sum, r) => sum + r.byteLength, 0);

  // Build Record 0: 16-byte PalmDOC Header + 232-byte MOBI Header + EXTH Header + Full Title
  const exthBuf = buildExthHeader(title, author);
  const titleUtf8 = Buffer.from(title, 'utf8');
  const titlePaddedLen = Math.ceil((titleUtf8.byteLength + 2) / 4) * 4;

  const mobiHeaderLen = 232;
  const fullNameOffset = 16 + mobiHeaderLen + exthBuf.byteLength;
  const record0Len = fullNameOffset + titlePaddedLen;
  const record0 = Buffer.alloc(record0Len, 0);

  // 1. PalmDOC Header (bytes 0..15)
  record0.writeUInt16BE(1, 0); // Compression: 1 = uncompressed
  record0.writeUInt16BE(0, 2); // Unused
  record0.writeUInt32BE(totalTextBytes, 4); // Uncompressed text length
  record0.writeUInt16BE(textRecordCount, 8); // Number of text records
  record0.writeUInt16BE(PALMDOC_RECORD_SIZE, 10); // Record size (4096)
  record0.writeUInt16BE(0, 12); // Encryption: 0 = none
  record0.writeUInt16BE(0, 14); // Unknown

  // 2. MOBI Header (bytes 16..247)
  record0.write('MOBI', 16, 'ascii');
  record0.writeUInt32BE(mobiHeaderLen, 20); // Header length: 232
  record0.writeUInt32BE(2, 24); // Mobi type: 2 = book
  record0.writeUInt32BE(65001, 28); // Text encoding: 65001 = UTF-8
  record0.writeUInt32BE(crypto.randomBytes(4).readUInt32BE(0), 32); // Unique ID
  record0.writeUInt32BE(6, 36); // File version: 6

  // Unused index pointers (bytes 40..79) -> 0xFFFFFFFF
  for (let off = 40; off < 80; off += 4) {
    record0.writeUInt32BE(0xffffffff, off);
  }

  record0.writeUInt32BE(textRecordCount + 1, 80); // First non-book record index (EOF record)
  record0.writeUInt32BE(fullNameOffset, 84); // Full Name Offset inside Record 0
  record0.writeUInt32BE(titleUtf8.byteLength, 88); // Full Name Length
  record0.writeUInt32BE(0x09, 92); // Locale: 9 (English / neutral)
  record0.writeUInt32BE(0, 96); // Input language
  record0.writeUInt32BE(0, 100); // Output language
  record0.writeUInt32BE(6, 104); // Min version: 6
  record0.writeUInt32BE(0xffffffff, 108); // First Image index: none
  record0.writeUInt32BE(0, 112); // Huffman Record Offset
  record0.writeUInt32BE(0, 116); // Huffman Record Count
  record0.writeUInt32BE(0, 120); // Huffman Table Offset
  record0.writeUInt32BE(0, 124); // Huffman Table Length
  record0.writeUInt32BE(0x40, 128); // EXTH flags: bit 6 (0x40) present

  record0.writeUInt32BE(0xffffffff, 164);
  record0.writeUInt32BE(0xffffffff, 168); // DRM Offset: none
  record0.writeUInt32BE(0xffffffff, 172); // DRM Count: none
  record0.writeUInt32BE(0, 176); // DRM Size
  record0.writeUInt32BE(0, 180); // DRM Flags

  record0.writeUInt16BE(1, 192); // First content record number
  record0.writeUInt16BE(textRecordCount, 194); // Last content record number
  record0.writeUInt32BE(1, 196); // Unknown = 1
  record0.writeUInt32BE(0xffffffff, 200); // FCIS record number
  record0.writeUInt32BE(0, 204);
  record0.writeUInt32BE(0xffffffff, 208); // FLIS record number
  record0.writeUInt32BE(0, 212);
  record0.writeUInt32BE(0xffffffff, 224);
  record0.writeUInt32BE(0, 228);
  record0.writeUInt32BE(0xffffffff, 232);
  record0.writeUInt32BE(0xffffffff, 236);
  record0.writeUInt32BE(0, 240); // Extra Record Data Flags
  record0.writeUInt32BE(0xffffffff, 244); // INDX Record Offset

  // 3. Copy EXTH Header and Full Title into Record 0
  exthBuf.copy(record0, 16 + mobiHeaderLen);
  titleUtf8.copy(record0, fullNameOffset);

  // Final EOF Record required by Mobipocket readers
  const eofRecord = Buffer.from([0xe9, 0x8e, 0x0d, 0x0a]);
  const allRecords = [record0, ...textRecords, eofRecord];
  const totalRecordCount = allRecords.length;

  // Build 78-byte PalmDB Header + (totalRecordCount * 8) Record Info List + 2-byte gap
  const pdbHeaderLen = 78 + totalRecordCount * 8 + 2;
  const pdbHeader = Buffer.alloc(pdbHeaderLen, 0);

  const safeDbName = title
    .replace(/[^\x20-\x7E]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 31);
  pdbHeader.write(safeDbName || 'Leaf_Book', 0, 'ascii');

  const nowSeconds = Math.floor(Date.now() / 1000);
  pdbHeader.writeUInt16BE(0, 32); // Attributes
  pdbHeader.writeUInt16BE(0, 34); // Version
  pdbHeader.writeUInt32BE(nowSeconds, 36); // Creation date
  pdbHeader.writeUInt32BE(nowSeconds, 40); // Modification date
  pdbHeader.write('BOOK', 60, 'ascii'); // Database Type
  pdbHeader.write('MOBI', 64, 'ascii'); // Creator ID
  pdbHeader.writeUInt32BE(totalRecordCount + 1, 68); // Unique ID seed
  pdbHeader.writeUInt16BE(totalRecordCount, 76); // Number of records

  let currentOffset = pdbHeaderLen;
  for (let i = 0; i < totalRecordCount; i++) {
    const entryOffset = 78 + i * 8;
    pdbHeader.writeUInt32BE(currentOffset, entryOffset);
    pdbHeader.writeUInt8(0, entryOffset + 4); // Record attributes
    // 3-byte unique ID (2 * i)
    const uid = i * 2;
    pdbHeader.writeUInt8((uid >> 16) & 0xff, entryOffset + 5);
    pdbHeader.writeUInt8((uid >> 8) & 0xff, entryOffset + 6);
    pdbHeader.writeUInt8(uid & 0xff, entryOffset + 7);
    currentOffset += allRecords[i].byteLength;
  }

  const mobiBuffer = Buffer.concat([pdbHeader, ...allRecords]);
  const mobiFilename = `${baseName || 'book'}.mobi`;

  return {
    buffer: mobiBuffer,
    filename: mobiFilename,
    title,
    author,
  };
}
