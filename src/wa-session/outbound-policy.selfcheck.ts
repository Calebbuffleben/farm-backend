/**
 * cd farm/backend && npx ts-node --transpile-only src/wa-session/outbound-policy.selfcheck.ts
 */
import assert from 'assert';
import {
  composeReport,
  dailyCap,
  inBusinessHours,
  isOptOutText,
  nextBusinessSlot,
  reportEligibility,
} from './outbound-policy';
import { evolutionEvent, evolutionToInbound } from './evolution-ingest';

const t0 = new Date('2026-09-14T12:00:00Z');
const h = (hours: number) => new Date(t0.getTime() + hours * 3600_000);

assert.strictEqual(dailyCap(null, t0, 50), 0, 'sem connectedAt não envia');
assert.strictEqual(dailyCap(t0, h(1), 50), 5, 'dia 1');
assert.strictEqual(dailyCap(t0, h(30), 50), 15, 'dia 2');
assert.strictEqual(dailyCap(t0, h(60), 50), 30, 'dia 3');
assert.strictEqual(dailyCap(t0, h(100), 50), 50, 'teto');
assert.strictEqual(dailyCap(t0, h(100), 20), 20, 'teto menor que rampa');

// 2026-09-14 é segunda. 12:00Z = 09:00 Brasília.
assert.strictEqual(inBusinessHours(t0), true);
assert.strictEqual(inBusinessHours(new Date('2026-09-14T22:30:00Z')), false, '19:30 BRT');
assert.strictEqual(inBusinessHours(new Date('2026-09-12T15:00:00Z')), false, 'sábado');
const slot = nextBusinessSlot(new Date('2026-09-12T15:00:00Z'));
assert.strictEqual(inBusinessHours(slot), true);
assert.ok(slot.getTime() >= new Date('2026-09-14T11:00:00Z').getTime(), 'segunda 08:00 BRT');

assert.strictEqual(isOptOutText('0'), true);
assert.strictEqual(isOptOutText(' Parar '), true);
assert.strictEqual(isOptOutText('stop.'), true);
assert.strictEqual(isOptOutText('0 obrigado'), true);
assert.strictEqual(isOptOutText('10 sacas'), false);
assert.strictEqual(isOptOutText('pode parar de mandar'), false, 'só primeira palavra');

assert.deepStrictEqual(
  reportEligibility({ optOutAt: null, lastInboundAt: h(-24), openFacts: 2, sessionActive: true, now: t0 }),
  { eligible: true, reason: null },
);
assert.strictEqual(
  reportEligibility({ optOutAt: null, lastInboundAt: h(-24 * 20), openFacts: 2, sessionActive: true, now: t0 }).eligible,
  false,
);
assert.strictEqual(
  reportEligibility({ optOutAt: t0, lastInboundAt: h(-1), openFacts: 2, sessionActive: true, now: t0 }).eligible,
  false,
);
assert.strictEqual(
  reportEligibility({ optOutAt: null, lastInboundAt: h(-1), openFacts: 0, sessionActive: true, now: t0 }).eligible,
  false,
);
assert.strictEqual(
  reportEligibility({ optOutAt: null, lastInboundAt: h(-1), openFacts: 1, sessionActive: false, now: t0 }).eligible,
  false,
);

const report = composeReport('Marcos', ['preço do herbicida alto', 'quer prazo 60 dias']);
assert.ok(report.endsWith('Responda 0 para não receber mais relatórios.'));
assert.ok(report.includes('• preço do herbicida alto'));

const ctx = { tenantId: 't', endpointId: 'e' };
const peer = '5566999001111@s.whatsapp.net';
const txt = evolutionToInbound(
  {
    event: 'messages.upsert',
    data: { key: { remoteJid: peer, fromMe: false, id: 'M1' }, messageTimestamp: 1_700_000_000, message: { conversation: 'oi' } },
  },
  ctx,
);
assert.deepStrictEqual(
  { ...txt, sentAt: txt?.sentAt.toISOString() },
  { tenantId: 't', endpointId: 'e', peerAddress: '+5566999001111', externalId: 'evo:M1', direction: 'IN', sentAt: '2023-11-14T22:13:20.000Z', type: 'TEXT', body: 'oi' },
);
const out = evolutionToInbound(
  { event: 'MESSAGES_UPSERT', data: { key: { remoteJid: peer, fromMe: true, id: 'M2' }, message: { extendedTextMessage: { text: 'oi' } } } },
  ctx,
);
assert.strictEqual(out?.direction, 'OUT');
assert.strictEqual(out?.body, 'oi', 'extendedTextMessage');
const audio = evolutionToInbound(
  { event: 'messages.upsert', data: { key: { remoteJid: peer, id: 'M3' }, message: { audioMessage: { mimetype: 'audio/ogg; codecs=opus' } } } },
  ctx,
);
assert.strictEqual(audio?.type, 'AUDIO');
assert.deepStrictEqual(
  { ...(audio?.mediaRef as Record<string, unknown>) },
  { vendor: 'evolution', messageId: 'M3', mimeType: 'audio/ogg; codecs=opus', filename: null, attempts: 0 },
);
assert.strictEqual(
  evolutionToInbound({ event: 'messages.upsert', data: { key: { remoteJid: '1203630@g.us', id: 'M4' }, message: { conversation: 'x' } } }, ctx),
  null,
  'grupo fora',
);
assert.strictEqual(
  evolutionToInbound({ event: 'messages.upsert', data: { key: { remoteJid: '9876@lid', id: 'M5' }, message: { conversation: 'x' } } }, ctx),
  null,
  'lid sem alternativa descarta',
);
const lid = evolutionToInbound(
  { event: 'messages.upsert', data: { key: { remoteJid: '9876@lid', remoteJidAlt: peer, id: 'M6' }, message: { conversation: 'x' } } },
  ctx,
);
assert.strictEqual(lid?.peerAddress, '+5566999001111', 'lid com remoteJidAlt resolve');
assert.strictEqual(evolutionEvent({ event: 'connection.update', data: { state: 'close' } }), 'disconnected');
assert.strictEqual(evolutionEvent({ event: 'CONNECTION_UPDATE', data: { state: 'open' } }), 'connected');
assert.strictEqual(evolutionEvent({ event: 'CONNECTION_UPDATE', data: { state: 'connecting' } }), 'other');
assert.strictEqual(evolutionEvent({ event: 'qrcode.updated' }), 'other');

console.log('outbound-policy + evolution-ingest ok');
