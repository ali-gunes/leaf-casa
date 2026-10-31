# <img src="src/client/assets/logo.png" width="28" height="28" align="top" alt="Leaf logo" /> Leaf (`leaf.casa`)

Leaf is a fast, zero-account web relay for sending eBooks (`.epub`, `.pdf`) and web articles directly to e-readers (Kobo, Kindle, PocketBook, Tolino) over their built-in web browsers.

## Features

- **Unambiguous 4-character pairing codes**: Uses the Crockford Base32 alphabet (`23456789ABCDEFGHJKMNPQRSTVWXYZ`), removing `0`/`O` and `1`/`I`/`L` confusion on e-ink screens, paired with a high-contrast 1-bit SVG QR code for instant phone scanning.
- **Client-side EPUB to KePub conversion**: Standard `.epub` files are converted to Kobo `.kepub.epub` directly inside the sender's browser using `fflate` and `DOMParser`. The server relays already-converted bytes without spawning external CLI binaries (`kepubify`, `kindlegen`, or Python tools).
- **Web articles to eBook**: Paste any article URL to strip clutter with `@mozilla/readability` and package the text into a clean `.epub` or `.kepub.epub` on the fly.
- **One-tap e-reader queue**: The receiver view surfaces a single `"Download Next (1 of N)"` primary action at the top of the screen and marks books `[✓ Downloaded]` as you go, so you don't lose your place when transferring multiple books.
- **Pure 1-bit e-ink receiver UI**: Strict `#000000` on `#FFFFFF` styling with zero animations, shadows, or gray washes that cause e-ink ghosting. Written in plain ES5 (`var`, `XMLHttpRequest` polling fallback alongside `EventSource`) for compatibility with older Kindle and Kobo WebKit browsers.
- **Role switcher**: Automatic `User-Agent` detection with a one-tap `Sender ⇄ E-Reader` toggle in the header so devices with desktop-like browser strings are never stuck on the wrong view.
- **Ephemeral memory store**: Uploaded books live only in memory for an active 15-minute sliding window and are purged automatically when sessions expire.
- **Built-in SQLite stats (`/stats`)**: Lightweight, tracker-free server metrics stored in embedded SQLite (`node:sqlite` WAL mode), protected by HTTP Basic Auth.

## How It Works

1. Open **`leaf.casa`** on your e-reader's web browser. A 4-character code and QR code will appear.
2. Open **`leaf.casa`** on your computer or scan the QR code with your phone.
3. Type the 4-character code (or drop your `.epub` / `.pdf` files anywhere on the window first; queued files send automatically as soon as the 4th character connects).
4. Tap **Download Next** on your e-reader.

## Self-Hosting

### Docker Compose (Recommended)

```yaml
services:
  leaf:
    build: .
    container_name: leaf-casa
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      - PUBLIC_APP_NAME=Leaf Casa
      - PUBLIC_BASE_URL=https://leaf.casa
      - PORT=3000
      - DB_PATH=/data/stats.db
      - STATS_PASSWORD=your-secret-password
      - LOG_RAW_IP=true
    volumes:
      - ./data:/data
```

```bash
docker compose up -d --build
```

### Running from Source

Requires **Node.js 22.5+** (uses the built-in `node:sqlite` module, so no native C++ addons or compiler toolchains are required).

```bash
git clone https://github.com/ali-gunes/leaf-casa.git
cd leaf-casa
npm install
cp .env.example .env

# Build client & server bundles
npm run build

# Start production server
npm start
```

For local development with file watching:

```bash
npm run dev
```

Run the test suite:

```bash
npm test
```

## Analytics & Privacy

Leaf includes a lightweight, self-hosted `/stats` dashboard backed by Node's built-in SQLite module (`data/stats.db`). Because running an open, unauthenticated file relay and URL fetcher on the public internet requires visibility into bandwidth and abuse, Leaf records basic operational metrics without crossing into user surveillance.

### What We Never Collect

