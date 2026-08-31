/** Alçada de desconto: só objeção de preço. Não grava R$ no ERP. */

export function isDiscountReplyFact(kind: string, subtype: string): boolean {
  return kind === 'OBJECAO' && subtype === 'preco';
}

/** VOICE não tem sendText — o gestor liga. WABA e e-mail despacham o texto. */
export function discountReplySendsText(
  channelKind: 'WABA' | 'VOICE' | 'EMAIL',
): boolean {
  return channelKind !== 'VOICE';
}
