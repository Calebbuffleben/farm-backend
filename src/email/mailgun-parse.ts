import { extractEmail } from '../channel/peer-address';

export const EMAIL_MAX_ATTACHMENTS = 10;
export const EMAIL_MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;

export function emailExternalId(
  messageId: string | undefined,
  timestamp: string,
  token: string,
): string {
  const id = (messageId ?? '').replace(/^<|>$/g, '').trim();
  if (id) return `email:${id}`;
  return `email:mg:${timestamp}:${token}`;
}

export function parseMailgunHeaders(
  raw: string | undefined,
): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    const out: Record<string, string> = {};
    if (!Array.isArray(parsed)) return out;
    for (const row of parsed) {
      if (Array.isArray(row) && row.length >= 2) {
        out[String(row[0]).toLowerCase()] = String(row[1]);
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function shouldDiscardInbound(input: {
  sender: string;
  headers: Record<string, string>;
}): boolean {
  const email = extractEmail(input.sender) ?? '';
  const local = email.split('@')[0] ?? '';
  if (local === 'mailer-daemon' || local.startsWith('mailer-daemon')) {
    return true;
  }
  if (local === 'noreply' || local.startsWith('noreply')) return true;
  const auto = input.headers['auto-submitted'];
  if (auto && auto.toLowerCase() !== 'no') return true;
  const precedence = (input.headers['precedence'] ?? '').toLowerCase();
  if (precedence === 'bulk' || precedence === 'list' || precedence === 'junk') {
    return true;
  }
  // List-Unsubscribe sozinho aparece em e-mail corporativo de produtor.
  return Boolean(input.headers['list-id']);
}

export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

export function composeEmailBody(
  subject: string,
  plain: string,
  html: string,
): string {
  let text = plain.trim();
  if (!text) text = stripHtml(html);
  const sub = subject.trim();
  if (!sub && !text) return '';
  if (!sub) return text;
  return `Assunto: ${sub}${text ? `\n\n${text}` : ''}`;
}

/** Assunto do reply: thread existente ganha Re:; thread nova usa o pedido ou o corpo. */
export function emailOutboundSubject(
  stored: string | null | undefined,
  requested: string | undefined,
  body: string,
): string {
  const existing = stored?.trim();
  if (existing) {
    return /^re:\s/i.test(existing) ? existing : `Re: ${existing}`;
  }
  const asked = requested?.trim();
  if (asked) return asked;
  return body.trim().slice(0, 80) || 'Mensagem';
}

export function recipientAddresses(raw: string): string[] {
  return raw
    .split(/[,;]/)
    .map((part) => extractEmail(part))
    .filter((v): v is string => Boolean(v));
}

export type InboundAttachment = {
  filename: string;
  mimeType: string;
  size: number;
  buffer?: Buffer;
  url?: string;
};

export function collectAttachments(
  fields: Record<string, string>,
  files: { fieldname: string; originalname: string; mimetype: string; size: number; buffer: Buffer }[],
): InboundAttachment[] {
  const fromFiles = files
    .filter((f) => /^attachment-\d+$/i.test(f.fieldname) || f.fieldname.startsWith('attachment-'))
    .map((f) => ({
      filename: f.originalname || f.fieldname,
      mimeType: f.mimetype || 'application/octet-stream',
      size: f.size,
      buffer: f.buffer,
    }));
  if (fromFiles.length) return fromFiles;

  const urls: InboundAttachment[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (!/^attachment-\d+$/i.test(key)) continue;
    if (!value.startsWith('http')) continue;
    urls.push({
      filename: key,
      mimeType: 'application/octet-stream',
      size: 0,
      url: value,
    });
  }
  return urls;
}

export function takeAttachmentBudget(
  items: InboundAttachment[],
): { kept: InboundAttachment[]; dropped: number } {
  const kept: InboundAttachment[] = [];
  let bytes = 0;
  let dropped = 0;
  for (const item of items) {
    const size = item.size || item.buffer?.length || 0;
    if (kept.length >= EMAIL_MAX_ATTACHMENTS || bytes + size > EMAIL_MAX_ATTACHMENT_BYTES) {
      dropped++;
      continue;
    }
    kept.push(item);
    bytes += size;
  }
  return { kept, dropped };
}
