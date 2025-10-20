const DEFAULT_PLACEHOLDER_HOSTS = new Set(['helium.adesso.claims']);
const DEFAULT_INGEST_PORT = '8081';

const getWindowLocation = () => {
  if (typeof window === 'undefined') return undefined;
  const { location } = window;
  if (!location) return undefined;
  return location;
};

const buildUrlFromParts = (url: URL) => {
  const normalized = url.toString();
  return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
};

export const normalizeIngestBase = (value: string | undefined | null): string | undefined => {
  if (!value) return undefined;

  try {
    // Relative URLs (e.g. `/ingest`) should be used as-is.
    if (value.startsWith('/')) {
      return value;
    }

    const parsed = new URL(value);
    const windowLocation = getWindowLocation();

    if (DEFAULT_PLACEHOLDER_HOSTS.has(parsed.hostname) && windowLocation) {
      parsed.hostname = windowLocation.hostname;
      parsed.port = DEFAULT_INGEST_PORT;
      parsed.protocol = windowLocation.protocol || parsed.protocol || 'http:';
      return buildUrlFromParts(parsed);
    }

    return buildUrlFromParts(parsed);
  } catch {
    // If parsing fails, fall back to the original value so that callers can
    // decide to use a default.
    return value;
  }
};

export default normalizeIngestBase;
