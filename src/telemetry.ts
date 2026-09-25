import {OTA_UUID, exactKeys, object} from './protocol.js';

export const OTA_EVENT_NAMES = ['available', 'download_started', 'download_complete',
  'activation_started', 'ready', 'rollback', 'verification_failed', 'download_paused', 'download_failed'] as const;
export type OtaEventName = typeof OTA_EVENT_NAMES[number];
export const OTA_SUCCESS_SAMPLE_RATE = 0.01;
export interface OtaEventMetrics {durationMs?: number; bytes?: number; retries?: number; connection?: 'wifi'|'cellular'|'unknown'}
export interface OtaEvent {releaseId: string; event: OtaEventName; metrics?: OtaEventMetrics}

/** Device reports are untrusted operational hints, never publishing authority. */
export function validateEvent(value: unknown): OtaEvent {
  const event = object(value);
  exactKeys(event, event.metrics === undefined ? ['releaseId', 'event'] : ['releaseId', 'event', 'metrics']);
  if (typeof event.releaseId !== 'string' || !OTA_UUID.test(event.releaseId) ||
      typeof event.event !== 'string' || !OTA_EVENT_NAMES.includes(event.event as OtaEventName))
    throw Error('Invalid OTA event');
  if (event.metrics !== undefined) {
    const metrics = object(event.metrics);
    const allowed = ['durationMs', 'bytes', 'retries', 'connection'];
    if (Object.keys(metrics).length === 0 || Object.keys(metrics).some(key => !allowed.includes(key))) throw Error('Invalid OTA event');
    for (const [key, max] of [['durationMs', 3_600_000], ['bytes', 50 * 1024 * 1024], ['retries', 100]] as const) {
      if (metrics[key] !== undefined && (!Number.isSafeInteger(metrics[key]) || (metrics[key] as number) < 0 || (metrics[key] as number) > max)) throw Error('Invalid OTA event');
    }
    if (metrics.connection !== undefined && !['wifi', 'cellular', 'unknown'].includes(metrics.connection as string)) throw Error('Invalid OTA event');
  }
  return event as unknown as OtaEvent;
}
