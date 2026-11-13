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

export function audioTrackGroups(formats) {
  const groups = new Map();
  for (const format of formats.filter(f => f.vcodec === 'none' && f.ext === 'm4a')) {
    const language = format.language || 'und';
    const original = /\boriginal\b/i.test(format.format_note || '') || Number(format.language_preference) > 0;
    const id = `${language}${original ? '-original' : ''}`;
    if (!groups.has(id)) {
      let label = language;
      try { label = new Intl.DisplayNames(['en'], { type: 'language' }).of(language) || language; } catch {}
      groups.set(id, { id, language, original, label: `${label}${original ? ' (Original)' : ''}`, formats: [] });
    }
    groups.get(id).formats.push(format);
  }
  return [...groups.values()].map(group => ({
    ...group, formats: group.formats.sort((a, b) => (b.abr || 0) - (a.abr || 0)).slice(0, 3),
  }));
}
