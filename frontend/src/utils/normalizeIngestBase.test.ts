import { afterEach, describe, expect, it } from 'vitest';

import { normalizeIngestBase } from './normalizeIngestBase';

declare global {
  // eslint-disable-next-line no-var
  var window: Window | undefined;
}

const originalWindow = globalThis.window;

afterEach(() => {
  if (originalWindow) {
    globalThis.window = originalWindow;
  } else {
    delete (globalThis as typeof globalThis & { window?: Window }).window;
  }
});

describe('normalizeIngestBase', () => {
  it('replaces placeholder host with window location host and default port', () => {
    const mockWindow = {
      location: {
        hostname: 'sharepoint.example.com',
        protocol: 'https:',
      },
    } as unknown as Window;

    globalThis.window = mockWindow;

    const result = normalizeIngestBase('https://helium.adesso.claims/ingest');

    expect(result).toBe('https://sharepoint.example.com:8080/ingest');
  });
});
