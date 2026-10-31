import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import { zipSync, strToU8 } from 'fflate';
import { sanitizeFilename } from './sessionStore.ts';

const MAX_ARTICLE_HTML_BYTES = 5 * 1024 * 1024; // 5 MB max article HTML
const MAX_REDIRECT_HOPS = 3;

export interface ArticleEpubResult {
  title: string;
  author: string;
  siteName: string;
  filename: string;
  buffer: Buffer;
  isKepub: boolean;
}

const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /\.localhost$/i,
  /\.local$/i,
  /\.internal$/i,
  /\.lan$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^100\.(6[4-9]|[7-9][0-9]|1[0-1][0-9]|12[0-7])\./,
  /^0\./,
  /^\[?::1\]?$/,
  /^\[?::\]?$/,
  /^\[?fe80:/i,
  /^\[?fc00:/i,
  /^\[?fd00:/i,
];

export function isPrivateIpAddress(ipRaw: string): boolean {
  const ip = ipRaw.replace(/^\[|\]$/g, '').replace(/^::ffff:/i, '');
  for (const pattern of PRIVATE_HOST_PATTERNS) {
    if (pattern.test(ip)) return true;
  }
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    if (parts[0] === 127 || parts[0] === 10 || parts[0] === 0) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
    if (parts[0] >= 224) return true; // Multicast & reserved
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (
      lower === '::1' ||
      lower === '::' ||
      lower.startsWith('fe80:') ||
      lower.startsWith('fc') ||
      lower.startsWith('fd') ||
      lower.startsWith('ff')
    ) {
      return true;
    }
  }
  return false;
}

export function validatePublicUrl(rawUrl: string): URL {
  if (rawUrl.length > 2048) {
    throw new Error('Article URL is too long.');
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new Error('Invalid article URL.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only HTTP and HTTPS article URLs are supported.');
  }

  if (parsed.username || parsed.password) {
    throw new Error('URLs with embedded credentials are not allowed.');
  }

  const host = parsed.hostname;
  for (const pattern of PRIVATE_HOST_PATTERNS) {
    if (pattern.test(host)) {
      throw new Error('Private or local network URLs are not allowed.');
    }
  }

  // Block single-label internal Docker/intranet hostnames (e.g. http://lynto-admin:3000)
  if (!host.includes('.')) {
    throw new Error('Private or local network URLs are not allowed.');
  }

  if (net.isIP(host.replace(/^\[|\]$/g, '')) && isPrivateIpAddress(host)) {
    throw new Error('Private or local network URLs are not allowed.');
  }

  return parsed;
}

async function assertHostnameResolvesToPublicIp(hostname: string): Promise<void> {
  const cleanHost = hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(cleanHost)) {
    if (isPrivateIpAddress(cleanHost)) {
      throw new Error('Private or local network URLs are not allowed.');
    }
    return;
  }

  const records = await dns.lookup(cleanHost, { all: true });
  if (!records || records.length === 0) {
    throw new Error('Could not resolve article hostname.');
  }

  for (const rec of records) {
    if (isPrivateIpAddress(rec.address)) {
      throw new Error('Article hostname resolves to a private or local network IP.');
    }
  }
}

async function fetchPublicHtmlSafely(initialUrl: URL): Promise<{ html: string; finalUrl: URL }> {
  let currentUrl = initialUrl;

  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    await assertHostnameResolvesToPublicIp(currentUrl.hostname);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);

    try {
      const response = await fetch(currentUrl.toString(), {
        signal: controller.signal,
        redirect: 'manual',
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; LeafReader/1.0; +https://leaf.casa)',
          Accept: 'text/html,application/xhtml+xml',
        },
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) {
          throw new Error('Redirect response missing Location header.');
        }
        const nextUrl = new URL(location, currentUrl);
        currentUrl = validatePublicUrl(nextUrl.toString());
        continue;
      }

      if (!response.ok) {
        throw new Error(`Upstream returned HTTP ${response.status}`);
      }

      const contentType = (response.headers.get('content-type') || '').toLowerCase();
      if (
        contentType &&
        !contentType.includes('text/html') &&
        !contentType.includes('application/xhtml+xml') &&
        !contentType.includes('text/plain')
      ) {
        throw new Error('URL does not point to an HTML web page.');
      }

      const contentLength = Number(response.headers.get('content-length') || 0);
      if (contentLength > MAX_ARTICLE_HTML_BYTES) {
        throw new Error('Article page is too large (exceeds 5 MB limit).');
      }

      if (!response.body) {
        throw new Error('Empty response from article URL.');
      }

      const chunks: Uint8Array[] = [];
      let received = 0;
      const reader = response.body.getReader();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          received += value.byteLength;
          if (received > MAX_ARTICLE_HTML_BYTES) {
            await reader.cancel();
            throw new Error('Article page is too large (exceeds 5 MB limit).');
          }
          chunks.push(value);
        }
      }

      const html = Buffer.concat(chunks).toString('utf8');
      return { html, finalUrl: currentUrl };
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error('Too many redirects while fetching article.');
}

