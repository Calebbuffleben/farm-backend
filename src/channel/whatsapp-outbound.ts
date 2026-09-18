/**
 * Porta de envio WhatsApp do RTV. Hoje Evolution/Baileys (sessão); no cutover
 * para o oficial a mesma Evolution vira motor Cloud API (WHATSAPP-BUSINESS) e
 * esta porta segue igual — Inbox, fila de relatório e opt-out não mudam.
 * Identidade da linha continua o E.164 do RTV em ChannelEndpoint.address,
 * nunca o id do vendor.
 */
export interface WhatsAppOutbound {
  /** @returns id da mensagem no vendor (vira Message.wamid com prefixo). */
  sendText(to: string, text: string, opts?: { typingSeconds?: number }): Promise<string>;
  isReady(): Promise<boolean>;
}

export type OutboundKind = 'inbox' | 'report';
