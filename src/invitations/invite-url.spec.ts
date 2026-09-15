import { inviteAcceptUrl } from './invite-url';

describe('inviteAcceptUrl', () => {
  const prevWeb = process.env.FARM_WEB_APP_URL;
  const prevCors = process.env.CORS_ORIGINS;

  afterEach(() => {
    if (prevWeb === undefined) delete process.env.FARM_WEB_APP_URL;
    else process.env.FARM_WEB_APP_URL = prevWeb;
    if (prevCors === undefined) delete process.env.CORS_ORIGINS;
    else process.env.CORS_ORIGINS = prevCors;
  });

  it('uses FARM_WEB_APP_URL when set', () => {
    process.env.FARM_WEB_APP_URL = 'https://app.farm.example/';
    process.env.CORS_ORIGINS = 'https://ignored.example';
    expect(inviteAcceptUrl('abc+1')).toBe(
      'https://app.farm.example/accept-invite?token=abc%2B1',
    );
  });

  it('falls back to the first CORS origin', () => {
    delete process.env.FARM_WEB_APP_URL;
    process.env.CORS_ORIGINS = 'https://web.farm.example, http://localhost:3100';
    expect(inviteAcceptUrl('tok')).toBe(
      'https://web.farm.example/accept-invite?token=tok',
    );
  });
});
