# TS → MP4

React + Vite app that batch-converts MPEG transport stream (`.ts`) files to `.mp4` entirely in the browser using [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm). No server, no upload.

Live: https://jacoblbagent.github.io/ts-to-mp4/

## Run

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # static output in dist/
npm run preview
```

## Deploy

GitHub Pages, `gh-pages` branch (build output stays out of `main`):

```bash
npm run deploy     # build + publish dist/ to the gh-pages branch
```

`scripts/deploy.sh` does this with no npm dependencies: it builds, copies `dist/` into a temp dir, inits a repo there and force-pushes `gh-pages`. The `gh-pages` package is deliberately not used — it pulls in `globby > fast-glob > micromatch > braces`, and `braces` has an unfixed stack-exhaustion advisory (GHSA-vfj7-8cjw-p6xm, no patched release), so `npm audit` stays clean without needing any override.

`vite.config.js` sets `base: '/ts-to-mp4/'` for production builds only, so `npm run dev` stays at the root.

## Design

The UI follows the house design rules in `~/design-rules-memory.md`:

- **One type face with character** — Instrument Sans, self-hosted via `@fontsource-variable`, instead of the system stack.
- **Tokens first** — color, spacing (4px grid), radius, and type scale are declared once at `:root` in `src/App.css`; components consume them.
- **Authored SVG icons, one 16px grid** (`src/icons.jsx`) — no unicode glyphs or emoji standing in for an icon set.
- **Elevation declared once** — cards are border-only; the focused row is a border color change, not a colored halo. The floating tooltip/toast carries the only shadow.
- **Real contrast** — body and secondary text clear WCAG AA in both light and dark.
- **Themed browser surfaces** — selection color, focus rings, and scrollbars come from the palette.
- **Motion that respects the reader** — progress animates with `transform: scaleX`, never layout `width`; everything collapses under `prefers-reduced-motion`.
- **Terse copy** — instructional captions are gone; what remains is functional status.

## Minimum file size

`.ts` files under 50 MB are skipped when added (never queued; a toast in the bottom corner says how many were skipped, auto-dismissing after 5s or closeable immediately). Change `MIN_SIZE_MB` at the top of `src/App.jsx`. Sizes use decimal MB to match macOS Finder.

## How it works

- `src/useFFmpeg.js` — lazy-loads the single-threaded ffmpeg core (bundled from `@ffmpeg/core`, no CDN) and exposes `convert(file, mode)`.
- Each file is probed first (`ffmpeg -i`), then every stream is handled so the MP4 opens in **macOS QuickTime / Quick Look**, not just browsers:
  - H.264 8-bit 4:2:0 → copied, tagged `avc1`
  - H.265 → copied, tagged **`hvc1`** (ffmpeg's default `hev1` won't open on a Mac)
  - anything else (10-bit / 4:2:2 H.264, MPEG-2, …) → re-encoded to H.264 High, `yuv420p`
  - AAC / MP3 audio → copied; MP2, AC-3, PCM, Opus, … → re-encoded to AAC 160k (fast)
- **Auto** uses that plan and falls back to a full re-encode if copying fails.
- **Stream copy** uses the same plan but refuses files whose video would need re-encoding.
- **Re-encode** always re-encodes video and audio (H.264 `yuv420p` + AAC).
- `-movflags +faststart` puts the moov atom up front so the file streams/plays immediately.

## Notes

- Uses the single-threaded core, so no `SharedArrayBuffer` / COOP/COEP headers are needed — deploys to any static host.
- Input and output both live in wasm memory; practical ceiling is ~2 GB per file.
- For big files or batch jobs, native ffmpeg is far faster: `ffmpeg -i in.ts -c copy -bsf:a aac_adtstoasc out.mp4`.

## Viewing videos

Click a row to play it inline, right inside that same row's card — only once the file has finished converting; queued and converting rows aren't clickable. The video moves between rows with ‹ › / arrow keys, and the only control in its header is the close button; the file's name, star and download stay visible in the row above it.

- ← / → switch videos, F favorites the one showing, Esc closes.

## Reload protection

While any files are in the list, reloading, closing the tab or navigating away shows the browser's "Leave site?" prompt. An empty list reloads freely.

## Favorites

Click the star on a row (or press F in the viewer) to star a file. **Favorites** filters the list and the viewer to starred files. Stars are stored in localStorage by name + size, so re-adding the same file after a reload keeps its star. The filter only changes what is shown; Convert still processes the whole queue.

## Last-touched row

The row you last interacted with (any click on it, or moving the viewer to it) gets an accent outline, which stays after the viewer closes.

## Thumbnails

Drop or select a `.jpg`/`.png` alongside its `.ts` (same base name, e.g. `hdz_0056.jpg` + `hdz_0056.ts`) and it's used as that row's thumbnail on the left. Images are never queued or converted themselves, and matching works whichever one you add first. There's no separate "View" button — click anywhere on a row (besides its buttons/links) to open the viewer for that file.

## Starred recordings

Some DVRs flag a recording by leaving a sidecar next to it — `hdz_0000.ts.star.txt` (or just `hdz_0000.ts.star`) beside `hdz_0000.ts`. Add it with the recording (same base name, in either order) and it's consumed as a flag: never queued, never counted as a skipped non-`.ts` file. The flagged row shows `-star` in its name and downloads as `hdz_0000-star.mp4`, so the marking survives into your library.

## Renaming

Click the pencil next to a file's name (it appears on hover) to rename it. Spaces are fine while editing — they're only swapped for `-` when the file is actually downloaded, both for a single row's **Download** link and for entries inside the "Download all" zip. Press Enter or click away to save, Esc to cancel. Renaming doesn't touch conversion; it only changes the output filename.

## Downloading in bulk

Once more than one file is done, each done row gets a checkbox. Check a few and the button switches to **Download selected**; check none and it's **Download all**. Either way it bundles the chosen files into a single `.zip` (optionally named via the field next to the button) and downloads it in one shot — extracting it locally gives you a real folder. **Select all** checks/unchecks every done file. A `.zip` is used instead of a `download` attribute with a `/` in it, because Chrome silently sanitizes that to `_` and never creates a folder.

Selecting several at once works the way it does in Finder/Gmail/etc: **cmd/ctrl-click** a row (or its checkbox) to toggle just that one without affecting the rest, and **shift-click** to select every done row between your last pick and the one you just clicked. A plain click on a row still opens the viewer; the modifiers are what switch it into selecting instead.

## Remembering removed files

Clicking the close button on a row remembers that file's original name in localStorage. If a file with that same name is uploaded again later (this session or a future visit), it's skipped automatically — not queued, not shown as an error — and folded into the same toast as other skipped uploads ("Skipped 1 previously removed file"). Whenever this list isn't empty, a note above the drop zone says how many names are being skipped, with a **Clear list** button to forget them all and allow those files again.

## Reliability on large batches

`src/useFFmpeg.js` periodically recycles the ffmpeg.wasm engine (terminates and reloads it) every 6 files or ~1 GB of source video, and immediately after any fatal wasm error (`RuntimeError: memory access out of bounds` and similar). ffmpeg.wasm's linear memory only ever grows within one engine instance, so without this a long batch of large files can eventually trap and then corrupt every conversion after it; recycling resets the memory ceiling before that happens, and stops a single bad file from cascading into the rest of the batch.
