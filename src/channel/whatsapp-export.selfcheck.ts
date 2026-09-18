/**
 * Check mínimo do parser (sem Jest):
 *   cd farm/backend && npx ts-node src/channel/whatsapp-export.selfcheck.ts
 */
import assert from 'assert';
import {
  exportExternalId,
  listSenders,
  parseWhatsappExportTxt,
  withDirection,
} from './whatsapp-export.parse';

const FIXTURE = [
  '12/03/2026 14:05 - João: o preço do herbicida está alto',
  '12/03/2026 14:06 - Marcos Produtor: fechamos na semana que vem',
  'se o frete couber',
  '12/03/2026 14:07 - João: <Arquivo de mídia oculto>',
  '\u200e[13/03/2026, 08:15:22] Marcos Produtor: bom dia',
].join('\n');

const lines = parseWhatsappExportTxt(FIXTURE);
assert.strictEqual(lines.length, 4, 'quatro mensagens (multilinha agrupada)');
assert.strictEqual(lines[1].text, 'fechamos na semana que vem\nse o frete couber');
assert.strictEqual(lines[2].media, true, 'mídia oculta marcada');
assert.strictEqual(
  lines[0].sentAt.toISOString(),
  '2026-03-12T17:05:00.000Z',
  'DD/MM/YYYY HH:MM em -03:00',
);
assert.strictEqual(lines[3].sentAt.toISOString(), '2026-03-13T11:15:22.000Z', 'formato iOS');

const senders = listSenders(lines);
assert.deepStrictEqual(
  senders.map((s) => s.name),
  ['João', 'Marcos Produtor'],
  'remetentes por contagem',
);

const directed = withDirection(lines, 'joão');
assert.deepStrictEqual(
  directed.map((l) => l.direction),
  ['OUT', 'IN', 'OUT', 'IN'],
);

const a = exportExternalId('ep', '+5566999990000', lines[0]);
assert.strictEqual(a, exportExternalId('ep', '+5566999990000', lines[0]), 'estável');
assert.notStrictEqual(a, exportExternalId('ep', '+5566999990000', lines[1]));
assert.match(a, /^export:[0-9a-f]{32}$/);

console.log('whatsapp-export.parse ok');
