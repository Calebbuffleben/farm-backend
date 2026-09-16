/** URL do Redis compartilhado com o intelligence (stream farm:messages:ready). */

export function redisUrlFromEnv(): string | undefined {
  const direct =
    process.env.REDIS_URL?.trim() || process.env.REDIS_PRIVATE_URL?.trim();
  if (direct) return direct;
  const host = process.env.REDISHOST?.trim() || process.env.REDIS_HOST?.trim();
  if (!host) return undefined;
  const port = process.env.REDISPORT || process.env.REDIS_PORT || '6379';
  const user = process.env.REDISUSER || process.env.REDIS_USER || 'default';
  const pass = process.env.REDISPASSWORD || process.env.REDIS_PASSWORD;
  if (!pass) return `redis://${host}:${port}`;
  return `redis://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
}
