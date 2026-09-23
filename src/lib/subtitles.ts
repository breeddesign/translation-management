/**
 * SRT → WebVTT Konvertierung.
 * Fallback für den Fall, dass HeyGen keine vtt_caption_url liefert.
 * SRT-Cue-Nummern sind in WebVTT gültige Cue-Identifier und bleiben erhalten.
 */
export function srtToVtt(srt: string): string {
  const normalized = srt.replace(/^\uFEFF/, "").replace(/\r/g, "");
  const withDots = normalized.replace(
    /(\d{2}:\d{2}:\d{2}),(\d{3})/g,
    "$1.$2"
  );
  return `WEBVTT\n\n${withDots.trim()}\n`;
}
