import {afterEach, describe, expect, it} from 'vitest';

import {normalizeSharePointBase} from './ingestApi';

declare global {
  // eslint-disable-next-line no-var
  var window: Window | undefined;
}

const originalWindow = globalThis.window;

afterEach(() => {
  if (originalWindow) {
    globalThis.window = originalWindow;
  } else {
    delete (globalThis as typeof globalThis & {window?: Window}).window;
  }
});

describe('normalizeSharePointBase', () => {
  it('appends /ingest to absolute URLs that have no path', () => {
    expect(normalizeSharePointBase('https://sharepoint.example.com'))
        .toBe('https://sharepoint.example.com/ingest');
  });

  it('normalizes placeholder hosts to the current origin with /ingest', () => {
    const mockWindow = {
      location: {
        hostname: 'tenant.sharepoint.local',
        protocol: 'https:',
      },
    } as unknown as Window;

    globalThis.window = mockWindow;

    expect(normalizeSharePointBase('https://helium.adesso.claims'))
        .toBe('https://tenant.sharepoint.local:8080/ingest');
  });

  it('preserves explicit /ingest paths', () => {
    expect(normalizeSharePointBase('https://sharepoint.example.com/ingest/'))
        .toBe('https://sharepoint.example.com/ingest');
  });

  it('returns relative /ingest unchanged', () => {
    expect(normalizeSharePointBase('/ingest')).toBe('/ingest');
  });
});
