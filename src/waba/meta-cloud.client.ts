import { Logger } from '@nestjs/common';

import type { WabaCloudClient } from './waba-cloud';

/**
 * WhatsApp Cloud API direto na Meta (Tech Provider).
 * Auth: Authorization Bearer. Base: graph.facebook.com/{version}/{phone_number_id}.
 * Download: GET na URL da CDN com o mesmo Bearer — não reescreve o host (isso é
 * regra do 360dialog).
 */
export class MetaCloudClient implements WabaCloudClient {
  private readonly logger = new Logger(MetaCloudClient.name);
  private readonly graphBase: string;
  private readonly phoneBase: string;

  constructor(phoneNumberId: string) {
    const version = process.env.WABA_META_GRAPH_VERSION?.trim() || 'v21.0';
    this.graphBase = (
      process.env.WABA_META_BASE_URL?.trim() ||
      `https://graph.facebook.com/${version}`
    ).replace(/\/$/, '');
    this.phoneBase = `${this.graphBase}/${encodeURIComponent(phoneNumberId)}`;
  }

  async sendText(apiKey: string, to: string, body: string): Promise<string> {
    const res = await fetch(`${this.phoneBase}/messages`, {
      method: 'POST',
      headers: metaAuthHeaders(apiKey),
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'text',
        text: { body },
      }),
    });
    return extractWamid(await this.parse(res, 'sendText'));
  }

  async uploadMedia(
    apiKey: string,
    file: Buffer,
    contentType: string,
    filename: string,
  ): Promise<string> {
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append(
      'file',
      new Blob([new Uint8Array(file)], { type: contentType }),
      filename,
    );
    const res = await fetch(`${this.phoneBase}/media`, {
      method: 'POST',
      headers: metaAuthHeaders(apiKey, false),
      body: form,
    });
    const data = (await this.parse(res, 'uploadMedia')) as { id?: string };
    if (!data.id) throw new Error('uploadMedia: response missing media id');
    return data.id;
  }

  async sendAudio(apiKey: string, to: string, mediaId: string): Promise<string> {
    const res = await fetch(`${this.phoneBase}/messages`, {
      method: 'POST',
      headers: metaAuthHeaders(apiKey),
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'audio',
        audio: { id: mediaId },
      }),
    });
    return extractWamid(await this.parse(res, 'sendAudio'));
  }

  async getMediaUrl(apiKey: string, mediaId: string): Promise<string> {
    const res = await fetch(
      `${this.graphBase}/${encodeURIComponent(mediaId)}`,
      { headers: metaAuthHeaders(apiKey, false) },
    );
    const data = (await this.parse(res, 'getMediaUrl')) as { url?: string };
    if (!data.url) throw new Error('getMediaUrl: response missing url');
    return data.url;
  }

  async downloadMedia(
    apiKey: string,
    metaUrl: string,
  ): Promise<{ data: Buffer; contentType: string }> {
    const res = await fetch(metaUrl, {
      headers: metaAuthHeaders(apiKey, false),
    });
    if (!res.ok) {
      throw new Error(`downloadMedia HTTP ${res.status}`);
    }
    const contentType =
      res.headers.get('content-type') ?? 'application/octet-stream';
    const data = Buffer.from(await res.arrayBuffer());
    return { data, contentType };
  }

  private async parse(res: Response, op: string): Promise<unknown> {
    const text = await res.text();
    if (!res.ok) {
      this.logger.error(`${op} HTTP ${res.status}: ${text.slice(0, 500)}`);
      throw new Error(`${op} failed with HTTP ${res.status}`);
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(`${op}: non-JSON response`);
    }
  }
}

export function metaAuthHeaders(
  token: string,
  json = true,
): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  };
}

function extractWamid(data: unknown): string {
  const wamid = (data as { messages?: Array<{ id?: string }> })?.messages?.[0]
    ?.id;
  if (!wamid) throw new Error('Cloud API response missing message id (wamid)');
  return wamid;
}
