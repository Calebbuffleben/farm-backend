import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  MissingTenantContextError,
  TenantContext,
  TenantMismatchError,
} from './tenant-context.types';

/**
 * Tenant context plumbing.
 *
 * Design principles (non-negotiable, mirrored in docs/auth-architecture.md):
 *  - `tenantId` is ALWAYS derived from the verified JWT (`token.tid`).
 *  - AsyncLocalStorage is STRICTLY for the HTTP request scope. Long-lived
 *    connections (Socket.IO, WebSocket `/egress-audio`, gRPC streaming)
 *    MUST pass context explicitly via closures / `socket.data` / `call.user`.
 *  - Services consuming this helper should call `requireTenant(ctx)` at the
 *    top of every method to fail-closed when context is missing.
 */
@Injectable()
export class TenantContextService {
  private readonly httpStorage = new AsyncLocalStorage<TenantContext>();
  private readonly bypassStorage = new AsyncLocalStorage<boolean>();

  /** Run `fn` with an HTTP request's tenant context bound to ALS. */
  runHttp<T>(ctx: TenantContext, fn: () => T): T {
    return this.httpStorage.run(ctx, fn);
  }

  /** Current HTTP tenant context, or `undefined` outside HTTP scope. */
  getHttpContext(): TenantContext | undefined {
    return this.httpStorage.getStore();
  }

  /**
   * Escape hatch for operations that intentionally do not need tenant
   * enforcement — e.g. auth bootstrap (tenant creation, global email
   * lookup during login when callers explicitly pass tenantId to Prisma).
   * Use sparingly. Always prefer passing `tenantId` explicitly.
   *
   * The callback is run inside an `async` ALS scope so Prisma queries that
   * return a Promise still see bypass active until they settle. Do not use a
   * sync callback that only *returns* a Promise without `async`/`await` in
   * the callback body — that drops bypass before the query runs.
   */
  runWithTenantBypass<T>(fn: () => T | Promise<T>): Promise<T> {
    return this.bypassStorage.run(true, async () => fn());
  }

  isBypassActive(): boolean {
    return this.bypassStorage.getStore() === true;
  }
}

/**
 * Pass-through helper for socket/gRPC scopes: there is NO ALS; the caller
 * holds `ctx` directly (closure / `socket.data` / `call.user`) and threads
 * it into services. Kept for API symmetry with `runHttp` so call-sites read
 * consistently across transports.
 */
export function runWithTenant<T>(
  ctx: TenantContext,
  fn: (c: TenantContext) => T,
): T {
  return fn(ctx);
}

/** Throws when `tenantId` is missing — call this at the top of every
 *  tenant-scoped service method. */
export function requireTenant(
  ctx: { tenantId?: string | null } | null | undefined,
  reason?: string,
): string {
  if (!ctx || !ctx.tenantId) {
    throw new MissingTenantContextError(
      reason ?? 'tenantId is required but was not provided in context',
    );
  }
  return ctx.tenantId;
}

/**
 * Validate that a client-provided tenantId (e.g. `x-tenant-id` header,
 * query param, socket payload) matches the token's tenant. Client-provided
 * values are **never** the source of truth — this helper only surfaces
 * mismatches for audit logging and hard rejection.
 */
export function assertTenantMatch(
  tokenTenantId: string,
  claimedTenantId: string | null | undefined,
): void {
  if (!claimedTenantId) return;
  if (claimedTenantId !== tokenTenantId) {
    throw new TenantMismatchError(tokenTenantId, claimedTenantId);
  }
}
