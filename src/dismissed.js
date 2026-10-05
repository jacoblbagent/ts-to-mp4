import { useCallback, useState } from 'react';

// Filenames removed from the list (the × button on a row) are remembered so re-uploading the
// same file later doesn't silently add it back — matched by original filename only, same as it
// appeared when it was removed.
const STORAGE_KEY = 'ts-to-mp4:dismissed-names';

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch {
    return new Set(); // private window / blocked storage: just won't persist
  }
}

function persist(set) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...set]));
  } catch {
    /* ignore */
  }
}

export function useDismissedNames() {
  const [dismissed, setDismissed] = useState(load);

  const addDismissed = useCallback((names) => {
    setDismissed((prev) => {
      let next = prev;
      for (const name of names) {
        if (!next.has(name)) {
          if (next === prev) next = new Set(prev);
          next.add(name);
        }
      }
      if (next !== prev) persist(next);
      return next;
    });
  }, []);

  const clearDismissed = useCallback(() => {
    persist(new Set());
    setDismissed(new Set());
  }, []);

  return { dismissed, addDismissed, clearDismissed };
}