- **No book files on disk**: Uploaded `.epub` and `.pdf` buffers exist strictly in server RAM while your 4-character pairing session is active (up to 15 minutes) and are garbage-collected from memory afterwards.
- **No reading history or metadata**: We never log book titles, filenames, author names, book contents, or the article URLs you convert.
- **No third-party trackers or cookies**: There is no Google Analytics, PostHog, Cloudflare Web Analytics, tracking pixels, cookies, or browser fingerprinting. E-ink browsers are slow enough already; zero analytics JavaScript runs on the client.

### What We Log and Why

When a page loads or a file transfer occurs, the server writes a row to the local SQLite database with:

1. **Device category (`kobo`, `kindle`, `pocketbook`, `tolino`, `desktop`, `mobile`) and role (`sender` / `receiver`)**
   - *Why*: E-reader web browsers have wildly different quirks across firmware versions. Knowing which devices actually use the relay tells us which browsers and formats to prioritize and test.
2. **Transfer format (`.kepub.epub`, `.epub`, `.pdf`, `article`), size in bytes, and download status**
   - *Why*: Helps monitor RAM pool pressure, total bandwidth relayed, and whether files queued from phones/computers are successfully completing their download on e-readers.
3. **Country code and IP address (configurable via `LOG_RAW_IP`)**
   - *Why*: Because Leaf requires no account login, IP and country visibility allow the server operator to spot automated scraping, SSRF abuse on the article converter, or bandwidth flooding.
   - *Privacy toggle*: If you self-host Leaf and do not want raw IP addresses stored on disk, set `LOG_RAW_IP=false` in your `.env`. Leaf will immediately replace raw IPs with a truncated one-way SHA-256 hash (`anon-xxxxxxxxxx`) before writing to SQLite, preserving unique visitor counts without storing network addresses.

## Configuration

All settings are controlled via environment variables:

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PUBLIC_APP_NAME` | `Leaf Casa` | Application name shown in page headers and titles |
| `PUBLIC_BASE_URL` | `https://leaf.casa` | Public base URL encoded into pairing QR codes |
| `PORT` | `3000` | HTTP listen port |
| `HOST` | `0.0.0.0` | HTTP bind address |
| `MAX_FILE_SIZE_MB` | `100` | Maximum size per uploaded file in MB |
| `MAX_MEMORY_POOL_MB` | `512` | Maximum total RAM allocated to active file buffers |
| `SESSION_TTL_MINUTES` | `15` | Sliding expiration window for idle pairing sessions |
| `DB_PATH` | `./data/stats.db` | Path to the SQLite analytics database file |
| `STATS_USER` | `admin` | Username for `/stats` HTTP Basic Auth |
| `STATS_PASSWORD` | *(empty)* | Password for `/stats` dashboard (leave empty only in local dev) |
| `LOG_RAW_IP` | `true` | Set to `false` to store anonymized SHA-256 IP hashes in SQLite |

## Project Layout

```text
├── src/
│   ├── server/
│   │   ├── index.ts          # HTTP server, routes, SSE stream, HTML views, /stats
│   │   ├── sessionStore.ts   # Ephemeral Crockford Base32 session & buffer store
│   │   ├── analytics.ts      # Embedded node:sqlite logger & GeoIP resolution
│   │   └── articleToEpub.ts  # Readability URL extractor & EPUB/KePub builder
│   └── client/
│       ├── sender/
│       │   ├── main.ts       # 4-slot code input, full-window dropzone, queue UI
│       │   └── kepubify.ts   # In-browser EPUB -> .kepub.epub converter (fflate)
│       ├── receiver/
│       │   └── ereader.js    # ES5 receiver script (SSE + XHR polling fallback)
│       └── styles/
│           ├── editorial.css # Sender & /stats stylesheet
│           └── eink.css      # 1-bit high-contrast stylesheet for e-readers
├── test/
│   └── leaf.test.ts          # Automated test suite
├── Dockerfile
└── docker-compose.yml
```

## License

MIT © Ali Güneş
