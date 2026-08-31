/**
 * Identidade de Conversation = (channelEndpointId, peerAddress).
 * Canais diferentes nunca compartilham endpoint — o mesmo produtor no Zap e
 * no e-mail são duas conversas; o dashboard agrega por producerId/farmId.
 */
export function conversationIdentity(
  channelEndpointId: string,
  peerAddress: string,
): string {
  return `${channelEndpointId}\0${peerAddress}`;
}

export function normalizeEmail(raw: string | undefined): string | null {
  if (!raw) return null;
  const email = raw.trim().toLowerCase();
  const at = email.indexOf('@');
  if (at <= 0 || at === email.length - 1) return null;
  return email;
}

/** Aceita `Ada <ada@x.com>` ou o endereço cru. */
export function extractEmail(raw: string | undefined): string | null {
  if (!raw) return null;
  const angle = /<([^>]+)>/.exec(raw);
  return normalizeEmail(angle ? angle[1] : raw);
}
