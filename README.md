# StreamCore - Manual Multimedia Streaming Player

A from-scratch HTTP byte-range streaming system built without any media libraries. This project implements the full media pipeline that tools like HLS.js and Video.js abstract away, exposing every layer from raw TCP bytes to browser playback.

> **No hls.js. No video.js. No DASH libraries. No shortcuts.**

---

## What This Is

Most developers use a `<video src="...">` tag and call it done. This project builds everything underneath that abstraction manually:

- A Python HTTP server that serves video as byte ranges
- A browser-side MediaSource pipeline that consumes those bytes
- A custom playback state machine with buffer management, seeking, and stall recovery

The result is a streaming system, not just a player!

---

## Architecture

```
Video File on Disk
      │
      ▼
┌─────────────────────────────────────┐
│         Python Backend              │
│                                     │
│  Parses Range header                │
│  Seeks to byte offset               │
│  Returns 206 Partial Content        │
└──────────────────┬──────────────────┘
                   │ HTTP (Range: bytes=X-Y)
                   ▼
┌─────────────────────────────────────┐
│         Browser (React)             │
│                                     │
│  fetch() with Range header          │
│       │                             │
│       ▼                             │
│  MediaSource API                    │
│       │                             │
│       ▼                             │
│  SourceBuffer.appendBuffer()        │
│       │                             │
│       ▼                             │
│  <video> element plays              │
└─────────────────────────────────────┘
```

Each layer is implemented manually with full awareness of what's happening at every step.

---

## Features

### Streaming Pipeline

- **HTTP Range Requests**: `206 Partial Content` responses with correct `Content-Range` headers
- **Chunked delivery**: 512KB chunks fetched on demand, not the whole file at once
- **Dynamic file size detection**: reads `Content-Range` response header on first chunk, no hardcoded file sizes
- **Manual buffer appending**: direct use of `MediaSource` and `SourceBuffer` browser APIs

### Buffer Management

- **Look-ahead buffering**: only fetches new chunks when buffered-ahead drops below a configurable threshold
- **Buffer visualization**: separate progress bar layer showing exactly what's buffered vs. played
- **Stall detection**: listens to the `waiting` event and shows a buffering indicator

### Seeking

- **Chunk recalculation**: converts seek time to byte offset and resumes fetching from the correct chunk
- **Buffer invalidation**: removes stale SourceBuffer data before appending from new position
- **In-flight cancellation**: `AbortController` cancels any in-progress fetch when a seek interrupts

### Resilience

- **Exponential backoff retry**: on network failure, retries with 2s → 4s → 8s delays before giving up
- **Retry counter reset**: successful fetches reset the retry counter so future failures start fresh
- **Error state UI**: surfaces stream failure to the user after max retries

### Player UI (all custom, no browser controls)

- Play / Pause
- Seek bar with buffer bar overlay
- Volume control with mute toggle
- Playback rate selector (1x, 1.25x, 1.5x, 2x)
- Fullscreen (container-level, not just video element)
- Auto-hiding controls on mouse idle
- Keyboard shortcuts: `Space`/`K` (play/pause), `F` (fullscreen), `M` (mute), `←`/`→` (skip 5s)
- Skip forward / backward 5 seconds buttons

---

## Tech Stack

| Layer           | Technology                                                |
| --------------- | --------------------------------------------------------- |
| Backend         | Python 3, `http.server`, `asyncio`-ready                  |
| Frontend        | React / Next.js                                           |
| Browser APIs    | `MediaSource`, `SourceBuffer`, `fetch`, `AbortController` |
| Icons           | `lucide-react`                                            |
| Media libraries | **None**                                                  |

---

## Project Structure

```
StreamCore/
├── backend/
│   ├── server.py           # Python range-request HTTP server
│   └── video.mp4           # Fragmented MP4 (see setup below)
└── frontend/
    └── app/
        ├── page.js         # Full streaming player component
        └── page.module.css # Player styles
```

---

## Setup & Running

### Prerequisites

- Python 3.8+
- Node.js 18+
- `ffmpeg` (for video preparation)

### 1. Prepare your video file

Regular MP4 files store their metadata (`moov` atom) at the end of the file, which means the browser can't start playback until the entire file is downloaded. The MediaSource API requires **fragmented MP4**, which distributes metadata throughout the file.

Convert your video:

```bash
ffmpeg -i your_video.mp4 \
  -movflags frag_keyframe+empty_moov+default_base_moof \
  -c copy \
  backend/video.mp4
```

Verify it worked:

```bash
ffprobe -v trace backend/video.mp4 2>&1 | grep -E "moov|moof|mdat" | head -20
# You should see repeating moof+mdat pairs, not one large mdat block
```

