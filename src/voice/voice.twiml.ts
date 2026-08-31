function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const SAY =
  'Esta ligação pode ser gravada para qualidade e inteligência comercial.';

export function dialTwiml(opts: {
  callerId: string;
  rtvE164?: string | null;
  clientIdentity?: string | null;
  recordingCallback: string;
}): string {
  const callerId = xmlEscape(opts.callerId);
  const cb = xmlEscape(opts.recordingCallback);
  const legs: string[] = [];
  if (opts.clientIdentity) {
    legs.push(`<Client>${xmlEscape(opts.clientIdentity)}</Client>`);
  }
  if (opts.rtvE164) {
    legs.push(`<Number>${xmlEscape(opts.rtvE164)}</Number>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="pt-BR">${SAY}</Say>
  <Dial callerId="${callerId}" record="record-from-answer" recordingStatusCallback="${cb}" recordingStatusCallbackMethod="POST" recordingStatusCallbackEvent="completed">${legs.join('')}</Dial>
</Response>`;
}

export function hangupTwiml(message: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="pt-BR">${xmlEscape(message)}</Say>
  <Hangup/>
</Response>`;
}
