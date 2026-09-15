/** Link the invitee opens in farm/web. Token is one-shot and stays in the query. */
export function inviteAcceptUrl(token: string): string {
  const explicit = process.env.FARM_WEB_APP_URL?.trim();
  const fromCors = process.env.CORS_ORIGINS?.split(',')[0]?.trim();
  const base = (explicit || fromCors || 'http://localhost:3100').replace(
    /\/$/,
    '',
  );
  return `${base}/accept-invite?token=${encodeURIComponent(token)}`;
}
