// Authored icon set — one consistent 16px grid, 1.5 stroke, currentColor.
// No unicode glyphs or emoji standing in for icons.
const base = {
  width: 16,
  height: 16,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
  focusable: false,
};

export function IconStar({ filled = false }) {
  return (
    <svg {...base} fill={filled ? 'currentColor' : 'none'}>
      <path d="M12 3.75l2.6 5.27 5.82.85-4.21 4.1 1 5.8L12 17.04l-5.21 2.73 1-5.8-4.21-4.1 5.82-.85z" />
    </svg>
  );
}

export function IconPencil() {
  return (
    <svg {...base}>
      <path d="M4.5 19.5h4L19 9a2.12 2.12 0 0 0-3-3L5.5 16.5z" />
      <path d="M14.75 6.75l2.5 2.5" />
    </svg>
  );
}

export function IconX() {
  return (
    <svg {...base}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

export function IconCheck() {
  return (
    <svg {...base}>
      <path d="M5 12.5l4.6 4.6L19 7" />
    </svg>
  );
}

export function IconAlert() {
  return (
    <svg {...base}>
      <path d="M12 7.5v5.5" />
      <path d="M12 16.5h.01" />
    </svg>
  );
}

export function IconCircle() {
  return (
    <svg {...base}>
      <circle cx="12" cy="12" r="7.25" />
    </svg>
  );
}

export function IconInfo() {
  return (
    <svg {...base}>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 11.25v5" />
      <path d="M12 8h.01" />
    </svg>
  );
}

export function IconDownload() {
  return (
    <svg {...base}>
      <path d="M12 4.5v10" />
      <path d="M8 11l4 4 4-4" />
      <path d="M5 19h14" />
    </svg>
  );
}
