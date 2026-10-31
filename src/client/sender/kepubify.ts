import { unzipSync, zipSync, strFromU8, strToU8, type Zippable } from 'fflate';

export interface ProcessedBook {
  bytes: Uint8Array;
  filename: string;
  title?: string;
  author?: string;
  format: '.kepub.epub' | '.epub';
}

const SKIP_PARENT_TAGS = new Set([
  'script',
  'style',
  'pre',
  'code',
  'svg',
  'math',
  'head',
  'title',
  'textarea',
]);

export function inspectAndConvertEpub(
  rawBytes: Uint8Array,
  originalFilename: string,
  convertToKepub: boolean
): ProcessedBook {
  const entries = unzipSync(rawBytes);

  let title: string | undefined;
  let author: string | undefined;

  // Locate OPF metadata
  for (const [entryPath, content] of Object.entries(entries)) {
    if (entryPath.toLowerCase().endsWith('.opf')) {
      const xml = strFromU8(content);
      const parsedMeta = extractOpfMetadata(xml);
      if (parsedMeta.title) title = parsedMeta.title;
      if (parsedMeta.author) author = parsedMeta.author;
      break;
    }
  }

  const baseName = originalFilename
    .replace(/\.kepub\.epub$/i, '')
    .replace(/\.epub$/i, '')
    .trim() || (title ? sanitizeClientFilename(title) : 'book');

  if (!convertToKepub) {
    return {
      bytes: rawBytes,
      filename: `${baseName}.epub`,
      title,
      author,
      format: '.epub',
    };
  }

  // Convert HTML/XHTML documents inside the EPUB into Kobo KePub format
  const zippable: Zippable = {};

  // Ensure mimetype is the first entry and stored uncompressed (level 0)
  if (entries['mimetype']) {
    zippable['mimetype'] = [entries['mimetype'], { level: 0 }];
  } else {
    zippable['mimetype'] = [strToU8('application/epub+zip'), { level: 0 }];
  }

  for (const [entryPath, content] of Object.entries(entries)) {
    if (entryPath === 'mimetype') continue;

    const lower = entryPath.toLowerCase();
    const isHtml =
      lower.endsWith('.xhtml') ||
      lower.endsWith('.html') ||
      lower.endsWith('.htm');
    const isNavDoc = lower.endsWith('nav.xhtml') || lower.endsWith('toc.xhtml');

    if (isHtml && !isNavDoc) {
      try {
        const sourceText = strFromU8(content);
        const transformed = transformHtmlToKepub(sourceText);
        zippable[entryPath] = strToU8(transformed);
      } catch {
        zippable[entryPath] = content;
      }
    } else {
      zippable[entryPath] = content;
    }
  }

  const kepubBytes = zipSync(zippable);
  return {
    bytes: kepubBytes,
    filename: `${baseName}.kepub.epub`,
    title,
    author,
    format: '.kepub.epub',
  };
}

export function extractOpfMetadata(opfXml: string): { title?: string; author?: string } {
  const titleMatch = opfXml.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i);
  const creatorMatch = opfXml.match(/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/i);

  return {
    title: titleMatch ? decodeXmlEntities(titleMatch[1].trim()) : undefined,
    author: creatorMatch ? decodeXmlEntities(creatorMatch[1].trim()) : undefined,
  };
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

export function transformHtmlToKepub(htmlContent: string): string {
  if (htmlContent.includes('class="koboSpan"') || htmlContent.includes('id="book-columns"')) {
    return htmlContent;
  }

  if (typeof DOMParser !== 'undefined' && typeof XMLSerializer !== 'undefined') {
    const isXml = htmlContent.trimStart().startsWith('<?xml') || htmlContent.includes('xmlns=');
    const parser = new DOMParser();
    const doc = parser.parseFromString(
      htmlContent,
      isXml ? 'application/xhtml+xml' : 'text/html'
    );

    const parserError = doc.querySelector('parsererror');
    if (!parserError && doc.body) {
      injectKoboStyles(doc);
      wrapBodyWithKoboColumns(doc);
      wrapTextNodesWithKoboSpans(doc, doc.body);
      const serializer = new XMLSerializer();
      return serializer.serializeToString(doc);
    }
  }

  // Fallback string-based injection if DOMParser is unavailable or strict XML fails
  return fallbackStringKepubify(htmlContent);
}

