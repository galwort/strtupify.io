export type AvatarMood = 'neutral' | 'happy' | 'sad' | 'angry';

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
  const withMood = MOOD_SUFFIX.test(withoutExt) ? withoutExt : `${withoutExt}_${mood}`;
  return `${AVATAR_API_URL}?name=${encodeURIComponent(withMood)}`;
}