export async function fetchAndBuildArticleEpub(
  rawUrl: string,
  options?: { asKepub?: boolean; htmlOverride?: string }
): Promise<ArticleEpubResult> {
  let url = validatePublicUrl(rawUrl);
  const asKepub = Boolean(options?.asKepub);

  let html = options?.htmlOverride;
  if (!html) {
    const fetched = await fetchPublicHtmlSafely(url);
    html = fetched.html;
    url = fetched.finalUrl;
  }

  const { document } = parseHTML(html);

  // Resolve relative links and strip unsafe elements
  const baseHref = url.origin;
  for (const el of Array.from(document.querySelectorAll('script, style, iframe, object, embed, form, svg, canvas'))) {
    el.remove();
  }
  for (const img of Array.from(document.querySelectorAll('img'))) {
    // Strip external images so the EPUB works offline on e-readers without broken image boxes
    img.remove();
  }
  for (const a of Array.from(document.querySelectorAll('a'))) {
    const href = a.getAttribute('href');
    if (href && href.startsWith('/')) {
      a.setAttribute('href', baseHref + href);
    }
  }

  const reader = new Readability(document as unknown as Document);
  const parsed = reader.parse();

  if (!parsed || !parsed.content || parsed.content.trim().length < 40) {
    throw new Error('Could not extract readable article text from this URL.');
  }

  const title = (parsed.title || url.hostname).trim();
  const author = (parsed.byline || parsed.siteName || url.hostname).trim();
  const siteName = (parsed.siteName || url.hostname).trim();

  const cleanXhtmlBody = sanitizeAndFormatXhtml(parsed.content, asKepub);
  const bookUuid = crypto.randomUUID();
  const pubDate = new Date().toISOString().slice(0, 10);

  const epubBytes = buildEpubArchive({
    uuid: bookUuid,
    title,
    author,
    siteName,
    sourceUrl: url.toString(),
    pubDate,
    bodyHtml: cleanXhtmlBody,
    asKepub,
  });

  const slug = sanitizeFilename(title)
    .replace(/\.[^.]+$/, '')
    .slice(0, 80)
    .trim() || 'Article';

  const ext = asKepub ? '.kepub.epub' : '.epub';

  return {
    title,
    author,
    siteName,
    filename: `${slug}${ext}`,
    buffer: Buffer.from(epubBytes),
    isKepub: asKepub,
  };
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function sanitizeAndFormatXhtml(rawHtml: string, asKepub: boolean): string {
  const { document } = parseHTML(`<!DOCTYPE html><html><body>${rawHtml}</body></html>`);
  const allowedTags = new Set([
    'p',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'blockquote',
    'ul',
    'ol',
    'li',
    'pre',
    'code',
    'em',
    'strong',
    'b',
    'i',
    'u',
    's',
    'sub',
    'sup',
    'a',
    'br',
    'hr',
    'figure',
    'figcaption',
    'table',
    'thead',
    'tbody',
    'tr',
    'th',
    'td',
    'div',
    'section',
    'article',
    'span',
  ]);

  let paragraphCounter = 0;

  function renderNode(node: any): string {
    if (node.nodeType === 3) {
      const text = String(node.nodeValue || '');
      if (!asKepub || !text.trim()) {
        return escapeXml(text);
      }
      paragraphCounter++;
      const sentences = splitSentences(text);
      return sentences
        .map((seg, idx) => `<span class="koboSpan" id="kobo.${paragraphCounter}.${idx + 1}">${escapeXml(seg)}</span>`)
        .join('');
    }

    if (node.nodeType !== 1) return '';

    const tag = String(node.tagName || '').toLowerCase();
    if (!allowedTags.has(tag)) {
      return Array.from(node.childNodes || []).map(renderNode).join('');
    }

    if (tag === 'br') return '<br />';
    if (tag === 'hr') return '<hr />';

    let attrs = '';
    if (tag === 'a') {
      const href = node.getAttribute?.('href');
      if (href && /^https?:\/\//i.test(href)) {
        attrs = ` href="${escapeXml(href)}"`;
      }
    }

    const inner = Array.from(node.childNodes || []).map(renderNode).join('');
    return `<${tag}${attrs}>${inner}</${tag}>`;
  }

  return Array.from(document.body.childNodes || []).map(renderNode).join('\n');
}

function splitSentences(text: string): string[] {
  const parts = text.match(/[^.!?]+[.!?]*\s*/g);
  return parts && parts.length > 0 ? parts : [text];
}

function buildEpubArchive(params: {
  uuid: string;
  title: string;
  author: string;
  siteName: string;
  sourceUrl: string;
  pubDate: string;
  bodyHtml: string;
  asKepub: boolean;
}): Uint8Array {
  const containerXml = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

  const styleCss = `body {
  font-family: Georgia, serif;
  line-height: 1.6;
  margin: 1.2em;
}
h1, h2, h3, h4 {
  line-height: 1.25;
  margin-top: 1.4em;
  margin-bottom: 0.5em;
}
.article-meta {
  font-size: 0.9em;
  border-bottom: 1px solid #000;
  padding-bottom: 0.8em;
  margin-bottom: 1.5em;
}
blockquote {
  margin-left: 1em;
  padding-left: 0.8em;
  border-left: 2px solid #000;
  font-style: italic;
}
pre, code {
  font-family: monospace;
  font-size: 0.9em;
}
${params.asKepub ? '.koboSpan { -webkit-text-combine: inherit; }\n#book-inner { margin-top: 0; margin-bottom: 0; }' : ''}`;

  const articleXhtml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="en">
<head>
  <meta charset="UTF-8" />
  <title>${escapeXml(params.title)}</title>
  <link rel="stylesheet" type="text/css" href="style.css" />
</head>
<body>
  ${params.asKepub ? '<div id="book-columns"><div id="book-inner">' : ''}
  <header class="article-meta">
    <h1>${escapeXml(params.title)}</h1>
    <p><strong>${escapeXml(params.author)}</strong> · ${escapeXml(params.siteName)} · ${escapeXml(params.pubDate)}</p>
    <p><small>${escapeXml(params.sourceUrl)}</small></p>
  </header>
  <main>
    ${params.bodyHtml}
  </main>
  ${params.asKepub ? '</div></div>' : ''}
</body>
</html>`;

  const navXhtml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Table of Contents</title>
</head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>Contents</h1>
    <ol>
      <li><a href="article.xhtml">${escapeXml(params.title)}</a></li>
    </ol>
  </nav>
</body>
</html>`;

  const tocNcx = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="urn:uuid:${params.uuid}"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>${escapeXml(params.title)}</text></docTitle>
  <navMap>
    <navPoint id="navPoint-1" playOrder="1">
      <navLabel><text>${escapeXml(params.title)}</text></navLabel>
      <content src="article.xhtml"/>
    </navPoint>
  </navMap>
</ncx>`;

  const contentOpf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="BookId">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="BookId">urn:uuid:${params.uuid}</dc:identifier>
    <dc:title>${escapeXml(params.title)}</dc:title>
    <dc:creator>${escapeXml(params.author)}</dc:creator>
    <dc:publisher>${escapeXml(params.siteName)}</dc:publisher>
    <dc:date>${escapeXml(params.pubDate)}</dc:date>
    <dc:language>en</dc:language>
    <meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="css" href="style.css" media-type="text/css"/>
    <item id="article" href="article.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="article"/>
  </spine>
</package>`;

  return zipSync({
    mimetype: [strToU8('application/epub+zip'), { level: 0 }],
    'META-INF/container.xml': strToU8(containerXml),
    'OEBPS/style.css': strToU8(styleCss),
    'OEBPS/article.xhtml': strToU8(articleXhtml),
    'OEBPS/nav.xhtml': strToU8(navXhtml),
    'OEBPS/toc.ncx': strToU8(tocNcx),
    'OEBPS/content.opf': strToU8(contentOpf),
  });
}
