import {
  discountReplySendsText,
  isDiscountReplyFact,
} from './dashboard.discount';

describe('dashboard.discount', () => {
  it('only OBJECAO + preco is the discount fast-track', () => {
    expect(isDiscountReplyFact('OBJECAO', 'preco')).toBe(true);
    expect(isDiscountReplyFact('OBJECAO', 'logistica')).toBe(false);
    expect(isDiscountReplyFact('RISCO', 'preco')).toBe(false);
  });

  it('sends text on WABA and EMAIL, logs call on VOICE', () => {
    expect(discountReplySendsText('WABA')).toBe(true);
    expect(discountReplySendsText('EMAIL')).toBe(true);
    expect(discountReplySendsText('VOICE')).toBe(false);
  });
});
