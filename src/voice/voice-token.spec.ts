import * as jwt from 'jsonwebtoken';

import {
  mintVoiceAccessToken,
  parseVoiceClientFrom,
  recordingCallbackUrl,
  userIdFromVoiceIdentity,
  voiceClientIdentity,
} from './voice-token';

describe('voice-token', () => {
  it('maps farm_ identity to the user id', () => {
    const id = '11111111-2222-3333-4444-555555555555';
    expect(voiceClientIdentity(id)).toBe(`farm_${id}`);
    expect(userIdFromVoiceIdentity(`farm_${id}`)).toBe(id);
    expect(parseVoiceClientFrom(`client:farm_${id}`)).toBe(`farm_${id}`);
    expect(parseVoiceClientFrom('+5566')).toBeNull();
  });

  it('mints a Twilio FPA JWT with Bearer-style grants', () => {
    const minted = mintVoiceAccessToken(
      {
        accountSid: 'ACaccount',
        authToken: 'unused',
        apiKeySid: 'SKkey',
        apiKeySecret: 'super-secret-api-key',
        twimlAppSid: 'APapp',
      },
      'farm_user-1',
    );
    const decoded = jwt.decode(minted.token, { complete: true }) as {
      header: { cty?: string };
      payload: { grants?: { identity?: string; voice?: { incoming?: { allow?: boolean } } } };
    };
    expect(decoded.header.cty).toBe('twilio-fpa;v=1');
    expect(decoded.payload.grants?.identity).toBe('farm_user-1');
    expect(decoded.payload.grants?.voice?.incoming?.allow).toBe(true);
    expect(minted.outgoing).toBe(true);
  });

  it('puts our/peer/dir on the recording callback', () => {
    expect(
      recordingCallbackUrl(
        'https://farm.example',
        'acc',
        '+55661111',
        '+55662222',
        'IN',
      ),
    ).toBe(
      'https://farm.example/voice/recording/acc?our=%2B55661111&peer=%2B55662222&dir=IN',
    );
  });
});
