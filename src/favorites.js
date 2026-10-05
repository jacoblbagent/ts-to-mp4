import { useCallback, useState } from 'react';

// Favorites are remembered by name + size, so re-adding the same file after a reload keeps its star.
const STORAGE_KEY = 'ts-to-mp4:favorites';

export const favoriteKey = (file) => `${file.name}|${file.size}`;

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch {
    return new Set(); // private window / blocked storage: favorites just won't persist
  }
}

function persist(set) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...set]));
  } catch {
    /* ignore */
  }
}

export function useFavorites() {
  const [favorites, setFavorites] = useState(load);

  const isFavorite = useCallback((file) => favorites.has(favoriteKey(file)), [favorites]);

  const toggleFavorite = useCallback((file) => {
    setFavorites((prev) => {
      const next = new Set(prev);
      const key = favoriteKey(file);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      persist(next);
      return next;
    });
  }, []);

  return { isFavorite, toggleFavorite };
}
