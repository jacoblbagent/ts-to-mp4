import { useCallback, useEffect, useRef, useState } from 'react';
import JSZip from 'jszip';
import { useFFmpeg, CancelledError } from './useFFmpeg';
import Viewer from './Viewer';
import { useFavorites } from './favorites';
import { useDismissedNames } from './dismissed';
import StarButton from './StarButton';
import { IconPencil, IconX, IconCheck, IconAlert, IconCircle, IconInfo, IconDownload } from './icons';

const TS_RE = /\.(ts|mts|m2ts)$/i;
const IMG_RE = /\.(jpe?g|png)$/i;

// Strip the extension and any trailing modifier macOS/DVRs sometimes add (e.g. "hdz_0056 copy")
const baseKey = (name) => name.replace(/\.[^.]+$/, '').trim().toLowerCase();

// .ts files smaller than this are ignored when added. Decimal MB to match macOS Finder.
const MIN_SIZE_MB = 50;
const MIN_SIZE_BYTES = MIN_SIZE_MB * 1000 * 1000;

// Natural, case-insensitive name order like Finder: clip2 < clip10, "A" == "a"
const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const compareFiles = (a, b) => byName.compare(a.name, b.name);
const compareJobs = (a, b) => compareFiles(a.file, b.file) || a.id - b.id;