function injectKoboStyles(doc: Document): void {
  const head = doc.querySelector('head');
  if (!head) return;

  const styleEl = doc.createElementNS(doc.documentElement.namespaceURI || 'http://www.w3.org/1999/xhtml', 'style');
  styleEl.setAttribute('type', 'text/css');
  styleEl.textContent =
    'div#book-inner { margin-top: 0; margin-bottom: 0; } .koboSpan { -webkit-text-combine: inherit; }';
  head.appendChild(styleEl);
}

function wrapBodyWithKoboColumns(doc: Document): void {
  const body = doc.body;
  if (!body) return;

  const ns = doc.documentElement.namespaceURI || 'http://www.w3.org/1999/xhtml';
  const outer = doc.createElementNS(ns, 'div');
  outer.setAttribute('id', 'book-columns');

  const inner = doc.createElementNS(ns, 'div');
  inner.setAttribute('id', 'book-inner');

  while (body.firstChild) {
    inner.appendChild(body.firstChild);
  }

  outer.appendChild(inner);
  body.appendChild(outer);
}

function wrapTextNodesWithKoboSpans(doc: Document, root: Element): void {
  const ns = doc.documentElement.namespaceURI || 'http://www.w3.org/1999/xhtml';
  let paragraphIndex = 0;

  const textNodes: Text[] = [];
  function collectTextNodes(node: Node): void {
    if (node.nodeType === 3) {
      if (node.nodeValue && node.nodeValue.trim().length > 0) {
        textNodes.push(node as Text);
      }
      return;
    }
    if (node.nodeType === 1) {
      const el = node as Element;
      const tag = el.localName ? el.localName.toLowerCase() : el.tagName.toLowerCase();
      if (SKIP_PARENT_TAGS.has(tag) || el.classList?.contains('koboSpan')) {
        return;
      }
      for (let child = node.firstChild; child; child = child.nextSibling) {
        collectTextNodes(child);
      }
    }
  }

  collectTextNodes(root);

  for (const textNode of textNodes) {
    const raw = textNode.nodeValue || '';
    if (!raw.trim()) continue;

    paragraphIndex++;
    const sentences = raw.match(/[^.!?]+[.!?]*\s*/g) || [raw];
    const frag = doc.createDocumentFragment();

    for (let i = 0; i < sentences.length; i++) {
      const span = doc.createElementNS(ns, 'span');
      span.setAttribute('class', 'koboSpan');
      span.setAttribute('id', `kobo.${paragraphIndex}.${i + 1}`);
      span.textContent = sentences[i];
      frag.appendChild(span);
    }

    textNode.parentNode?.replaceChild(frag, textNode);
  }
}

function fallbackStringKepubify(html: string): string {
  let para = 0;
  const styleBlock =
    '<style type="text/css">div#book-inner{margin-top:0;margin-bottom:0;}.koboSpan{-webkit-text-combine:inherit;}</style>';

  let out = html.replace(/<\/head>/i, `${styleBlock}</head>`);
  out = out.replace(/<body([^>]*)>([\s\S]*?)<\/body>/i, (_match, attrs, bodyInner) => {
    const wrappedParagraphs = String(bodyInner).replace(
      /<(p|h[1-6]|li|blockquote)([^>]*)>([^<]+)<\/\1>/gi,
      (m, tag, tAttrs, textContent) => {
        if (!String(textContent).trim()) return m;
        para++;
        return `<${tag}${tAttrs}><span class="koboSpan" id="kobo.${para}.1">${textContent}</span></${tag}>`;
      }
    );
    return `<body${attrs}><div id="book-columns"><div id="book-inner">${wrappedParagraphs}</div></div></body>`;
  });
  return out;
}

function sanitizeClientFilename(name: string): string {
  return name.replace(/[/\\?%*:|"<>]/g, '_').trim() || 'book';
}
