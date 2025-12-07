export const EMPLOYEE_COLOR_PALETTE = [
  '#f9c74f', // warm yellow
  '#ef476f', // vivid pink-red
  '#118ab2', // deep teal-blue
  '#9b5de5', // purple
  '#06d6a0', // mint green
  '#ff8fab', // soft rose
  '#ffd166', // golden orange
  '#5c7aff', // clear blue
];

export type EmployeeDoc = { id: string; data(): any };

export function normalizeEmployeeColor(value: any): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const match = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(trimmed);
  if (!match) return null;
  let hex = match[1];
  if (hex.length === 3) {
    hex = hex
      .split('')
      .map((c) => c + c)
      .join('');
  }
  return `#${hex.toLowerCase()}`;
}

export function fallbackEmployeeColor(id: string, palette: string[] = EMPLOYEE_COLOR_PALETTE): string {
  if (!palette.length) return '#c8d6df';
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = (h * 31 + id.charCodeAt(i)) >>> 0;
  }
  return palette[h % palette.length] || '#c8d6df';
}

export function assignEmployeeColors(
  docs: EmployeeDoc[],
  seed: string,
  palette: string[] = EMPLOYEE_COLOR_PALETTE
): Map<string, string> {
  const normalizedPalette = palette
    .map((c) => normalizeEmployeeColor(c))
    .filter((c): c is string => !!c);
  const paletteList = normalizedPalette.length ? normalizedPalette : ['#c8d6df'];
  const rng = makeRng(seed || 'color-seed');
  const shuffled = shuffle([...paletteList], rng);

  const assigned = new Map<string, string>();
  const used = new Set<string>();

  // Keep any stored colors first so we do not override user data.
  for (const doc of docs) {
    const data = (doc.data() as any) || {};
    const stored = normalizeEmployeeColor(data.calendarColor || data.color);
    if (stored) {
      assigned.set(doc.id, stored);
      used.add(stored);
    }
  }

  const available = shuffled.filter((c) => !used.has(c));
  let paletteIndex = 0;

  for (const doc of docs) {
    if (assigned.has(doc.id)) continue;
    const pick =
      available.length > 0
        ? available.shift()!
        : shuffled[(paletteIndex++) % shuffled.length];
    assigned.set(doc.id, pick || fallbackEmployeeColor(doc.id, paletteList));
  }

  return assigned;
}

function shuffle<T>(arr: T[], rng: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function makeRng(seed: string): () => number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return () => {
    h = (h * 1664525 + 1013904223) >>> 0;
    return (h >>> 0) / 0xffffffff;
  };
}
