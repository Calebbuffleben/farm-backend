/** URL permanente do MP3 da gravação Twilio (a URL do callback não é a fonte). */
export function twilioRecordingUrl(ref: {
  recordingUrl?: string | null;
  recordingSid?: string | null;
  accountSid?: string | null;
}): string {
  const raw = (ref.recordingUrl ?? '').trim();
  if (raw.startsWith('http')) {
    const withoutQuery = raw.split('?')[0].replace(/\/$/, '');
    return withoutQuery.endsWith('.mp3') ? withoutQuery : `${withoutQuery}.mp3`;
  }
  if (ref.accountSid && ref.recordingSid) {
    return `https://api.twilio.com/2010-04-01/Accounts/${ref.accountSid}/Recordings/${ref.recordingSid}.mp3`;
  }
  throw new Error('twilio mediaRef missing recordingUrl and recordingSid');
}

export function e164(raw: string | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 8) return null;
  return `+${digits}`;
}
