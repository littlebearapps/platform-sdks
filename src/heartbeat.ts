/**
 * Gatus external endpoint heartbeat helper.
 *
 * All Platform cron workers call this on success/failure to push
 * heartbeat status to the self-hosted Gatus instance at
 * status.littlebearapps.com.
 *
 * Gatus external endpoints accept:
 *   POST {url}?success=true|false
 *   Authorization: Bearer {token}
 *
 * @see docs/quickrefs/monitoring.md
 */
export function pingHeartbeat(
  ctx: ExecutionContext,
  url: string | undefined,
  token: string | undefined,
  success: boolean
): void {
  if (!url || !token) return;
  ctx.waitUntil(
    fetch(`${url}?success=${success}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {})
  );
}
