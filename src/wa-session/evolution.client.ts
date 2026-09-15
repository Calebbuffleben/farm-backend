import { Injectable, Logger } from '@nestjs/common';
import { decryptSecret } from '../waba/waba-crypto';

/**
 * Credenciais por RTV (ChannelAccount.credentialsEncrypted, AES-GCM).
 * instanceName = nome da instância na Evolution; token = `hash` devolvido no
 * create (a Evolution manda esse valor em `apikey` no payload do webhook —
 * segunda verificação além do segredo no path). connectedAt alimenta a rampa;
 * phone é o E.164 confirmado no pareamento.
 */
export type WaSessionCreds = {
  vendor: 'evolution';
  instanceName: string;
  token: string;
  phone?: string | null;
  connectedAt?: string | null;
};

export function parseWaSessionCredentials(
  credentialsEncrypted: string | null | undefined,
): WaSessionCreds | null {
  if (!credentialsEncrypted) return null;
  const parsed = JSON.parse(decryptSecret(credentialsEncrypted)) as Partial<WaSessionCreds>;
  if (!parsed.instanceName || !parsed.token) return null;
  return {
    vendor: 'evolution',
    instanceName: parsed.instanceName,
    token: parsed.token,
    phone: parsed.phone ?? null,
    connectedAt: parsed.connectedAt ?? null,
  };
}

export type ConnectionState = 'open' | 'connecting' | 'close';

const WEBHOOK_EVENTS = ['MESSAGES_UPSERT', 'CONNECTION_UPDATE'];

/**
 * Cliente REST da Evolution API v2 (clone em farm/evolution-api, processo no
 * host via scripts/start-evolution.sh). fetch puro; header `apikey` =
 * AUTHENTICATION_API_KEY / EVOLUTION_API_KEY. Paths conforme doc v2
 * (doc.evolution-api.com). Se a versão pinada divergir, ajuste SÓ este arquivo.
 */
@Injectable()
export class EvolutionClient {
  private readonly logger = new Logger(EvolutionClient.name);

  get enabled(): boolean {
    return Boolean(this.baseUrl() && this.apiKey());
  }

  /** Cria a instância do RTV (Baileys) já apontando o webhook para o Farm. */
  async createInstance(instanceName: string, webhookUrl: string | null): Promise<{ instanceName: string; token: string }> {
    const data = await this.call<{
      instance?: { instanceName?: string };
      hash?: string | { apikey?: string };
    }>('POST', '/instance/create', {
      instanceName,
      integration: 'WHATSAPP-BAILEYS',
      qrcode: false,
      ...(webhookUrl ? { webhook: { url: webhookUrl, byEvents: false, base64: false, events: WEBHOOK_EVENTS } } : {}),
      ...this.proxyFields(),
    });
    const token = typeof data.hash === 'string' ? data.hash : data.hash?.apikey;
    if (!token) throw new Error('Evolution create sem hash da instância');
    return { instanceName: data.instance?.instanceName ?? instanceName, token };
  }

  /** Re-aponta o webhook (URL pública mudou). */
  async setWebhook(creds: WaSessionCreds, url: string): Promise<void> {
    await this.call('POST', `/webhook/set/${creds.instanceName}`, {
      webhook: { enabled: true, url, byEvents: false, base64: false, events: WEBHOOK_EVENTS },
    });
  }

  async status(creds: WaSessionCreds): Promise<{ connected: boolean; state: ConnectionState }> {
    const data = await this.call<{ instance?: { state?: string } }>(
      'GET',
      `/instance/connectionState/${creds.instanceName}`,
    );
    const state = (data.instance?.state ?? 'close') as ConnectionState;
    return { connected: state === 'open', state };
  }

  /** Telefone conectado (E.164) via ownerJid da instância. */
  async devicePhone(creds: WaSessionCreds): Promise<string | null> {
    const list = await this.call<Array<{ ownerJid?: string | null; number?: string | null }>>(
      'GET',
      `/instance/fetchInstances?instanceName=${encodeURIComponent(creds.instanceName)}`,
    ).catch(() => [] as Array<{ ownerJid?: string | null; number?: string | null }>);
    const raw = list[0]?.ownerJid ?? list[0]?.number ?? '';
    const digits = raw.split('@')[0].split(':')[0].replace(/\D/g, '');
    return digits.length >= 8 ? `+${digits}` : null;
  }

