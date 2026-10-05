import { useCallback, useRef, useState } from 'react';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';
// Bundled locally by Vite — no CDN required.
import coreURL from '@ffmpeg/core?url';
import wasmURL from '@ffmpeg/core/wasm?url';

/*
 * macOS QuickTime / Quick Look are much pickier than browsers about what's inside an MP4:
 *  - H.264 must be 8-bit 4:2:0 (High 10 / 4:2:2 / 4:4:4 won't open)
 *  - H.265 must be tagged `hvc1` (ffmpeg's default `hev1` won't open)
 *  - audio should be AAC or MP3 (MP2, AC-3, PCM, Opus etc. won't play)
 * So each file is probed first and only the parts that need it are re-encoded.
 */

/** Parse `ffmpeg -i` output for the first video and audio stream. */
export function parseStreams(lines) {
  const info = { video: null, pixFmt: null, audio: null };
  for (const line of lines) {
    if (!info.video) {
      const m = line.match(/Stream #\d+:\d+.*?: Video: (\w+)[^,]*, ([a-z0-9]+)/);
      if (m) [, info.video, info.pixFmt] = m;
    }
    if (!info.audio) {
      const m = line.match(/Stream #\d+:\d+.*?: Audio: (\w+)/);
      if (m) info.audio = m[1];
    }
  }
  return info;
}

const MAC_H264_PIX = ['yuv420p', 'yuvj420p'];
const MAC_HEVC_PIX = ['yuv420p', 'yuvj420p', 'yuv420p10le'];

/** Decide per stream: copy (fast, lossless) when macOS can play it as-is, otherwise re-encode. */
export function planFor(info) {
  let video = 'encode';
  if (info.video === 'h264' && MAC_H264_PIX.includes(info.pixFmt)) video = 'copy-avc1';
  if (info.video === 'hevc' && MAC_HEVC_PIX.includes(info.pixFmt)) video = 'copy-hvc1';

  let audio = 'encode';
  if (!info.audio) audio = 'none';
  else if (info.audio === 'aac') audio = 'copy-aac';
  else if (info.audio === 'mp3') audio = 'copy';

  return { video, audio };
}

const X264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-tag:v', 'avc1'];

export function argsFor(i, o, plan) {
  const v = {
    'copy-avc1': ['-c:v', 'copy', '-tag:v', 'avc1'],
    'copy-hvc1': ['-c:v', 'copy', '-tag:v', 'hvc1'],
    encode: X264,
  }[plan.video];
  const a = {
    'copy-aac': ['-c:a', 'copy', '-bsf:a', 'aac_adtstoasc'], // ADTS AAC (in .ts) -> MP4-style AAC
    copy: ['-c:a', 'copy'],
    encode: ['-c:a', 'aac', '-b:a', '160k'],
    none: [],
  }[plan.audio];
  return ['-i', i, '-map', '0:v:0?', '-map', '0:a?', ...v, ...a, '-movflags', '+faststart', o];
}

const FULL_ENCODE = { video: 'encode', audio: 'encode' };

export class CancelledError extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'CancelledError';
  }
}

// ffmpeg.wasm's linear memory only ever grows within one engine instance — deleting files frees
// the virtual filesystem but not the wasm heap ceiling, so a long batch of large files eventually
// traps with "RuntimeError: memory access out of bounds". Recycling (terminate + reload on the
// next file) resets that ceiling before it's hit, and after every file so the reload is cheap
// (the core is browser-cached). A trapped instance is also left unusable, so any fatal wasm error
// forces an immediate recycle too, instead of silently corrupting every file after it.
const RECYCLE_EVERY_FILES = 6;
const RECYCLE_EVERY_BYTES = 1_000_000_000; // ~1 GB of source video since the last recycle
const isFatalWasmError = (err) => /memory access out of bounds|RuntimeError|Aborted|unreachable/i.test(String(err?.message || err));

/**
 * One ffmpeg.wasm instance, loaded lazily. Jobs must run one at a time.
 * convert(file, mode, { onProgress, onLog, onPhase }) -> { blob, mode }
 *   mode: 'auto' | 'remux' | 'encode'
 * cancel() kills the running job (terminates the worker; it reloads on next use).
 */
