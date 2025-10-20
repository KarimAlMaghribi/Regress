const DEFAULT_PROTOCOL = 'http';
const DEFAULT_PORT = '8081';

const normalizeHost = (host: string): string => {
  if (host.includes(':') && !host.startsWith('[')) {
    return `[${host}]`;
  }
  return host;
};

export const resolveDefaultIngestBase = (): string => {
  const host =
      typeof window !== 'undefined' && window.location?.hostname
          ? window.location.hostname
          : 'localhost';

  return `${DEFAULT_PROTOCOL}://${normalizeHost(host)}:${DEFAULT_PORT}`;
};

export default resolveDefaultIngestBase;
