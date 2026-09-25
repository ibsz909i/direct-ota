import {OTA_UUID, exactKeys, object} from './protocol.js';

export const OTA_EVENT_NAMES = ['available', 'download_started', 'download_complete',
  'activation_started', 'ready', 'rollback', 'verification_failed', 'download_paused', 'download_failed'] as const;
export type OtaEventName = typeof OTA_EVENT_NAMES[number];
export const OTA_SUCCESS_SAMPLE_RATE = 0.01;
export interface OtaEvent {releaseId: string; event: OtaEventName}

/** Device reports are untrusted operational hints, never publishing authority. */
export function validateEvent(value: unknown): OtaEvent {
  const event = object(value);
  exactKeys(event, ['releaseId', 'event']);
  if (typeof event.releaseId !== 'string' || !OTA_UUID.test(event.releaseId) ||
      typeof event.event !== 'string' || !OTA_EVENT_NAMES.includes(event.event as OtaEventName))
    throw Error('Invalid OTA event');
  return event as unknown as OtaEvent;
}
