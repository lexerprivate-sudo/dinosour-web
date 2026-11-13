// YouTube can expose several dubbed AAC tracks at the same bitrate.
// Keep the selected language stable even when recovering from a failed URL.
export function selectAudioFormats(formats) {
  const language = format => String(format.language || '').toLowerCase().split(/[-_]/)[0];
  const original = format => /\boriginal\b/i.test(format.format_note || '') || Number(format.language_preference) > 0;
  const tracks = formats.filter(f => f.vcodec === 'none' && f.ext === 'm4a');
  tracks.sort((a, b) =>
    Number(language(b) === 'en') - Number(language(a) === 'en') ||
    Number(original(b)) - Number(original(a)) ||
    (b.abr || 0) - (a.abr || 0));
  if (!tracks.length) return [];
  const selectedLanguage = language(tracks[0]);
  return tracks.filter(track => language(track) === selectedLanguage);
}
