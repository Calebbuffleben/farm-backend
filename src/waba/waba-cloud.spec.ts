import { selectWabaCloud } from './waba-cloud';
import { MetaCloudClient, metaAuthHeaders } from './meta-cloud.client';
import { rewriteBspMediaUrl } from './bsp.client';

describe('waba cloud adapters', () => {
  it('META_DIRECT uses Bearer, not D360-API-KEY', () => {
    const headers = metaAuthHeaders('tok-1');
    expect(headers.Authorization).toBe('Bearer tok-1');
    expect(headers['D360-API-KEY']).toBeUndefined();
  });

  it('selects MetaCloudClient only for META_DIRECT', () => {
    const bsp = { name: 'bsp' } as never;
    expect(selectWabaCloud('META_DIRECT', '123', bsp)).toBeInstanceOf(
      MetaCloudClient,
    );
    expect(selectWabaCloud('BSP_360DIALOG', '123', bsp)).toBe(bsp);
  });

  it('BSP download rewrites Meta CDN host; Meta download keeps the URL', () => {
    const metaUrl =
      'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=abc';
    const proxied = rewriteBspMediaUrl(metaUrl, 'https://waba-v2.360dialog.io');
    expect(proxied.startsWith('https://waba-v2.360dialog.io/whatsapp_business/')).toBe(
      true,
    );
    expect(proxied).not.toContain('lookaside.fbsbx.com');
  });
});
