export type AvatarMood = 'neutral' | 'happy' | 'sad' | 'angry';
export type EndgameOutcome = 'success' | 'failure' | 'unknown';

const AVATAR_API_URL = 'https://fa-strtupifyio.azurewebsites.net/api/avatar';
const MOOD_SUFFIX = /_(neutral|happy|sad|angry)$/i;

function applyMoodSuffix(raw: string, mood: AvatarMood, stripSvgExtension = false): string {
  const extMatch = raw.match(/\.[a-z0-9]+$/i);
  const ext = extMatch ? extMatch[0] : '';
  const shouldStrip = stripSvgExtension && ext.toLowerCase() === '.svg';
  const base = extMatch ? raw.slice(0, raw.length - ext.length) : raw;
  const cleaned = base.replace(MOOD_SUFFIX, '');
  const suffix = shouldStrip ? '' : ext;
  return `${cleaned}_${mood}${suffix}`;
}

export function buildAvatarUrl(name: string, mood: AvatarMood = 'neutral'): string {
  if (!name) return '';
  const trimmed = name.trim();
  if (!trimmed) return '';

  const withMood = (value: string, stripSvgExtension = false) =>
    applyMoodSuffix(value, mood, stripSvgExtension);

  // If a full URL is provided, try to swap the mood suffix instead of ignoring it.
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
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

  const moodName = withMood(trimmed, true);
  return `${AVATAR_API_URL}?name=${encodeURIComponent(moodName)}`;
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