  /** QR (laptop). null se a instância já estiver `open`. */
  async qrCodeImage(creds: WaSessionCreds): Promise<string | null> {
    const data = await this.call<{ base64?: string | null }>('GET', `/instance/connect/${creds.instanceName}`);
    return data.base64?.replace(/^data:image\/\w+;base64,/, '') ?? null;
  }

  /** Código de pareamento (Aparelhos conectados → Conectar com número). */
  async pairingCode(creds: WaSessionCreds, phoneE164: string): Promise<string> {
    const digits = phoneE164.replace(/\D/g, '');
    const data = await this.call<{ pairingCode?: string | null }>(
      'GET',
      `/instance/connect/${creds.instanceName}?number=${digits}`,
    );
    if (!data.pairingCode) throw new Error('Evolution não devolveu código de pareamento (instância já conectada?)');
    return data.pairingCode;
  }

  /** Desloga o aparelho; a instância continua existindo para reconectar. */
  async disconnect(creds: WaSessionCreds): Promise<void> {
    await this.call('DELETE', `/instance/logout/${creds.instanceName}`);
  }

  async deleteInstance(creds: WaSessionCreds): Promise<void> {
    await this.call('DELETE', `/instance/delete/${creds.instanceName}`);
  }

  /** `delay` (ms) mostra "digitando..." antes de enviar — a Evolution cuida da presença. */
  async sendText(creds: WaSessionCreds, to: string, text: string, typingSeconds = 0): Promise<string> {
    const data = await this.call<{ key?: { id?: string } }>('POST', `/message/sendText/${creds.instanceName}`, {
      number: to.replace(/\D/g, ''),
      text,
      ...(typingSeconds > 0 ? { delay: Math.min(15, Math.round(typingSeconds)) * 1000 } : {}),
    });
    if (!data.key?.id) throw new Error('Evolution sendText sem key.id');
    return data.key.id;
  }

  /** Mídia inbound: a Evolution guarda a mensagem e devolve o binário em base64. */
  async mediaBase64(creds: WaSessionCreds, messageId: string): Promise<{ data: Buffer; mimetype: string | null }> {
    const data = await this.call<{ base64?: string; mimetype?: string }>(
      'POST',
      `/chat/getBase64FromMediaMessage/${creds.instanceName}`,
      { message: { key: { id: messageId } }, convertToMp4: false },
    );
    if (!data.base64) throw new Error('Evolution getBase64FromMediaMessage sem base64');
    return { data: Buffer.from(data.base64, 'base64'), mimetype: data.mimetype ?? null };
  }

  private baseUrl(): string {
    return (process.env.EVOLUTION_BASE_URL?.trim() ?? '').replace(/\/$/, '');
  }

  private apiKey(): string {
    return process.env.EVOLUTION_API_KEY?.trim() ?? '';
  }

  /** EVOLUTION_PROXY_URL=http://user:pass@host:port → campos do create. */
  private proxyFields(): Record<string, string> {
    const raw = process.env.EVOLUTION_PROXY_URL?.trim();
    if (!raw) return {};
    try {
      const u = new URL(raw);
      return {
        proxyHost: u.hostname,
        proxyPort: u.port || (u.protocol === 'https:' ? '443' : '80'),
        proxyProtocol: u.protocol.replace(':', ''),
        ...(u.username ? { proxyUsername: decodeURIComponent(u.username) } : {}),
        ...(u.password ? { proxyPassword: decodeURIComponent(u.password) } : {}),
      };
    } catch {
      this.logger.warn('EVOLUTION_PROXY_URL inválida — ignorada');
      return {};
    }
  }

  private async call<T = Record<string, unknown>>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<T> {
    if (!this.enabled) throw new Error('EVOLUTION_BASE_URL/EVOLUTION_API_KEY ausentes');
    const res = await fetch(`${this.baseUrl()}${path}`, {
      method,
      headers: {
        apikey: this.apiKey(),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = (await res.json().catch(() => ({}))) as T & {
      error?: string;
      message?: string | string[];
      response?: { message?: string | string[] };
    };
    if (!res.ok) {
      const msg = [data.response?.message, data.message, data.error]
        .flat()
        .filter(Boolean)
        .join('; ');
      this.logger.warn(`evolution ${method} ${path} ${res.status}: ${msg}`);
      throw new Error(msg || `Evolution ${method} ${path} ${res.status}`);
    }
    return data;
  }
}
