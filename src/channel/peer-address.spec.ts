import {
  conversationIdentity,
  extractEmail,
  normalizeEmail,
} from './peer-address';

describe('conversationIdentity', () => {
  it('does not collide WABA vs email of the same producer', () => {
    const producerPhone = '+5566999990000';
    const producerEmail = normalizeEmail('Joao@Fazenda.com');
    const wabaEndpoint = 'endpoint-waba';
    const emailEndpoint = 'endpoint-email';

    expect(producerEmail).toBe('joao@fazenda.com');
    expect(
      conversationIdentity(wabaEndpoint, producerPhone),
    ).not.toBe(conversationIdentity(emailEndpoint, producerEmail!));
    // Mesmo peer em endpoints diferentes também não colide
    expect(conversationIdentity(wabaEndpoint, producerPhone)).not.toBe(
      conversationIdentity(emailEndpoint, producerPhone),
    );
  });
});

describe('normalizeEmail', () => {
  it('lowercases and trims', () => {
    expect(normalizeEmail('  Ada@Exemplo.COM ')).toBe('ada@exemplo.com');
  });

  it('rejects missing local or domain', () => {
    expect(normalizeEmail('')).toBeNull();
    expect(normalizeEmail('sem-arroba')).toBeNull();
    expect(normalizeEmail('@x.com')).toBeNull();
    expect(normalizeEmail('a@')).toBeNull();
  });
});

describe('extractEmail', () => {
  it('reads angle-bracket form', () => {
    expect(extractEmail('Ada Silva <Ada@Fazenda.com>')).toBe('ada@fazenda.com');
  });
});
