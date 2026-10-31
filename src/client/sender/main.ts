import { inspectAndConvertEpub } from './kepubify.ts';

const CROCKFORD_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const MAX_CLIENT_FILE_BYTES = 100 * 1024 * 1024; // 100 MB

interface LocalQueueItem {
  localId: string;
  remoteId?: string;
  kind: 'file' | 'article';
  file?: File;
  articleUrl?: string;
  displayName: string;
  sizeBytes?: number;
  formatLabel: string;
  status: 'waiting' | 'converting' | 'uploading' | 'sent' | 'downloaded' | 'error';
  errorMessage?: string;
  elapsedMs?: number;
}

interface RemoteSessionStatus {
  key: string;
  device: {
    kind: string;
    label: string;
    isEreader: boolean;
    prefersKepub: boolean;
  };
  files: Array<{
    id: string;
    filename: string;
    downloaded: boolean;
  }>;
}

(function initSenderApp() {
  const slots = Array.from(document.querySelectorAll<HTMLInputElement>('.code-slot'));
  const connectionBar = document.getElementById('connection-bar');
  const connectionText = document.getElementById('connection-text');
  const kepubCheckbox = document.getElementById('kepub-toggle') as HTMLInputElement | null;
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('file-input') as HTMLInputElement | null;
  const windowOverlay = document.getElementById('window-drop-overlay');
  const articleForm = document.getElementById('article-form') as HTMLFormElement | null;
  const articleInput = document.getElementById('article-url-input') as HTMLInputElement | null;
  const articleSubmitBtn = document.getElementById('article-submit-btn') as HTMLButtonElement | null;
  const queueSection = document.getElementById('sender-queue-section');
  const queueList = document.getElementById('sender-queue-list');

  let connectedKey: string | null = null;
  let connectedDeviceKind: string | null = null;
  let userTouchedKepubToggle = false;
  let activeEventSource: EventSource | null = null;
  const queue: LocalQueueItem[] = [];
  let isProcessingQueue = false;

  if (kepubCheckbox) {
    kepubCheckbox.addEventListener('change', () => {
      userTouchedKepubToggle = true;
      if (connectedKey) {
        fetch(`/api/device/${encodeURIComponent(connectedKey)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prefersKepub: kepubCheckbox.checked }),
        }).catch(() => {});
      }
    });
  }

  function getEnteredCode(): string {
    return slots.map((s) => s.value.trim().toUpperCase()).join('');
  }

  function setSlotsFromCode(raw: string): void {
    const cleaned = raw
      .toUpperCase()
      .split('')
      .filter((ch) => CROCKFORD_ALPHABET.includes(ch))
      .slice(0, 4);

    slots.forEach((slot, idx) => {
      slot.value = cleaned[idx] || '';
    });

    if (cleaned.length === 4) {
      verifyAndConnectKey(cleaned.join(''));
    } else {
      setDisconnectedState();
    }
  }

  function setDisconnectedState(errorMsg?: string): void {
    connectedKey = null;
    connectedDeviceKind = null;
    if (activeEventSource) {
      activeEventSource.close();
      activeEventSource = null;
    }

    slots.forEach((s) => s.classList.remove('is-connected'));
    if (!connectionBar || !connectionText) return;

    connectionBar.classList.remove('is-connected', 'is-error');
    if (errorMsg) {
      connectionBar.classList.add('is-error');
      connectionText.textContent = errorMsg;
    } else {
      connectionText.textContent = 'Enter the 4-character code shown on your e-reader';
    }
  }

  async function verifyAndConnectKey(key: string): Promise<void> {
    if (key.length !== 4) {
      setDisconnectedState();
      return;
    }

    if (connectionText && connectionBar) {
      connectionBar.classList.remove('is-connected', 'is-error');
      connectionText.textContent = `Connecting to ${key}...`;
    }

    try {
      const res = await fetch(`/api/status/${encodeURIComponent(key)}`);
      if (!res.ok) {
        setDisconnectedState(`No active e-reader found with code ${key}`);
        return;
      }

      const data = (await res.json()) as RemoteSessionStatus;
      connectedKey = data.key;
      connectedDeviceKind = data.device?.kind || null;
      slots.forEach((s) => s.classList.add('is-connected'));

      if (kepubCheckbox && !userTouchedKepubToggle) {
        kepubCheckbox.checked = Boolean(data.device?.prefersKepub);
      }

      updateConnectedBadge(data);
      syncRemoteDownloadState(data);
      subscribeToSessionStream(data.key);

      // Immediately flush any queued files/articles ("Drop First, Type Second")
      processQueue();
    } catch {
      setDisconnectedState('Unable to reach server. Check your connection.');
    }
  }

  function updateConnectedBadge(data: RemoteSessionStatus): void {
    if (!connectionBar || !connectionText) return;
    connectionBar.classList.remove('is-error');
    connectionBar.classList.add('is-connected');

    const deviceLabel = data.device?.label || 'E-Reader';
    if (data.device?.kind === 'kindle') {
      connectionText.textContent = `Connected to ${deviceLabel} (EPUB → MOBI auto-enabled)`;
      return;
    }

    const kepubActive = kepubCheckbox ? kepubCheckbox.checked : Boolean(data.device?.prefersKepub);
    const suffix = kepubActive ? ' (KePub auto-enabled)' : '';
    connectionText.textContent = `Connected to ${deviceLabel}${suffix}`;
  }

  function subscribeToSessionStream(key: string): void {
    if (activeEventSource) {
      activeEventSource.close();
    }
    try {
      const es = new EventSource(`/api/stream/${encodeURIComponent(key)}`);
      activeEventSource = es;
      es.onmessage = (ev) => {
        try {
          const payload = JSON.parse(ev.data) as RemoteSessionStatus;
          syncRemoteDownloadState(payload);
        } catch {
          // Ignore malformed event
        }
      };
    } catch {
      // Ignore if EventSource fails
    }
  }

  function syncRemoteDownloadState(data: RemoteSessionStatus): void {
    if (!data.files) return;
    let changed = false;
    for (const remoteFile of data.files) {
      const match = queue.find((item) => item.remoteId === remoteFile.id);
      if (match && remoteFile.downloaded && match.status !== 'downloaded') {
        match.status = 'downloaded';
        changed = true;
      }
    }
    if (changed) {
      renderQueue();
    }
  }

  // Set up 4-slot segmented code input
  slots.forEach((slot, index) => {
    slot.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace') {
        if (slot.value === '' && index > 0) {
          e.preventDefault();
          slots[index - 1].value = '';
          slots[index - 1].focus();
          setDisconnectedState();
        } else {
          slot.value = '';
          setDisconnectedState();
        }
        return;
      }

      if (e.key === 'ArrowLeft' && index > 0) {
        e.preventDefault();
        slots[index - 1].focus();
        return;
      }

      if (e.key === 'ArrowRight' && index < slots.length - 1) {
        e.preventDefault();
        slots[index + 1].focus();
        return;
      }
    });

    slot.addEventListener('input', () => {
      const raw = slot.value.toUpperCase();
      if (raw.length > 1) {
        setSlotsFromCode(raw);
        const nextFocus = Math.min(slots.length - 1, getEnteredCode().length);
        slots[nextFocus]?.focus();
        return;
      }

      const ch = raw.charAt(0);
      if (!ch || !CROCKFORD_ALPHABET.includes(ch)) {
        slot.value = '';
        setDisconnectedState();
        return;
      }

      slot.value = ch;
      if (index < slots.length - 1) {
        slots[index + 1].focus();
      }

      const fullCode = getEnteredCode();
      if (fullCode.length === 4) {
        verifyAndConnectKey(fullCode);
      } else {
        setDisconnectedState();
      }
    });

    slot.addEventListener('paste', (e) => {
      e.preventDefault();
      const pasted = e.clipboardData?.getData('text') || '';
      setSlotsFromCode(pasted);
      const nextIdx = Math.min(slots.length - 1, getEnteredCode().length);
      slots[nextIdx]?.focus();
    });
  });

  // Auto-fill from ?key=XXXX or auto-focus slot 0 on load
  const urlParams = new URLSearchParams(window.location.search);
  const initialKey = urlParams.get('key') || (window as any).__LEAF_PREFILL_KEY__ || '';
  if (initialKey) {
    setSlotsFromCode(initialKey);
  } else if (slots[0]) {
    slots[0].focus();
  }

  // Queue Management
  function enqueueFiles(fileList: FileList | File[]): void {
    const files = Array.from(fileList);
    let added = 0;

    for (const file of files) {
      const lower = file.name.toLowerCase();
      const isSupported =
        lower.endsWith('.epub') ||
        lower.endsWith('.pdf') ||
        lower.endsWith('.mobi') ||
        lower.endsWith('.azw') ||
        lower.endsWith('.prc') ||
        lower.endsWith('.txt');

      if (!isSupported) {
        queue.unshift({
          localId: crypto.randomUUID(),
          kind: 'file',
          displayName: file.name,
          sizeBytes: file.size,
          formatLabel: 'Unsupported',
          status: 'error',
          errorMessage: 'Supported formats: .epub, .pdf, .mobi, .azw, .prc, .txt',
        });
        added++;
        continue;
      }

      if (connectedDeviceKind === 'kindle' && lower.endsWith('.pdf')) {
        queue.unshift({
          localId: crypto.randomUUID(),
          kind: 'file',
          displayName: file.name,
          sizeBytes: file.size,
          formatLabel: 'Kindle Restriction',
          status: 'error',
          errorMessage:
            "Kindle's built-in browser blocks .PDF downloads (only .MOBI, .AZW, .PRC, or .TXT are allowed). Upload an .EPUB, .MOBI, or .TXT instead.",
        });
        added++;
        continue;
      }

      if (file.size === 0) {
        queue.unshift({
          localId: crypto.randomUUID(),
          kind: 'file',
          displayName: file.name,
          sizeBytes: 0,
          formatLabel: 'Empty',
          status: 'error',
          errorMessage: 'File is empty (0 bytes)',
        });
        added++;
        continue;
      }

      if (file.size > MAX_CLIENT_FILE_BYTES) {
        queue.unshift({
          localId: crypto.randomUUID(),
          kind: 'file',
          displayName: file.name,
          sizeBytes: file.size,
          formatLabel: 'Too Large',
          status: 'error',
          errorMessage: 'File exceeds the 100 MB maximum size limit',
        });
        added++;
        continue;
      }

      const formatLabel = lower.endsWith('.pdf')
        ? 'PDF'
        : lower.endsWith('.mobi')
          ? 'MOBI'
          : lower.endsWith('.azw')
            ? 'AZW'
            : lower.endsWith('.prc')
              ? 'PRC'
              : lower.endsWith('.txt')
                ? 'TXT'
                : 'EPUB';

      queue.unshift({
        localId: crypto.randomUUID(),
        kind: 'file',
        file,
        displayName: file.name,
        sizeBytes: file.size,
        formatLabel,
        status: 'waiting',
      });
      added++;
    }

    if (added > 0) {
      renderQueue();
      processQueue();
    }
  }

  function enqueueArticleUrl(rawUrl: string): void {
    const trimmed = rawUrl.trim();
    if (!trimmed) return;

    queue.unshift({
      localId: crypto.randomUUID(),
      kind: 'article',
      articleUrl: trimmed,
      displayName: trimmed,
      formatLabel: 'Web Article',
      status: 'waiting',
    });

    renderQueue();
    processQueue();
  }

  async function processQueue(): Promise<void> {
    if (isProcessingQueue || !connectedKey) return;
    isProcessingQueue = true;

    try {
      while (connectedKey) {
        // Find oldest waiting item so uploads happen in the order added
        const nextItem = [...queue].reverse().find((i) => i.status === 'waiting');
        if (!nextItem) break;

        if (nextItem.kind === 'file' && nextItem.file) {
          await convertAndUploadFile(nextItem, connectedKey);
        } else if (nextItem.kind === 'article' && nextItem.articleUrl) {
          await convertAndUploadArticle(nextItem, connectedKey);
        }
      }
    } finally {
      isProcessingQueue = false;
    }
  }

  async function convertAndUploadFile(item: LocalQueueItem, key: string): Promise<void> {
    const file = item.file!;
    const lower = file.name.toLowerCase();
    const isEpub = lower.endsWith('.epub');
    const isKindle = connectedDeviceKind === 'kindle';
    const shouldKepubify = !isKindle && isEpub && Boolean(kepubCheckbox?.checked) && !lower.endsWith('.kepub.epub');

    try {
      if (isKindle && lower.endsWith('.pdf')) {
        throw new Error(
          "Kindle's built-in browser blocks .PDF downloads (only .MOBI, .AZW, .PRC, or .TXT are allowed). Upload an .EPUB, .MOBI, or .TXT instead."
        );
      }

      const t0 = performance.now();
      let payloadBytes: Uint8Array;
      let uploadFilename = file.name;
      let format = isEpub
        ? '.epub'
        : lower.endsWith('.pdf')
          ? '.pdf'
          : lower.endsWith('.mobi')
            ? '.mobi'
            : lower.endsWith('.azw')
              ? '.azw'
              : lower.endsWith('.prc')
                ? '.prc'
                : '.txt';
      let title: string | undefined;
      let author: string | undefined;

      if (isEpub) {
        item.status = 'converting';
        renderQueue();
        // Yield briefly so UI paints the converting badge
        await new Promise((r) => setTimeout(r, 10));

        const rawBuf = new Uint8Array(await file.arrayBuffer());
        const processed = inspectAndConvertEpub(rawBuf, file.name, shouldKepubify);
        payloadBytes = processed.bytes;
        uploadFilename = processed.filename;
        format = processed.format;
        title = processed.title;
        author = processed.author;
        item.displayName = uploadFilename;
        item.sizeBytes = payloadBytes.byteLength;
        item.formatLabel = isKindle ? 'MOBI (Kindle)' : format === '.kepub.epub' ? 'KePub' : 'EPUB';
      } else if (format === '.pdf') {
        // Verify %PDF- signature on the first 1024 bytes before reading entire file into RAM
        const headSlice = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
        const headText = new TextDecoder('latin1').decode(headSlice);
        if (!headText.includes('%PDF-')) {
          throw new Error('Invalid PDF file (missing %PDF signature; file may be renamed)');
        }
        payloadBytes = new Uint8Array(await file.arrayBuffer());
        item.formatLabel = 'PDF';
      } else {
        payloadBytes = new Uint8Array(await file.arrayBuffer());
      }

      item.status = 'uploading';
      renderQueue();

      const res = await fetch(`/api/upload/${encodeURIComponent(key)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-File-Name': encodeURIComponent(uploadFilename),
          'X-Book-Format': format,
          ...(title ? { 'X-Book-Title': encodeURIComponent(title) } : {}),
          ...(author ? { 'X-Book-Author': encodeURIComponent(author) } : {}),
        },
        body: payloadBytes as unknown as BodyInit,
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(errBody.error || `Upload failed (${res.status})`);
      }

      const data = await res.json();
      item.remoteId = data.file?.id;
      if (data.file?.filename) {
        item.displayName = data.file.filename;
      }
      if (typeof data.file?.size === 'number') {
        item.sizeBytes = data.file.size;
      }
      if (data.file?.format === '.mobi' && isKindle) {
        item.formatLabel = 'MOBI (Kindle)';
      }
      item.elapsedMs = Math.round(performance.now() - t0);
      item.status = 'sent';
      renderQueue();
    } catch (err: any) {
      item.status = 'error';
      item.errorMessage = err?.message || 'Upload failed';
      renderQueue();
    }
  }

  async function convertAndUploadArticle(item: LocalQueueItem, key: string): Promise<void> {
    try {
      const t0 = performance.now();
      item.status = 'converting';
      renderQueue();

      const isKindle = connectedDeviceKind === 'kindle';
      const asKepub = !isKindle && Boolean(kepubCheckbox?.checked);
      const res = await fetch(`/api/article/${encodeURIComponent(key)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: item.articleUrl,
          asKepub,
        }),
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(errBody.error || `Article conversion failed (${res.status})`);
      }

      const data = await res.json();
      item.remoteId = data.file?.id;
      item.displayName = data.file?.filename || item.displayName;
      item.sizeBytes = data.file?.size;
      item.formatLabel = isKindle ? 'Article MOBI' : asKepub ? 'Article KePub' : 'Article EPUB';
      item.elapsedMs = Math.round(performance.now() - t0);
      item.status = 'sent';
      renderQueue();
    } catch (err: any) {
      item.status = 'error';
      item.errorMessage = err?.message || 'Could not convert article';
      renderQueue();
    }
  }

  function renderQueue(): void {
    if (!queueSection || !queueList) return;
    if (queue.length === 0) {
      queueSection.style.display = 'none';
      return;
    }

    queueSection.style.display = 'block';
    queueList.innerHTML = queue
      .map((item) => {
        const sizeStr = item.sizeBytes ? ` · ${formatBytes(item.sizeBytes)}` : '';
        const timeStr = item.elapsedMs ? ` · ${item.elapsedMs}ms` : '';
        const metaLine = item.errorMessage
          ? escapeHtml(item.errorMessage)
          : `${escapeHtml(item.formatLabel)}${sizeStr}${timeStr}`;

        let pillText = 'Queued';
        if (item.status === 'waiting') {
          pillText = connectedKey ? 'Queued' : 'Waiting for Code';
        } else if (item.status === 'converting') {
          pillText = 'Converting…';
        } else if (item.status === 'uploading') {
          pillText = 'Sending…';
        } else if (item.status === 'sent') {
          pillText = 'Sent to E-Reader';
        } else if (item.status === 'downloaded') {
          pillText = '✓ Downloaded';
        } else if (item.status === 'error') {
          pillText = 'Failed';
        }

        return `
          <li class="queue-item">
            <div class="queue-item-main">
              <div class="queue-item-name">${escapeHtml(item.displayName)}</div>
              <div class="queue-item-meta">${metaLine}</div>
            </div>
            <span class="queue-pill is-${item.status}">${pillText}</span>
          </li>
        `;
      })
      .join('');
  }

  // File Input & Full-Window Drag-and-Drop
  if (fileInput) {
    fileInput.addEventListener('change', () => {
      if (fileInput.files && fileInput.files.length > 0) {
        enqueueFiles(fileInput.files);
        fileInput.value = '';
      }
    });
  }

  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    dragDepth++;
    windowOverlay?.classList.add('is-active');
    dropzone?.classList.add('is-dragover');
  });

  window.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
  });

  window.addEventListener('dragleave', (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) {
      windowOverlay?.classList.remove('is-active');
      dropzone?.classList.remove('is-dragover');
    }
  });

  window.addEventListener('drop', (e) => {
    if (!e.dataTransfer?.files || e.dataTransfer.files.length === 0) return;
    e.preventDefault();
    dragDepth = 0;
    windowOverlay?.classList.remove('is-active');
    dropzone?.classList.remove('is-dragover');
    enqueueFiles(e.dataTransfer.files);
  });

  // Modern Web Guidance: ime-safe-enter-submit on single-line URL input
  if (articleInput && articleForm) {
    articleInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        if (event.isComposing || event.keyCode === 229) {
          return;
        }
        articleForm.requestSubmit();
      }
    });

    articleForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const val = articleInput.value.trim();
      if (!val) return;
      articleSubmitBtn?.setAttribute('disabled', 'true');
      enqueueArticleUrl(val);
      articleInput.value = '';
      setTimeout(() => articleSubmitBtn?.removeAttribute('disabled'), 300);
    });
  }
})();

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
