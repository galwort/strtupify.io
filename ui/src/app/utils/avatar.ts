export type AvatarMood = 'neutral' | 'happy' | 'sad' | 'angry';
export type EndgameOutcome = 'success' | 'failure' | 'unknown';

const AVATAR_API_URL = 'https://fa-strtupifyio.azurewebsites.net/api/avatar';
const MOOD_SUFFIX = /_(neutral|happy|sad|angry)$/i;

export function buildAvatarUrl(name: string, mood: AvatarMood = 'neutral'): string {
  if (!name) return '';
  const trimmed = name.trim();
  if (!trimmed) return '';

  // If a full URL is already provided, keep it as-is to avoid breaking existing data.
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  const withoutExt = trimmed.replace(/\.svg$/i, '');
  const base = withoutExt.replace(MOOD_SUFFIX, '');
  const withMood = `${base}_${mood}`;
  return `${AVATAR_API_URL}?name=${encodeURIComponent(withMood)}`;
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
