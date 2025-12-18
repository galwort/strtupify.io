export type AvatarMood = 'neutral' | 'happy' | 'sad' | 'angry';
export type EndgameOutcome = 'success' | 'failure' | 'unknown';

const AVATAR_API_URL = 'https://fa-strtupifyio.azurewebsites.net/api/avatar';
const MOOD_SUFFIX = /_(neutral|happy|sad|angry)$/i;
const DEFAULT_AVATAR_CONTAINER = 'avatars';
const CONSULTANT_AVATAR_CONTAINER = 'consultants';

function applyMoodSuffix(raw: string, mood: AvatarMood, stripSvgExtension = false): string {
  const extMatch = raw.match(/\.[a-z0-9]+$/i);
  const ext = extMatch ? extMatch[0] : '';
  const shouldStrip = stripSvgExtension && ext.toLowerCase() === '.svg';
  const base = extMatch ? raw.slice(0, raw.length - ext.length) : raw;
  const cleaned = base.replace(MOOD_SUFFIX, '');
  const suffix = shouldStrip ? '' : ext;
  return `${cleaned}_${mood}${suffix}`;
}

function stripMoodSuffix(raw: string): string {
  const extMatch = raw.match(/\.[a-z0-9]+$/i);
  const ext = extMatch ? extMatch[0] : '';
  const base = extMatch ? raw.slice(0, raw.length - ext.length) : raw;
  const cleaned = base.replace(MOOD_SUFFIX, '');
  return `${cleaned}${ext}`;
}

function ensureSvgExtension(name: string): string {
  if (!name) return '';
  return name.toLowerCase().endsWith('.svg') ? name : `${name}.svg`;
}

function parseAvatarSource(raw: string, containerOverride?: string): { name: string; container: string; supportsMood: boolean } {
  const trimmed = raw.trim();
  const containerFromOverride = String(containerOverride || '').trim();
  let container = containerFromOverride || DEFAULT_AVATAR_CONTAINER;
  let name = trimmed;

  const containerMatch = trimmed.match(/^([a-z0-9_-]+)\/(.+)$/i);
  if (containerMatch) {
    const candidateContainer = containerMatch[1].toLowerCase();
    if (
      candidateContainer === DEFAULT_AVATAR_CONTAINER ||
      candidateContainer === CONSULTANT_AVATAR_CONTAINER
    ) {
      container = containerMatch[1];
      name = containerMatch[2];
    }
  }

  const normalizedContainer = container.toLowerCase() || DEFAULT_AVATAR_CONTAINER;
  const consultantName = /^consultant_\d+/i.test(name);
  const isConsultant = consultantName || normalizedContainer === CONSULTANT_AVATAR_CONTAINER;

  return {
    name,
    container: isConsultant ? CONSULTANT_AVATAR_CONTAINER : normalizedContainer,
    supportsMood: !isConsultant,
  };
}

export function buildAvatarUrl(name: string, mood: AvatarMood = 'neutral', containerOverride?: string): string {
  if (!name) return '';
  const trimmed = name.trim();
  if (!trimmed) return '';

  const withMood = (value: string, stripSvgExtension = false, m: AvatarMood = mood) =>
    applyMoodSuffix(value, m, stripSvgExtension);

  // If a full URL is provided, try to swap the mood suffix instead of ignoring it.
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      const containerParam = (url.searchParams.get('container') || '').toLowerCase();
      if (containerParam === CONSULTANT_AVATAR_CONTAINER || url.pathname.toLowerCase().includes('/consultants/')) {
        return url.toString();
      }
      const nameParam = url.searchParams.get('name');
      if (nameParam) {
        url.searchParams.set('name', withMood(nameParam));
        return url.toString();
      }
      const parts = url.pathname.split('/');
      const last = parts[parts.length - 1] || '';
      const updated = withMood(last);
      if (updated !== last) {
        parts[parts.length - 1] = updated;
        url.pathname = parts.join('/');
        return url.toString();
      }
    } catch {
      // fall through and return the original URL
    }
    return trimmed;
  }

  const source = parseAvatarSource(trimmed, containerOverride);
  const safeMood = source.supportsMood ? mood : 'neutral';
  const cleanedName = stripMoodSuffix(source.name);
  const finalName = source.supportsMood
    ? withMood(cleanedName, true, safeMood)
    : ensureSvgExtension(stripMoodSuffix(cleanedName));

  const params = new URLSearchParams({ name: finalName });
  if (source.container !== DEFAULT_AVATAR_CONTAINER) {
    params.set('container', source.container);
  }

  return `${AVATAR_API_URL}?${params.toString()}`;
}

export function supportsAvatarMood(name: string, containerOverride?: string): boolean {
  return parseAvatarSource(name || '', containerOverride).supportsMood;
}

export function normalizeAvatarMood(name: string, desiredMood: AvatarMood, containerOverride?: string): AvatarMood {
  return supportsAvatarMood(name, containerOverride) ? desiredMood : 'neutral';
}

export function burnoutMood(stress?: number, status?: string): AvatarMood | null {
  const normalizedStatus = String(status || '').toLowerCase();
  if (normalizedStatus === 'burnout') return 'sad';
  if (typeof stress === 'number' && stress >= 90) return 'sad';
  return null;
}

export function normalizeOutcomeStatus(status?: string, estimatedRevenue?: number | null): EndgameOutcome {
  const raw = String(status || '').toLowerCase();
  if (raw.includes('fail') || raw.includes('angry') || raw.includes('mad') || raw.includes('lost') || raw.includes('loss')) {
    return 'failure';
  }
  if (raw.includes('success') || raw.includes('win') || raw.includes('great') || raw.includes('good') || raw.includes('positive')) {
    return 'success';
  }
  if (typeof estimatedRevenue === 'number') {
    if (estimatedRevenue > 0) return 'success';
    return 'failure';
  }
  return 'unknown';
}

export function outcomeMood(outcome?: EndgameOutcome | string | null): AvatarMood {
  if (!outcome) return 'neutral';
  const raw = String(outcome).toLowerCase();
  if (raw === 'success') return 'happy';
  if (raw === 'failure') return 'angry';
  if (raw.includes('success')) return 'happy';
  if (raw.includes('fail')) return 'angry';
  return 'neutral';
}
