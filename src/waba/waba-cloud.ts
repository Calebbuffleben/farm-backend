import { Injectable } from '@nestjs/common';
import type { WabaProvider } from '@prisma/client';

import { BspClient } from './bsp.client';
import { MetaCloudClient } from './meta-cloud.client';

/** Contrato Cloud API compartilhado por 360dialog e Meta Tech Provider. */
export interface WabaCloudClient {
  sendText(apiKey: string, to: string, body: string): Promise<string>;
  uploadMedia(
    apiKey: string,
    file: Buffer,
    contentType: string,
    filename: string,
  ): Promise<string>;
  sendAudio(apiKey: string, to: string, mediaId: string): Promise<string>;
  getMediaUrl(apiKey: string, mediaId: string): Promise<string>;
  downloadMedia(
    apiKey: string,
    metaUrl: string,
  ): Promise<{ data: Buffer; contentType: string }>;
}

export function selectWabaCloud(
  provider: WabaProvider | string,
  phoneNumberId: string,
  bsp: WabaCloudClient,
): WabaCloudClient {
  return provider === 'META_DIRECT'
    ? new MetaCloudClient(phoneNumberId)
    : bsp;
}

@Injectable()
export class WabaCloudFactory {
  constructor(private readonly bsp: BspClient) {}

  for(
    provider: WabaProvider | string,
    phoneNumberId: string,
  ): WabaCloudClient {
    return selectWabaCloud(provider, phoneNumberId, this.bsp);
  }
}
