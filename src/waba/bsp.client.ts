import { Injectable, Logger } from '@nestjs/common';

import type { WabaCloudClient } from './waba-cloud';

/**
 * Cliente do BSP 360dialog (Cloud API hosted).
 * Base: https://waba-v2.360dialog.io | auth via header D360-API-KEY.
 * Mídia recebida no webhook traz URL da CDN da Meta (lookaside.fbsbx.com);
 * o download troca o host pela base do BSP mantendo path/query.
 */
export function rewriteBspMediaUrl(metaUrl: string, bspBase: string): string {
  const source = new URL(metaUrl);
  return new URL(source.pathname + source.search, bspBase).toString();
}

@Injectable()
export class BspClient implements WabaCloudClient {
  private readonly logger = new Logger(BspClient.name);
  private readonly baseUrl =
    process.env.WABA_BSP_BASE_URL?.trim() || 'https://waba-v2.360dialog.io';

  private headers(apiKey: string, json = true): Record<string, string> {
    return {
      'D360-API-KEY': apiKey,
      ...(json ? { 'Content-Type': 'application/json' } : {}),
    };
  }

  /** Envia texto livre (janela de atendimento aberta). Retorna o wamid. */
  async sendText(apiKey: string, to: string, body: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/messages`, {
      method: 'POST',
      headers: this.headers(apiKey),
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'text',
        text: { body },
      }),
    });
    const data = await this.parse(res, 'sendText');
    return this.extractWamid(data);
  }

  /** Sobe mídia para a Meta (multipart) e retorna o media id. */
  async uploadMedia(
    apiKey: string,
    file: Buffer,
    contentType: string,
    filename: string,
  ): Promise<string> {
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('file', new Blob([new Uint8Array(file)], { type: contentType }), filename);
    const res = await fetch(`${this.baseUrl}/media`, {
      method: 'POST',
      headers: this.headers(apiKey, false),
      body: form,
    });
    const data = (await this.parse(res, 'uploadMedia')) as { id?: string };
    if (!data.id) throw new Error('uploadMedia: response missing media id');
    return data.id;
  }

  /** Envia áudio já hospedado na Meta (media id). Retorna o wamid. */
  async sendAudio(apiKey: string, to: string, mediaId: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/messages`, {
      method: 'POST',
      headers: this.headers(apiKey),
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'audio',
        audio: { id: mediaId },
      }),
    });
    const data = await this.parse(res, 'sendAudio');
    return this.extractWamid(data);
  }

  /** GET /{media-id} → URL efêmera na CDN da Meta. */
  async getMediaUrl(apiKey: string, mediaId: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/${encodeURIComponent(mediaId)}`, {
      headers: this.headers(apiKey, false),
    });
    const data = (await this.parse(res, 'getMediaUrl')) as { url?: string };
    if (!data.url) throw new Error('getMediaUrl: response missing url');
    return data.url;
  }

  /**
   * Baixa a mídia trocando o host da CDN da Meta pela base do BSP
   * (regra documentada pelo 360dialog).
   */
  async downloadMedia(
    apiKey: string,
    metaUrl: string,
  ): Promise<{ data: Buffer; contentType: string }> {
    const proxied = rewriteBspMediaUrl(metaUrl, this.baseUrl);
    const res = await fetch(proxied, { headers: this.headers(apiKey, false) });
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

  private extractWamid(data: unknown): string {
    const wamid = (data as { messages?: Array<{ id?: string }> })?.messages?.[0]
      ?.id;
    if (!wamid) throw new Error('BSP response missing message id (wamid)');
    return wamid;
  }
}