// Decimal units (1 MB = 1,000,000 bytes), same as Finder, so sizes here match what you see there.
const formatBytes = (n) => {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1000)), u.length - 1);
  return `${(n / 1000 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
};

const PHASE_LABEL = {
  loading: 'Loading FFmpeg…',
  reading: 'Reading file…',
  remux: 'Stream copying',
  encode: 'Re-encoding',
};

let nextId = 1;
const makeJob = (file) => ({
  id: nextId++,
  file,
  status: 'queued', // queued | converting | done | error
  phase: null,
  progress: 0,
  result: null, // { url, blob, size, name, mode, seconds }
  error: '',
  customName: null, // user-edited display name (spaces allowed), or null to use the original
});

// The name shown/edited for a job: the custom name if set, else the original filename minus its
// .ts extension. Spaces are kept here so editing stays natural; they're only swapped for "-" when
// a file actually gets downloaded (downloadFilename below).
const baseName = (job) => job.customName ?? job.file.name.replace(TS_RE, '');
const downloadFilename = (job) => baseName(job).trim().replace(/\s+/g, '-') + '.mp4';

export default function App() {
  const { convert, cancel } = useFFmpeg();
  const [jobs, setJobs] = useState([]);
  const [mode, setMode] = useState('auto');
  const [running, setRunning] = useState(false); // queue is processing
  const [activeId, setActiveId] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [toast, setToast] = useState(null); // { id, message } | null — auto-dismisses after 5s
  const [thumbs, setThumbs] = useState({}); // baseKey -> object URL, from matching .jpg/.png uploads
  const thumbsRef = useRef(thumbs);
  thumbsRef.current = thumbs;
  const [zipName, setZipName] = useState(''); // optional name for the "Download all"/"Download selected" .zip
  const [zipping, setZipping] = useState(false);
  const [selectedIds, setSelectedIds] = useState(() => new Set()); // checked rows, for "Download selected"
  const [selectionAnchorId, setSelectionAnchorId] = useState(null); // last plain/cmd-click, for shift-click ranges
  const [viewingId, setViewingId] = useState(null);
  const viewingRowRef = useRef(null);
  const [lastId, setLastId] = useState(null); // row you last interacted with (outlined)

  // Moving through videos in the viewer counts as interacting with that row
  useEffect(() => {
    if (viewingId !== null) setLastId(viewingId);
  }, [viewingId]);

  // Warn before reload / close / navigating away while there are files in the list.
  // Browsers show their own "Leave site?" dialog; custom text isn't allowed.
  const { isFavorite, toggleFavorite } = useFavorites();
  const { dismissed, addDismissed, clearDismissed } = useDismissedNames();
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const favCount = jobs.filter((j) => isFavorite(j.file)).length;
  const visibleJobs = favoritesOnly ? jobs.filter((j) => isFavorite(j.file)) : jobs;

  // Turn the filter off by itself once nothing is starred any more
  useEffect(() => {
    if (favoritesOnly && favCount === 0) setFavoritesOnly(false);
  }, [favoritesOnly, favCount]);

  // Close the viewer if its video is filtered out, removed, or no longer done
  useEffect(() => {
    if (viewingId !== null && !visibleJobs.some((j) => j.id === viewingId && j.status === 'done')) setViewingId(null);
  }, [viewingId, visibleJobs]);

  // Auto-dismiss the toast after 5s; a newer toast (different id) resets the clock,
  // and the timer for a toast the user already closed never fires against a later one.
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast((cur) => (cur?.id === toast.id ? null : cur)), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  const hasFiles = jobs.length > 0;
  useEffect(() => {
    if (!hasFiles) return;
    const onBeforeUnload = (e) => {
      e.preventDefault();
      e.returnValue = ''; // required by older Chrome/Safari
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [hasFiles]);

  // Bring the row (with its now-nested viewer) into view whenever it opens or moves
  useEffect(() => {
    if (viewingId === null) return;
    const row = viewingRowRef.current;
    if (!row) return;
    const top = row.getBoundingClientRect().top + window.scrollY - 12;
    const bottom = row.getBoundingClientRect().bottom + window.scrollY + 12;
    const fits = bottom - top <= window.innerHeight;
    const target = fits && top > window.scrollY && bottom < window.scrollY + window.innerHeight ? null : top;
    if (target !== null) window.scrollTo({ top: target, behavior: 'smooth' });
  }, [viewingId]);
  const inputRef = useRef(null);
  const jobsRef = useRef(jobs);
  jobsRef.current = jobs;

  const patch = useCallback((id, changes) => {
    setJobs((prev) =>
      prev.map((j) => (j.id === id ? { ...j, ...(typeof changes === 'function' ? changes(j) : changes) } : j))
    );
  }, []);

  // Revoke all object URLs on unmount
  useEffect(() => {
    return () => {
      jobsRef.current.forEach((j) => j.result && URL.revokeObjectURL(j.result.url));
      Object.values(thumbsRef.current).forEach((url) => URL.revokeObjectURL(url));
    };
  }, []);

  const addFiles = (list) => {
    const files = Array.from(list || []);
    const images = files.filter((f) => IMG_RE.test(f.name));
    const rest = files.filter((f) => !IMG_RE.test(f.name));
    const notTs = rest.filter((f) => !TS_RE.test(f.name));
    const tsFiles = rest.filter((f) => TS_RE.test(f.name));
    // Files whose name was removed from the list before are skipped silently on re-upload.
    const previouslyRemoved = tsFiles.filter((f) => dismissed.has(f.name));
    const tsRemaining = tsFiles.filter((f) => !dismissed.has(f.name));
    const tooSmall = tsRemaining.filter((f) => f.size < MIN_SIZE_BYTES);
    const good = tsRemaining.filter((f) => f.size >= MIN_SIZE_BYTES);

    const message = [
      tooSmall.length > 0 && `${tooSmall.length} file${tooSmall.length > 1 ? 's' : ''} under ${MIN_SIZE_MB} MB`,
      notTs.length > 0 && `${notTs.length} non-.ts file${notTs.length > 1 ? 's' : ''}`,
      previouslyRemoved.length > 0 &&
        `${previouslyRemoved.length} previously removed file${previouslyRemoved.length > 1 ? 's' : ''}`,
    ]
      .filter(Boolean)
      .join(' and ')
      .replace(/^/, 'Skipped ');
    if (tooSmall.length > 0 || notTs.length > 0 || previouslyRemoved.length > 0) {
      setToast({ id: Date.now(), message });
    }

    // .jpg/.png files are consumed as thumbnails for the .ts with the same base name
    // (e.g. hdz_0056.jpg -> hdz_0056.ts), matched whichever side arrives first, never queued themselves.
    if (images.length) {
      setThumbs((prev) => {
        const next = { ...prev };
        for (const img of images) {
          const key = baseKey(img.name);
          if (next[key]) URL.revokeObjectURL(next[key]);
          next[key] = URL.createObjectURL(img);
        }
        return next;
      });
    }
    // Keep the whole list sorted ascending by name; the queue converts in this order too
    if (good.length) setJobs((prev) => [...prev, ...good.map(makeJob)].sort(compareJobs));
  };

  // Queue runner: whenever the queue is running and nothing is active, start the next queued job.
  useEffect(() => {
    if (!running || activeId !== null) return;
    const next = jobs.find((j) => j.status === 'queued');
    if (!next) {
      setRunning(false);
      return;
    }

    setActiveId(next.id);
    patch(next.id, { status: 'converting', progress: 0, error: '', phase: null });
    const log = []; // ffmpeg output, only surfaced in the console if this file fails
    const t0 = performance.now();

    convert(next.file, mode, {
      onPhase: (phase) => patch(next.id, { phase }),
      onProgress: (progress) => patch(next.id, { progress }),
      onLog: (line) => {
        log.push(line);
        if (log.length > 500) log.splice(0, 100);
      },
    })
      .then(({ blob, mode: used }) => {
        const name = next.file.name.replace(TS_RE, '') + '.mp4';
        patch(next.id, {
          status: 'done',
          progress: 1,
          phase: null,
          result: {
            url: URL.createObjectURL(blob),
            blob,
            size: blob.size,
            name,
            mode: used,
            seconds: (performance.now() - t0) / 1000,
          },
        });
      })
      .catch((err) => {
        if (err instanceof CancelledError) {
          patch(next.id, { status: 'queued', progress: 0, phase: null });
        } else {
          console.error(`[ts-to-mp4] ${next.file.name} failed:`, err, '\n' + log.join('\n'));
          patch(next.id, { status: 'error', phase: null, error: err.message || String(err) });
        }
      })
      .finally(() => setActiveId(null));
  }, [running, activeId, jobs, mode, convert, patch]);

  const startBatch = () => setRunning(true);

  const stop = () => {
    setRunning(false);
    cancel();
  };

  const remove = (id) => {
    if (id === viewingId) setViewingId(null);
    if (id === activeId) return;
    setSelectedIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setJobs((prev) => {
      const j = prev.find((x) => x.id === id);
      if (j?.result) URL.revokeObjectURL(j.result.url);
      // Remembered so re-uploading this same file later is skipped automatically.
      if (j) addDismissed([j.file.name]);
      return prev.filter((x) => x.id !== id);
    });
  };

  const retry = (id) => {
    patch(id, { status: 'queued', error: '', progress: 0 });
    if (!running) startBatch();
  };

  const clearFinished = () => {
    setJobs((prev) => {
      const doneIds = new Set(prev.filter((j) => j.status === 'done').map((j) => j.id));
      setSelectedIds((sel) => {
        if (![...doneIds].some((id) => sel.has(id))) return sel;
        const next = new Set(sel);
        doneIds.forEach((id) => next.delete(id));
        return next;
      });
      return prev.filter((j) => {
        if (j.status !== 'done') return true;
        URL.revokeObjectURL(j.result.url);
        return false;
      });
    });
  };

  const rename = (id, value) => patch(id, { customName: value.trim() ? value : null });

  // Plain click (on a checkbox) or cmd/ctrl-click (on a row): toggle just this one, and it
  // becomes the anchor a following shift-click ranges from — same as Finder/Gmail/etc.
  const toggleSelect = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setSelectionAnchorId(id);
  };

  // Shift-click: select the contiguous run of done, visible rows between the anchor and this one
  // (added to whatever's already selected, not replacing it), without moving the anchor.
  const selectRange = (targetId) => {
    const ids = visibleJobs.filter((j) => j.status === 'done').map((j) => j.id);
    const anchor = selectionAnchorId !== null && ids.includes(selectionAnchorId) ? selectionAnchorId : targetId;
    const a = ids.indexOf(anchor);
    const b = ids.indexOf(targetId);
    if (a === -1 || b === -1) return;
    const [lo, hi] = a < b ? [a, b] : [b, a];
    const range = ids.slice(lo, hi + 1);
    setSelectedIds((prev) => new Set([...prev, ...range]));
    if (selectionAnchorId === null) setSelectionAnchorId(targetId);
  };

  const toggleSelectAll = () => {
    const doneIds = jobs.filter((j) => j.status === 'done').map((j) => j.id);
    const allSelected = doneIds.length > 0 && doneIds.every((id) => selectedIds.has(id));
    setSelectedIds(allSelected ? new Set() : new Set(doneIds));
    setSelectionAnchorId(null);
  };

  // A real folder, unlike the old approach of putting "/" in a `download` attribute (Chrome just
  // sanitizes that to "_" instead of creating one) — a .zip becomes a real folder once extracted.
  const zipAndDownload = async (list) => {
    if (!list.length) return;
    setZipping(true);
    try {
      const zip = new JSZip();
      const used = new Map(); // dedupe filenames that collide after renaming/hyphenation
      for (const j of list) {
        let name = downloadFilename(j);
        const n = (used.get(name) || 0) + 1;
        used.set(name, n);
        if (n > 1) name = name.replace(/(\.mp4)?$/, (ext) => ` (${n})${ext}`);
        zip.file(name, j.result.blob);
      }
      const blob = await zip.generateAsync({ type: 'blob' });
      const name = zipName.trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/^\.+/, '').slice(0, 80) || 'converted-videos';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${name}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } finally {
      setZipping(false);
    }
  };

  const downloadAll = () => zipAndDownload(jobsRef.current.filter((x) => x.status === 'done'));
  const downloadSelected = async () => {
    await zipAndDownload(jobsRef.current.filter((x) => x.status === 'done' && selectedIds.has(x.id)));
    setSelectedIds(new Set());
  };

  const counts = jobs.reduce((c, j) => ({ ...c, [j.status]: (c[j.status] || 0) + 1 }), {});
  const total = jobs.length;
  const finished = (counts.done || 0) + (counts.error || 0);
  const active = jobs.find((j) => j.id === activeId);
  const activePos = active ? jobs.indexOf(active) + 1 : 0;
  const overall = total ? (finished + (active ? active.progress : 0)) / total : 0;
  const selectedDoneCount = jobs.filter((j) => j.status === 'done' && selectedIds.has(j.id)).length;
  const allDoneSelected = (counts.done || 0) > 0 && selectedDoneCount === counts.done;
  const doneJobsForViewer = visibleJobs.filter((j) => j.status === 'done');

  return (
    <main className="app">
      <header>
        <h1>TS → MP4</h1>
        <p className="sub">
          Batch convert MPEG transport stream (.ts) recordings to MP4. Everything runs in the browser with
          FFmpeg (WebAssembly) — your videos never leave this machine.
        </p>
      </header>

      <section
        className={`drop ${dragging ? 'drag' : ''}`}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          addFiles(e.dataTransfer.files);
        }}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".ts,.mts,.m2ts,video/mp2t,.jpg,.jpeg,.png,image/jpeg,image/png"
          hidden
          onChange={(e) => {
            addFiles(e.target.files);
            e.target.value = '';
          }}
        />
        <strong>Drop .ts files here</strong>
        <span className="small-note">or click to browse — you can add more while a batch runs.</span>
        <span className="small-note">Under {MIN_SIZE_MB} MB is skipped. Pair a same-named .jpg to use as its thumbnail.</span>
      </section>

      {dismissed.size > 0 && (
        <div className="dismissed-note muted small-note">
          <span>
            {dismissed.size} previously removed file{dismissed.size > 1 ? 's are' : ' is'} skipped automatically on
            upload.
          </span>
          <button className="link" onClick={clearDismissed}>
            Clear list
          </button>
        </div>
      )}

      {toast && <Toast key={toast.id} message={toast.message} onClose={() => setToast(null)} />}

      <fieldset className="modes" disabled={running}>
        <legend>Conversion method</legend>
        <div className="segmented">
          {[
            ['auto', 'Auto', 'Copies what macOS can play as-is, re-encodes only what it can\'t.'],
            ['remux', 'Stream copy', 'Seconds, lossless. Fails if the video must be re-encoded to play on a Mac.'],
            ['encode', 'Re-encode', 'H.264 + AAC. Works for any input, but much slower.'],
          ].map(([value, label, hint]) => (
            <label key={value} className={mode === value ? 'on' : ''}>
              <input type="radio" name="mode" value={value} checked={mode === value} onChange={() => setMode(value)} />
              <span>{label}</span>
              <InfoTip text={hint} />
            </label>
          ))}
        </div>
      </fieldset>


      {total > 0 && (
        <section className="batch">
          <div className="batch-head">
            <div className="batch-status">
              {running && active ? (
                <>
                  <strong>
                    Converting {activePos} of {total}
                  </strong>
                  <span className="muted ellipsis">{active.file.name}</span>
                </>
              ) : (
                <strong>
                  {total} file{total > 1 ? 's' : ''}
                  <span className="chips">
                    {(counts.done || 0) > 0 && <span className="chip">{counts.done} done</span>}
                    {counts.error > 0 && <span className="chip">{counts.error} failed</span>}
                    {counts.queued > 0 && <span className="chip">{counts.queued} queued</span>}
                  </span>
                </strong>
              )}
            </div>
            <div className="actions">
              {running ? (
                <button className="secondary" onClick={stop}>
                  Stop
                </button>
              ) : (
                counts.queued > 0 && (
                  <button className="primary" onClick={startBatch}>
                    {counts.done || counts.error ? `Convert ${counts.queued} queued` : `Convert all (${total})`}
                  </button>
                )
              )}
              {counts.done > 1 && (
                <span className="dl-group">
                  <label className="select-all">
                    <input
                      type="checkbox"
                      checked={allDoneSelected}
                      onChange={toggleSelectAll}
                      aria-label="Select all converted files"
                    />
                    Select all
                  </label>
                  <input
                    type="text"
                    className="dl-folder"
                    placeholder="Zip name"
                    aria-label="Name for the download zip file"
                    value={zipName}
                    onChange={(e) => setZipName(e.target.value)}
                    maxLength={80}
                    disabled={zipping}
                  />
                  {selectedDoneCount > 0 ? (
                    <button className="secondary" onClick={downloadSelected} disabled={zipping}>
                      {zipping ? 'Zipping…' : `Download selected as .zip (${selectedDoneCount})`}
                    </button>
                  ) : (
                    <button className="secondary" onClick={downloadAll} disabled={zipping}>
                      {zipping ? 'Zipping…' : `Download all as .zip (${counts.done})`}
                    </button>
                  )}
                </span>
              )}
              {favCount > 0 && (
                <button
                  className={`secondary fav-filter ${favoritesOnly ? 'on' : ''}`}
                  aria-pressed={favoritesOnly}
                  onClick={() => setFavoritesOnly((v) => !v)}
                >
                  ★ Favorites ({favCount})
                </button>
              )}
              {counts.done > 0 && !running && (
                <button className="link" onClick={clearFinished}>
                  Clear done
                </button>
              )}
            </div>
          </div>

          {(running || finished > 0) && (
            <div className="bar thin" aria-label="Overall progress">
              <div style={{ transform: `scaleX(${overall})` }} />
            </div>
          )}

          <ul className="jobs">
            {visibleJobs.map((job) => {
              const isViewing = job.id === viewingId;
              return (
                <JobRow
                  key={job.id}
                  job={job}
                  index={jobs.indexOf(job) + 1}
                  thumb={thumbs[baseKey(job.file.name)]}
                  favorite={isFavorite(job.file)}
                  onToggleFavorite={() => toggleFavorite(job.file)}
                  isActive={job.id === activeId}
                  isViewing={isViewing}
                  isLast={job.id === lastId}
                  isSelected={selectedIds.has(job.id)}
                  onToggleSelect={() => toggleSelect(job.id)}
                  onRangeSelect={() => selectRange(job.id)}
                  onInteract={() => setLastId(job.id)}
                  onView={() => setViewingId(job.id)}
                  onRemove={() => remove(job.id)}
                  onRetry={() => retry(job.id)}
                  onRename={(value) => rename(job.id, value)}
                  // Only used when isViewing — the viewer renders nested inside this row so it
                  // visually reads as one card instead of two bordered pieces with a gap.
                  viewerJobs={doneJobsForViewer}
                  onChangeViewing={setViewingId}
                  onCloseViewing={() => setViewingId(null)}
                  viewingRowRef={isViewing ? viewingRowRef : undefined}
                />
              );
            })}
          </ul>
        </section>
      )}

      <footer className="muted">
        Files convert one at a time; each input and output sits in browser memory, so single files over ~2 GB may fail.
        "Download all" bundles every converted file into one .zip.
      </footer>
    </main>
  );
}

function JobRow({
  job,
  index,
  thumb,
  favorite,
  onToggleFavorite,
  isActive,
  isViewing,
  isLast,
  isSelected,
  onToggleSelect,
  onRangeSelect,
  onInteract,
  onView,
  onRemove,
  onRetry,
  onRename,
  viewerJobs,
  onChangeViewing,
  onCloseViewing,
  viewingRowRef,
}) {
  const { file, status, phase, progress, result, error } = job;
  const pct = Math.round(progress * 100);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const editRef = useRef(null);
  // Checkboxes' native 'change' event carries no modifier-key info (it's a plain Event, not a
  // MouseEvent), so the shift state is captured on the preceding 'click' (which does have it —
  // click always fires immediately before change) and read back when 'change' fires.
  const checkShiftRef = useRef(false);

  const indeterminate = isActive && (phase === 'loading' || phase === 'reading');
  const name = baseName(job);

  const startEdit = () => {
    setDraft(name);
    setEditing(true);
  };
  const commit = () => {
    setEditing(false);
    onRename(draft);
  };

  useEffect(() => {
    if (editing) editRef.current?.select();
  }, [editing]);

  return (
    <li
      ref={viewingRowRef}
      className={`job ${status} ${isActive ? 'active' : ''} ${isViewing ? 'viewing' : ''} ${isLast ? 'last' : ''} ${status !== 'done' ? 'no-view' : ''}`}
      onPointerDown={(e) => {
        if (e.shiftKey) e.preventDefault(); // stop native text-selection drag during shift-click
        onInteract();
      }}
      onClick={(e) => {
        // Row acts as "View" everywhere except its buttons/links/rename field (star, download, retry, remove, rename),
        // and only once the file has actually converted — nothing to watch before that. Shift/cmd/ctrl-click select
        // instead of viewing, same as Finder/Gmail/etc: shift extends a range from the last pick, cmd/ctrl toggles one.
        if (status !== 'done') return;
        if (e.target.closest('button, a, input')) return;
        if (e.shiftKey) return onRangeSelect();
        if (e.metaKey || e.ctrlKey) return onToggleSelect();
        onView();
      }}
    >
      <div className="job-main">
        {status === 'done' && (
          <input
            type="checkbox"
            className="select-check"
            checked={isSelected}
            onClick={(e) => {
              e.stopPropagation();
              checkShiftRef.current = e.shiftKey;
            }}
            onChange={() => {
              // The native toggle already ran (or didn't); either way this is a controlled input,
              // so the next render sets `checked` to whatever our selection state says regardless.
              if (checkShiftRef.current) onRangeSelect();
              else onToggleSelect();
            }}
            aria-label={`Select ${name}`}
          />
        )}
        {thumb ? (
          <img className="thumb" src={thumb} alt="" />
        ) : (
          <div className="thumb thumb-empty" aria-hidden="true" />
        )}
        <div className="job-info">
          <div className="job-name">
            <span className="muted idx">{index}.</span>
            {editing ? (
              <input
                ref={editRef}
                type="text"
                className="name-edit"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commit}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                  if (e.key === 'Escape') setEditing(false);
                }}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <>
                <span className="ellipsis" title={file.name}>
                  {name}
                </span>
                <StatusIcon status={status} />
                <button
                  type="button"
                  className="icon rename-btn"
                  aria-label={`Rename ${name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    startEdit();
                  }}
                >
                  <IconPencil />
                </button>
              </>
            )}
          </div>
          <div className="job-meta muted">
            {formatBytes(file.size)}
            {status === 'queued' && ' · Waiting'}
            {status === 'converting' && ` · ${PHASE_LABEL[phase] || 'Starting…'}${indeterminate ? '' : ` ${pct}%`}`}
            {status === 'done' &&
              ` · ${result.seconds.toFixed(1)}s`}
            {status === 'error' && <span className="error-text"> · {error}</span>}
          </div>
        </div>
        <div className="job-actions">
          <span className="fav-dl">
            <StarButton on={favorite} name={file.name} onClick={onToggleFavorite} />
            {status === 'done' && (
              <a className="secondary small" href={result.url} download={downloadFilename(job)}>
                <IconDownload />
                Download
              </a>
            )}
          </span>
          {status === 'error' && (
            <button className="secondary small" onClick={onRetry}>
              Retry
            </button>
          )}
          {!isActive && (
            <button className="icon" aria-label={`Remove ${file.name}`} onClick={onRemove}>
              <IconX />
            </button>
          )}
        </div>
      </div>

      {status === 'converting' && (
        <div className="bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div className={indeterminate ? 'indeterminate' : ''} style={{ transform: `scaleX(${indeterminate ? 1 : progress})` }} />
        </div>
      )}

      {isViewing && (
        <Viewer
          jobs={viewerJobs}
          viewingId={job.id}
          onChange={onChangeViewing}
          onClose={onCloseViewing}
          onToggleFavorite={onToggleFavorite}
        />
      )}
    </li>
  );
}

function Toast({ message, onClose }) {
  return (
    <div className="toast" role="status">
      <span>{message}</span>
      <button className="icon" aria-label="Dismiss" onClick={onClose}>
        <IconX />
      </button>
    </div>
  );
}

function InfoTip({ text }) {
  const [open, setOpen] = useState(false);
  return (
    <span
      className="info-tip"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        className="info-tip-btn"
        aria-label="More info"
        aria-expanded={open}
        onClick={(e) => {
          e.preventDefault();
          setOpen((o) => !o);
        }}
        onBlur={() => setOpen(false)}
      >
        <IconInfo />
      </button>
      {open && (
        <span className="info-tip-bubble" role="tooltip">
          {text}
        </span>
      )}
    </span>
  );
}

function StatusIcon({ status }) {
  if (status === 'converting') return <span className="spinner" role="status" aria-label="Converting" />;
  const map = { queued: [IconCircle, 'Queued'], done: [IconCheck, 'Done'], error: [IconAlert, 'Failed'] };
  const [Icon, label] = map[status];
  return (
    <span className={`status-icon ${status}`} role="img" aria-label={label}>
      <Icon />
    </span>
  );
}