export function useFFmpeg() {
  const ffmpegRef = useRef(null);
  const loadingRef = useRef(null);
  const handlersRef = useRef({});
  const cancelledRef = useRef(false);
  const processedRef = useRef({ count: 0, bytes: 0 }); // since the last recycle
  const [engine, setEngine] = useState('idle'); // idle | loading | ready | error

  const load = useCallback(async () => {
    if (ffmpegRef.current?.loaded) return ffmpegRef.current;
    if (loadingRef.current) return loadingRef.current;

    setEngine('loading');
    const ffmpeg = new FFmpeg();
    // Route events to whichever job is currently running
    ffmpeg.on('log', ({ message }) => handlersRef.current.onLog?.(message));
    ffmpeg.on('progress', ({ progress }) => {
      if (Number.isFinite(progress)) {
        handlersRef.current.onProgress?.(Math.min(Math.max(progress, 0), 1));
      }
    });

    loadingRef.current = ffmpeg
      .load({ coreURL, wasmURL })
      .then(() => {
        ffmpegRef.current = ffmpeg;
        setEngine('ready');
        return ffmpeg;
      })
      .catch((err) => {
        setEngine('error');
        throw err;
      })
      .finally(() => {
        loadingRef.current = null;
      });

    return loadingRef.current;
  }, []);

  // Force a fresh engine on the next convert(), without cancelling whatever the caller does next.
  const recycle = useCallback(() => {
    const ffmpeg = ffmpegRef.current;
    ffmpegRef.current = null;
    processedRef.current = { count: 0, bytes: 0 };
    setEngine('idle');
    if (ffmpeg) {
      try {
        ffmpeg.terminate();
      } catch {
        /* already dead */
      }
    }
  }, []);

  const convert = useCallback(
    async (file, mode = 'auto', handlers = {}) => {
      cancelledRef.current = false;
      handlersRef.current = handlers;
      handlers.onPhase?.('loading');
      const ffmpeg = await load();
      if (cancelledRef.current) throw new CancelledError();

      // Unique names so a terminated job can't collide with the next one
      const id = Math.random().toString(36).slice(2, 8);
      const input = `in_${id}.ts`;
      const output = `out_${id}.mp4`;
      let result;

      try {
        handlers.onPhase?.('reading');
        await ffmpeg.writeFile(input, await fetchFile(file));

        // Probe: `ffmpeg -i` with no output lists the streams (and exits non-zero, which is expected)
        const probeLog = [];
        handlersRef.current = { ...handlers, onLog: (l) => (probeLog.push(l), handlers.onLog?.(l)) };
        await ffmpeg.exec(['-hide_banner', '-i', input]);
        handlersRef.current = handlers;
        const info = parseStreams(probeLog);
        if (!info.video) throw new Error('No video stream found in this file.');

        let plan = mode === 'encode' ? FULL_ENCODE : planFor(info);
        if (mode === 'remux' && plan.video === 'encode') {
          throw new Error(
            `Its video (${info.video}, ${info.pixFmt}) can't be stream-copied into an MP4 that macOS can play. Use Auto or Re-encode.`
          );
        }
        handlers.onLog?.(`--- ${info.video}/${info.pixFmt} + ${info.audio || 'no audio'} -> video ${plan.video}, audio ${plan.audio} ---`);

        let used = plan.video === 'encode' ? 'encode' : 'remux';
        handlers.onPhase?.(used);
        let code = await ffmpeg.exec(argsFor(input, output, plan));

        if (code !== 0 && mode === 'auto' && plan !== FULL_ENCODE) {
          handlers.onLog?.('--- Copy failed, re-encoding everything ---');
          await ffmpeg.deleteFile(output).catch(() => {});
          handlers.onProgress?.(0);
          plan = FULL_ENCODE;
          used = 'encode';
          handlers.onPhase?.(used);
          code = await ffmpeg.exec(argsFor(input, output, plan));
        }

        if (code !== 0) throw new Error(`FFmpeg exited with code ${code}.`);
        const data = await ffmpeg.readFile(output);
        result = { blob: new Blob([data.buffer], { type: 'video/mp4' }), mode: used };
      } catch (err) {
        if (cancelledRef.current) throw new CancelledError();
        // A wasm trap leaves this instance unreliable for every file after it — recycle now so
        // the failure can't cascade onto the next one.
        if (isFatalWasmError(err)) recycle();
        throw err;
      } finally {
        handlersRef.current = {};
        if (ffmpeg.loaded) {
          await ffmpeg.deleteFile(input).catch(() => {});
          await ffmpeg.deleteFile(output).catch(() => {});
        }
      }

      // Healthy run: still recycle periodically so a long batch's memory ceiling never gets
      // the chance to climb high enough to trap in the first place.
      processedRef.current.count += 1;
      processedRef.current.bytes += file.size;
      if (processedRef.current.count >= RECYCLE_EVERY_FILES || processedRef.current.bytes >= RECYCLE_EVERY_BYTES) {
        recycle();
      }
      return result;
    },
    [load, recycle]
  );

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    recycle(); // rejects the in-flight exec() by killing the worker
  }, [recycle]);

  return { convert, cancel, engine };
}
