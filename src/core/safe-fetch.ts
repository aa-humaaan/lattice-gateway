import { isPrivateResolvedAddress, isSafeUpstreamBaseUrl } from './config';

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

type FetchInput = Parameters<typeof fetch>[0];
type ResolveHost = (hostname: string) => Promise<string[]>;

const defaultResolveHost: ResolveHost = async (hostname) => {
  // @types/bun omits the `all` option even though Bun implements it.
  const lookup = Bun.dns.lookup as (
    name: string,
    options: { all: true }
  ) => Promise<Array<{ address: string }>>;
  const records = await lookup(hostname, { all: true });
  return records.map((record) => record.address);
};

function resolveUrl(input: FetchInput): URL {
  const value = input instanceof Request ? input.url : String(input);
  return new URL(value);
}

function isIpLiteral(hostname: string): boolean {
  return hostname.includes(':') || /^(\d{1,3}\.){3}\d{1,3}$/.test(hostname);
}

/** Resolve-and-check: a public-looking name must not point into private space. */
async function assertSafeResolvedHost(url: URL, resolve: ResolveHost): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIpLiteral(host)) return;
  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch {
    throw new Error(`Refusing upstream host with unresolvable DNS: ${host}`);
  }
  if (addresses.length === 0) {
    throw new Error(`Refusing upstream host with no DNS records: ${host}`);
  }
  if (addresses.some(isPrivateResolvedAddress)) {
    throw new Error(`Refusing upstream host resolving to a private address: ${host}`);
  }
}

/**
 * Shared upstream fetch. Disables automatic redirects, revalidates every hop
 * against the same URL allow-list used for operator input, and refuses an
 * HTTPS-to-HTTP downgrade. Callers get a Response or an explicit refusal.
 */
export function createSafeFetch(impl?: typeof fetch, resolve: ResolveHost = defaultResolveHost): typeof fetch {
  return (async (input: FetchInput, init: RequestInit = {}) => {
    let current = resolveUrl(input);
    const startedSecure = current.protocol === 'https:';
    let currentInit: RequestInit = { ...init, redirect: 'manual' };

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!isSafeUpstreamBaseUrl(current.href)) {
        throw new Error(`Refusing unsafe upstream URL: ${current.href}`);
      }
      await assertSafeResolvedHost(current, resolve);
      const response = await (impl ?? fetch)(current.href, currentInit);
      const location = response.headers.get('location');
      if (!REDIRECT_STATUSES.has(response.status) || !location) return response;

      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw new Error(`Refusing malformed redirect target: ${location}`);
      }
      if (startedSecure && next.protocol === 'http:') {
        throw new Error(`Refusing HTTPS-to-HTTP downgrade: ${next.href}`);
      }
      if (!isSafeUpstreamBaseUrl(next.href)) {
        throw new Error(`Refusing unsafe redirect target: ${next.href}`);
      }
      if (response.status === 303) {
        const { body: _body, ...rest } = currentInit;
        currentInit = { ...rest, method: 'GET' };
      }
      current = next;
    }
    throw new Error(`Too many upstream redirects (max ${MAX_REDIRECTS})`);
  }) as typeof fetch;
}

export const safeFetch = createSafeFetch();