Find your codec string (needed if you change the frontend's `addSourceBuffer` call):

```bash
ffprobe -v error \
  -select_streams v:0 \
  -show_entries stream=codec_name,profile \
  backend/video.mp4
```

### 2. Start the backend

```bash
cd backend
python server.py
# Server running at http://localhost:8000
```

Verify it works with curl before starting the frontend:

```bash
# Should return 206 with correct headers
curl -v -H "Range: bytes=0-65535" http://localhost:8000/video

# Should print exactly 65536
curl -s -H "Range: bytes=0-65535" http://localhost:8000/video | wc -c
```

### 3. Start the frontend

```bash
cd frontend
npm install
npm run dev
# Running at http://localhost:3000
```

---

## How It Works (Core Concepts)

### HTTP Range Requests

The client requests specific byte ranges instead of the full file:

```
GET /video HTTP/1.1
Range: bytes=0-524287

HTTP/1.1 206 Partial Content
Content-Range: bytes 0-524287/1164990
Content-Length: 524288
Content-Type: video/mp4
```

The server opens the file, seeks to the start byte, reads exactly the requested length, and returns it with a `206` status. This is how the backend knows which bytes to serve without reading the entire file into memory.

### MediaSource API Pipeline

The browser's `<video>` element is normally self-contained. With MSE, you take over the data pipeline:

```javascript
const ms = new MediaSource();
video.src = URL.createObjectURL(ms); // attach MediaSource to video

ms.addEventListener("sourceopen", () => {
  const sb = ms.addSourceBuffer('video/mp4; codecs="avc1.640028, mp4a.40.2"');
  // now you can manually push bytes into sb
});
```

The critical invariant: **you cannot call `appendBuffer` while the SourceBuffer is still processing**. Every append must wait for the `updateend` event before the next one. Violating this throws an `InvalidStateError`. The entire fetch loop is built around this constraint.

### Buffer Look-Ahead

Instead of fetching all chunks upfront, the player checks how much is buffered ahead of the current playhead before each fetch:

```javascript
function getBufferedAhead(video) {
  for (let i = 0; i < video.buffered.length; i++) {
    if (
      video.buffered.start(i) <= video.currentTime &&
      video.buffered.end(i) > video.currentTime
    ) {
      return video.buffered.end(i) - video.currentTime;
    }
  }
  return 0;
}
```

If `bufferedAhead >= BUFFER_AHEAD` (3 seconds), fetching pauses and a 1-second timeout re-checks. This prevents over-fetching and simulates what real adaptive players do.

### Seeking

Seeking requires three steps:

1. Abort any in-progress fetch (via `AbortController`)
2. Remove stale buffer data (`SourceBuffer.remove()`)
3. Recalculate which chunk contains the new position and restart the fetch loop

The byte-to-time mapping uses a linear approximation:

```javascript
function timeToChunkIndex(currentTime, duration) {
  const ratio = currentTime / duration;
  const bytePosition = ratio * fileSizeRef.current;
  return Math.floor(bytePosition / CHUNK_SIZE);
}
```

This works well for constant bitrate content. Variable bitrate content would require parsing the MP4's `sidx` (segment index) box for exact byte offsets per timestamp, a known tradeoff.

### Exponential Backoff Retry

On fetch failure (excluding intentional aborts from seeking), the pipeline retries with increasing delays:

```
Attempt 1 fails → wait 2s  → retry
Attempt 2 fails → wait 4s  → retry
Attempt 3 fails → wait 8s  → retry
Attempt 4 fails → surface error to user
```

If the server recovers within the retry window, playback resumes automatically without user intervention.

---

## Known Tradeoffs

These are intentional simplifications, not oversights. Each is worth understanding:

**Linear byte-to-time approximation**
Time → chunk mapping assumes constant bitrate. A production system would parse the MP4 `sidx` box to get frame-accurate byte offsets. This is fine for CBR content and honest to acknowledge.

**Single hardcoded codec string**
The `addSourceBuffer` codec string must match the video file exactly. A production system would expose a `/metadata` endpoint or negotiate codecs dynamically. The codec string is the one remaining hardcoded value after dynamic file size was implemented.

**No adaptive bitrate**
Real players (HLS, DASH) switch between quality levels based on network speed. This player serves one quality level. Adding ABR would require multiple encoded versions of the video and bandwidth estimation logic.

**Event listener cleanup**
Video element listeners are not removed on component unmount. In a long-lived SPA this could cause memory leaks. A production implementation would store references and clean them up in the `useEffect` return function.

**Single file server**
The backend serves one hardcoded file. Extending to multiple files would require a filename parameter: `GET /video?file=movie.mp4` and path sanitization to prevent directory traversal.

---

## What I Learned

- How HTTP range requests work at the protocol level, not just conceptually
- Why fragmented MP4 exists and how it differs structurally from a standard MP4
- The `MediaSource` / `SourceBuffer` event model and why appends must be serialized
- How buffer look-ahead works in real media players
- How seeking requires buffer invalidation, not just a timestamp change
- Why `AbortController` is necessary when user interactions race with in-flight requests
- How `Access-Control-Expose-Headers` differs from `Access-Control-Allow-Headers` and why the browser strips response headers by default

---

## References

- [MDN — Media Source Extensions](https://developer.mozilla.org/en-US/docs/Web/API/Media_Source_Extensions_API)
- [MDN — HTTP Range Requests](https://developer.mozilla.org/en-US/docs/Web/HTTP/Range_requests)
- [MDN — SourceBuffer](https://developer.mozilla.org/en-US/docs/Web/API/SourceBuffer)
- [ISO BMFF Spec — Fragmented MP4](https://www.iso.org/standard/68960.html)
