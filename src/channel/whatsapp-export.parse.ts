import { createHash } from 'crypto';

/**
 * Export .txt do WhatsApp (Android/iOS pt-BR). Mesmos regex de
 * farm/intelligence/scripts/fase0_parse_whatsapp_txt.py — se um mudar, mude o outro.
 *
 *   12/03/2026 14:05 - João: mensagem
 *   [12/03/2026, 14:05:33] João: mensagem
 */
const LINE_PATTERNS = [
  /^(?<date>\d{2}\/\d{2}\/\d{4}),?\s+(?<time>\d{2}:\d{2})(?::(?<sec>\d{2}))?\s+-\s+(?<name>[^:]+):\s?(?<text>.*)$/,
  /^\[(?<date>\d{2}\/\d{2}\/\d{4}),?\s+(?<time>\d{2}:\d{2})(?::(?<sec>\d{2}))?\]\s+(?<name>[^:]+):\s?(?<text>.*)$/,
];

const MEDIA_MARKERS = [
  '<Arquivo de mídia oculto>',
  '<Media omitted>',
  'áudio ocultado',
  'imagem ocultada',
];

/** O export não traz fuso; o WhatsApp grava no horário local do celular. */
export const EXPORT_TZ_OFFSET = '-03:00';

export interface ParsedLine {
  sender: string;
  text: string;
  sentAt: Date;
  media: boolean;
}

export interface ExportLine extends ParsedLine {
  direction: 'IN' | 'OUT';
}

/** Linha → mensagens (multilinha agrupada). Sem direção: quem sou eu vem depois. */
export function parseWhatsappExportTxt(content: string): ParsedLine[] {
  const out: ParsedLine[] = [];
  let current: ParsedLine | null = null;
  // BOM + LTR marks que o iOS coloca antes da data
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.replace(/[\u200e\u200f]/g, '');
    let m: RegExpMatchArray | null = null;
    for (const pat of LINE_PATTERNS) {
      m = line.match(pat);
      if (m) break;
    }
    if (m?.groups) {
      if (current) out.push(current);
      const text = m.groups.text.trim();
      current = {
        sender: m.groups.name.trim(),
        text,
        sentAt: toDate(m.groups.date, m.groups.time, m.groups.sec),
        media: MEDIA_MARKERS.some((marker) => text.includes(marker)),
      };
    } else if (current && line.trim()) {
      current.text += `\n${line.trim()}`;
    }
  }
  if (current) out.push(current);
  return out;
}

function toDate(date: string, time: string, sec?: string): Date {
  const [d, mo, y] = date.split('/');
  return new Date(`${y}-${mo}-${d}T${time}:${sec ?? '00'}${EXPORT_TZ_OFFSET}`);
}

/** Remetentes distintos com contagem — a UI pergunta "qual desses é você?". */
export function listSenders(lines: ParsedLine[]): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const l of lines) counts.set(l.sender, (counts.get(l.sender) ?? 0) + 1);
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

export function withDirection(lines: ParsedLine[], rtvName: string): ExportLine[] {
  const me = rtvName.trim().toLowerCase();
  return lines.map((l) => ({
    ...l,
    direction: l.sender.toLowerCase().includes(me) ? 'OUT' : 'IN',
  }));
}

/**
 * Idempotência do reimport. ponytail: duas mensagens iguais no mesmo minuto
 * colapsam numa só (o export não tem id); aceito — reimportar nunca duplica.
 */
export function exportExternalId(
  endpointId: string,
  peerPhone: string,
  line: ParsedLine,
): string {
  const hash = createHash('sha256')
    .update(`${endpointId}|${peerPhone}|${line.sentAt.toISOString()}|${line.sender}|${line.text}`)
    .digest('hex');
  return `export:${hash.slice(0, 32)}`;
}
