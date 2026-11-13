import test from 'node:test';
import assert from 'node:assert/strict';
import { selectAudioFormats } from '../audio-formats.js';

const track = (id, language, abr, extra = {}) => ({ format_id: id, language, abr, vcodec: 'none', ext: 'm4a', ...extra });
test('prefers English over a higher-bitrate dub and keeps recovery in English', () => {
  const formats = [track('es', 'es', 160), track('en-low', 'en-US', 64), track('fr', 'fr', 160), track('en', 'en', 128)];
  assert.deepEqual(selectAudioFormats(formats).map(f => f.format_id), ['en', 'en-low']);
});
test('prefers the original English track over English descriptive audio', () => {
  assert.equal(selectAudioFormats([track('descriptive', 'en', 160), track('original', 'en', 128, { format_note: 'English original' })])[0].format_id, 'original');
});
test('uses original language when English is unavailable without mixing fallback languages', () => {
  assert.deepEqual(selectAudioFormats([track('dub', 'fr', 160), track('original', 'ja', 128, { language_preference: 10 })]).map(f => f.format_id), ['original']);
});
test('handles unlabelled audio and videos without separate AAC tracks', () => {
  assert.deepEqual(selectAudioFormats([track('low', undefined, 64), track('high', undefined, 128)]).map(f => f.format_id), ['high', 'low']);
  assert.deepEqual(selectAudioFormats([{ vcodec: 'avc1', ext: 'mp4' }]), []);
});
