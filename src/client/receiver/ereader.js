/* Strictly ES5 script for Kobo, Kindle, PocketBook, and Tolino browsers */
(function () {
  var currentKey = window.__LEAF_INITIAL_KEY__ || '';
  var sseSource = null;
  var pollTimer = null;
  var POLL_INTERVAL_MS = 4000;

  var codeEl = document.getElementById('eink-code');
  var qrEl = document.getElementById('eink-qr');
  var statusEl = document.getElementById('eink-status-text');
  var nextWrapEl = document.getElementById('eink-next-action');
  var queueListEl = document.getElementById('eink-queue-list');
  var emptyBoxEl = document.getElementById('eink-empty-box');
  var newCodeBtn = document.getElementById('eink-new-code-btn');
  var refreshBtn = document.getElementById('eink-refresh-btn');

  function formatSpacedKey(key) {
    if (!key) return '- - - -';
    return key.split('').join(' ');
  }

  function formatSize(bytes) {
    var kb = Math.round(bytes / 1024);
    if (kb < 1024) return kb + ' KB';
    var mb = (bytes / (1024 * 1024)).toFixed(1);
    return mb + ' MB';
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function renderSession(data) {
    if (!data || !data.key) return;

    if (data.key !== currentKey) {
      currentKey = data.key;
    }

    if (codeEl) {
      codeEl.innerHTML = escapeHtml(formatSpacedKey(data.key));
    }

    if (qrEl && data.qrSvg) {
      qrEl.innerHTML = data.qrSvg;
    }

    var files = data.files || [];
    var total = files.length;
    var undownloaded = [];
    var downloadedList = [];
    var i;

    for (i = 0; i < files.length; i++) {
      if (files[i].downloaded) {
        downloadedList.push(files[i]);
      } else {
        undownloaded.push(files[i]);
      }
    }

    if (statusEl) {
      var deviceName = (data.device && data.device.label) ? data.device.label : 'E-Reader';
      var formatNote = (data.device && data.device.prefersKepub) ? ' (KePub Ready)' : '';
      statusEl.innerHTML =
        'Device: <strong>' + escapeHtml(deviceName + formatNote) + '</strong> &middot; ' +
        'Waiting for files (' + total + ' received)';
    }

    /* Render "Download Next (X of N)" primary button */
    if (nextWrapEl) {
      if (undownloaded.length > 0) {
        var nextItem = undownloaded[0];
        var currentIndex = downloadedList.length + 1;
        var downloadUrl = '/api/download/' + encodeURIComponent(currentKey) + '/' + encodeURIComponent(nextItem.id);
        nextWrapEl.innerHTML =
          '<a class="eink-primary-btn" id="eink-primary-download" href="' + downloadUrl + '">' +
          '&#11015; Download Next: &ldquo;' + escapeHtml(nextItem.filename) + '&rdquo; (' + currentIndex + ' of ' + total + ')' +
          '</a>';

        var primaryBtn = document.getElementById('eink-primary-download');
        if (primaryBtn) {
          primaryBtn.onclick = function () {
            setTimeout(function () {
              pollStatus();
            }, 900);
          };
        }
      } else {
        nextWrapEl.innerHTML = '';
      }
    }

    /* Render Queue List (undownloaded first, then downloaded) */
    if (total === 0) {
      if (emptyBoxEl) emptyBoxEl.style.display = 'block';
      if (queueListEl) queueListEl.innerHTML = '';
      return;
    }

    if (emptyBoxEl) emptyBoxEl.style.display = 'none';

    var ordered = undownloaded.concat(downloadedList);
    var html = '';

    for (i = 0; i < ordered.length; i++) {
      var item = ordered[i];
      var itemUrl = '/api/download/' + encodeURIComponent(currentKey) + '/' + encodeURIComponent(item.id);
      var badgeHtml = item.downloaded
        ? '<span class="eink-badge-done">[&#10003; Downloaded]</span>'
        : '';
      var btnLabel = item.downloaded ? 'Download Again' : 'Download';

      html +=
        '<li class="eink-queue-item">' +
          '<div class="eink-queue-info">' +
            '<div class="eink-queue-title">' + badgeHtml + escapeHtml(item.filename) + '</div>' +
            '<div class="eink-queue-meta">' +
              escapeHtml(item.format) + ' &middot; ' + formatSize(item.size) +
            '</div>' +
          '</div>' +
          '<div class="eink-queue-action">' +
            '<a class="eink-download-link" data-file-id="' + escapeHtml(item.id) + '" href="' + itemUrl + '">' +
              btnLabel +
            '</a>' +
          '</div>' +
        '</li>';
    }

    if (queueListEl) {
      queueListEl.innerHTML = html;
      var links = queueListEl.getElementsByTagName('a');
      for (i = 0; i < links.length; i++) {
        links[i].onclick = function () {
          setTimeout(function () {
            pollStatus();
          }, 900);
        };
      }
    }
  }

  function requestNewSession(preferredKey) {
    var xhr = new XMLHttpRequest();
    var url = '/api/generate';
    if (preferredKey) {
      url += '?key=' + encodeURIComponent(preferredKey);
    }
    xhr.open('POST', url, true);
    xhr.onreadystatechange = function () {
      if (xhr.readyState === 4) {
        if (xhr.status === 200) {
          try {
            var data = JSON.parse(xhr.responseText);
            currentKey = data.key;
            renderSession(data);
            connectStream(currentKey);
          } catch (e) {
            /* Ignore parse error */
          }
        }
      }
    };
    xhr.send(null);
  }

  function pollStatus() {
    if (!currentKey) return;
    var xhr = new XMLHttpRequest();
    xhr.open('GET', '/api/status/' + encodeURIComponent(currentKey) + '?t=' + new Date().getTime(), true);
    xhr.onreadystatechange = function () {
      if (xhr.readyState === 4) {
        if (xhr.status === 200) {
          try {
            var data = JSON.parse(xhr.responseText);
            renderSession(data);
          } catch (e) {
            /* Ignore */
          }
        } else if (xhr.status === 404) {
          /* Session expired; allocate a fresh key */
          requestNewSession('');
        }
      }
    };
    xhr.send(null);
  }

  function startPollingFallback() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(pollStatus, POLL_INTERVAL_MS);
  }

  function connectStream(key) {
    if (sseSource) {
      try {
        sseSource.close();
      } catch (e) {}
      sseSource = null;
    }

    startPollingFallback();

    if (typeof window.EventSource !== 'undefined') {
      try {
        sseSource = new window.EventSource('/api/stream/' + encodeURIComponent(key));
        sseSource.onmessage = function (ev) {
          try {
            var payload = JSON.parse(ev.data);
            renderSession(payload);
          } catch (e) {}
        };
        sseSource.onerror = function () {
          /* Rely on XHR polling fallback */
        };
      } catch (e) {
        /* Fallback already active */
      }
    }
  }

  if (newCodeBtn) {
    newCodeBtn.onclick = function (ev) {
      if (ev && ev.preventDefault) ev.preventDefault();
      requestNewSession('');
      return false;
    };
  }

  if (refreshBtn) {
    refreshBtn.onclick = function (ev) {
      if (ev && ev.preventDefault) ev.preventDefault();
      pollStatus();
      return false;
    };
  }

  if (currentKey) {
    connectStream(currentKey);
    pollStatus();
  } else {
    requestNewSession('');
  }
})();
