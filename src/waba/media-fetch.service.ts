import { Injectable } from '@nestjs/common';
import { readFile } from 'fs/promises';
import { basename, join } from 'path';

import { WabaCloudFactory } from './waba-cloud';
import { StorageService } from './storage.service';
import { decryptSecret } from './waba-crypto';
import { parseVoiceCredentials, VoiceClient } from '../voice/voice.client';
import { twilioRecordingUrl } from '../voice/twilio-media';
import { parseEmailCredentials, EmailClient } from '../email/email.client';
import {
  parseWaSessionCredentials,
  EvolutionClient,
} from '../wa-session/evolution.client';

export interface MediaRef {
  vendor?: string;
  metaMediaId?: string | null;
  metaUrl?: string | null;
  mimeType?: string | null;
  sha256?: string | null;
  filename?: string | null;
  recordingUrl?: string | null;
  recordingSid?: string | null;
  accountSid?: string | null;
  url?: string | null;
  stagingKey?: string | null;
  fixtureName?: string | null;
  /** Evolution: id da mensagem (key.id) para getBase64FromMediaMessage. */
  messageId?: string | null;
  fromMe?: boolean;
  remoteJid?: string | null;
  /** Bytes do webhook (base64) — STT não espera getBase64. */
  inlineBase64?: string | null;
  attempts?: number;
}

export interface MediaOwner {
  conversation: {
    wabaNumber: {
      phoneNumberId: string;
      wabaAccount: { apiTokenEncrypted: string; provider: string };
    } | null;
    channelEndpoint: {
      channelAccount: { credentialsEncrypted: string | null };
    } | null;
  };
}

/**
 * Bytes da mídia a partir do canal (Evolution / Meta / Twilio / Mailgun).
 * Independente do object storage — a análise não espera o put no S3.
 */
@Injectable()
export class MediaFetchService {
  constructor(
    private readonly wabaCloud: WabaCloudFactory,
    private readonly storage: StorageService,
    private readonly voice: VoiceClient,
    private readonly email: EmailClient,
    private readonly evolution: EvolutionClient,
  ) {}

  async download(
    owner: MediaOwner,
    ref: MediaRef,
  ): Promise<{ data: Buffer; contentType: string }> {
    if (ref.inlineBase64) {
      const data = Buffer.from(ref.inlineBase64, 'base64');
      if (data.length > 0) {
        return {
          data,
          contentType:
            ref.mimeType?.split(';')[0]?.trim() || 'audio/ogg',
        };
      }
    }
    if (ref.vendor === 'fixture') return this.downloadFixture(ref);
    if (ref.vendor === 'twilio') return this.downloadTwilio(owner, ref);
    if (ref.vendor === 'mailgun') return this.downloadMailgun(owner, ref);
    if (ref.vendor === 'evolution') return this.downloadEvolution(owner, ref);
    return this.downloadMeta(owner, ref);
  }

  private async downloadFixture(
    ref: MediaRef,
  ): Promise<{ data: Buffer; contentType: string }> {
    const raw = ref.fixtureName || ref.filename || 'lavoura.jpg';
    const name = basename(raw);
    if (!name || name !== raw.replace(/[/\\]/g, '')) {
      throw new Error('fixtureName inválido');
    }
    const root =
      process.env.FARM_FIXTURES_DIR?.trim() ||
      join(process.cwd(), '..', 'fixtures');
    const data = await readFile(join(root, name));
    return {
      data,
      contentType: ref.mimeType?.split(';')[0]?.trim() || 'image/jpeg',
    };
  }

  private async downloadMeta(
    owner: MediaOwner,
    ref: MediaRef,
  ): Promise<{ data: Buffer; contentType: string }> {
    const number = owner.conversation.wabaNumber;
    const token = number?.wabaAccount.apiTokenEncrypted;
    if (!number || !token) {
      throw new Error('PENDING_MEDIA without WABA credentials');
    }
    const apiKey = decryptSecret(token);
    const client = this.wabaCloud.for(
      number.wabaAccount.provider,
      number.phoneNumberId,
    );
    let url = ref.metaUrl ?? null;
    if (!url && ref.metaMediaId) {
      url = await client.getMediaUrl(apiKey, ref.metaMediaId);
    }
    if (!url) throw new Error('mediaRef has neither metaUrl nor metaMediaId');
    try {
      return await client.downloadMedia(apiKey, url);
    } catch (err) {
      if (ref.metaMediaId && url === ref.metaUrl) {
        const freshUrl = await client.getMediaUrl(apiKey, ref.metaMediaId);
        return client.downloadMedia(apiKey, freshUrl);
      }
      throw err;
    }
  }

  private async downloadTwilio(
    owner: MediaOwner,
    ref: MediaRef,
  ): Promise<{ data: Buffer; contentType: string }> {
    const encrypted =
      owner.conversation.channelEndpoint?.channelAccount.credentialsEncrypted;
    const creds = parseVoiceCredentials(encrypted);
    const url = twilioRecordingUrl({
      recordingUrl: ref.recordingUrl,
      recordingSid: ref.recordingSid,
      accountSid: ref.accountSid ?? creds.accountSid,
    });
    const data = await this.voice.downloadMp3(creds, url);
    return { data, contentType: 'audio/mpeg' };
  }

  private async downloadMailgun(
    owner: MediaOwner,
    ref: MediaRef,
  ): Promise<{ data: Buffer; contentType: string }> {
    if (ref.stagingKey) {
      const data = await this.storage.getObject(ref.stagingKey);
      return {
        data,
        contentType:
          ref.mimeType?.split(';')[0]?.trim() || 'application/octet-stream',
      };
    }
    if (!ref.url) {
      throw new Error('mailgun mediaRef missing url and stagingKey');
    }
    const encrypted =
      owner.conversation.channelEndpoint?.channelAccount.credentialsEncrypted;
    const creds = parseEmailCredentials(encrypted);
    const data = await this.email.download(creds, ref.url);
    return {
      data,
      contentType:
        ref.mimeType?.split(';')[0]?.trim() || 'application/octet-stream',
    };
  }

  private async downloadEvolution(
    owner: MediaOwner,
    ref: MediaRef,
  ): Promise<{ data: Buffer; contentType: string }> {
    if (!ref.messageId) throw new Error('evolution mediaRef missing messageId');
    const creds = parseWaSessionCredentials(
      owner.conversation.channelEndpoint?.channelAccount.credentialsEncrypted,
    );
    if (!creds) throw new Error('evolution mediaRef without session credentials');
    let last: Error | undefined;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const { data, mimetype } = await this.evolution.mediaBase64(
          creds,
          ref.messageId,
          { fromMe: ref.fromMe, remoteJid: ref.remoteJid },
        );
        if (!data.length) throw new Error('Evolution devolveu áudio vazio');
        return {
          data,
          contentType:
            mimetype?.split(';')[0]?.trim() ||
            ref.mimeType?.split(';')[0]?.trim() ||
            'application/octet-stream',
        };
      } catch (err) {
        last = err as Error;
        if (attempt < 4) {
          await new Promise((r) => setTimeout(r, 1500 * attempt));
        }
      }
    }
    throw last ?? new Error('Evolution getBase64 falhou');
  }
}
