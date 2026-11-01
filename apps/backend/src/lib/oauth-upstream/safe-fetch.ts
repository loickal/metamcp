import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";
import { Readable } from "node:stream";

const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["192.88.99.0", 24],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const)
  blocked.addSubnet(address, prefix, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
for (const [address, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const) {
  blocked.addSubnet(address, prefix, "ipv6");
}

export function isPublicAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return !blocked.check(address, "ipv4");
  return (
    version === 6 &&
    globalV6.check(address, "ipv6") &&
    !blocked.check(address, "ipv6")
  );
}

export async function validateOAuthUrl(value: string | URL, resolver = lookup) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error(
      "OAuth destinations must be HTTPS URLs without credentials or fragments",
    );
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await resolver(hostname, { all: true, verbatim: true });
  if (
    !addresses.length ||
    addresses.some(({ address }) => !isPublicAddress(address))
  ) {
    throw new Error("OAuth destination is not a public network address");
  }
  return { url, address: addresses[0]! };
}

// Resolve once, validate every answer and pin the connection to that answer.
// HTTPS still verifies the original hostname. Never follow redirects, including
// 307/308 redirects carrying token POST bodies. Do not use environment proxies.
export const safeOAuthFetch: typeof fetch = async (input, init = {}) => {
  const { url, address } = await validateOAuthUrl(
    input instanceof Request ? input.url : input.toString(),
  );
  const signal = init.signal ?? AbortSignal.timeout(15_000);
  const body = init.body == null ? undefined : init.body.toString();
  return new Promise<Response>((resolve, reject) => {
    const req = request(
      url,
      {
        method: init.method ?? "GET",
        headers: Object.fromEntries(new Headers(init.headers)),
        agent: false,
        rejectUnauthorized: true,
        family: address.family,
        signal,
        lookup: (_hostname, _options, callback) =>
          callback(null, address.address, address.family),
      },
      (res) => {
        req.setTimeout(0);
        const status = res.statusCode ?? 502;
        if (status >= 300 && status < 400) {
          res.destroy();
          reject(new Error("OAuth redirects are not allowed"));
          return;
        }
        const headers = new Headers();
        for (const [key, value] of Object.entries(res.headers)) {
          if (value !== undefined)
            headers.set(key, Array.isArray(value) ? value.join(", ") : value);
        }
        resolve(
          new Response(
            [204, 205, 304].includes(status) || init.method === "HEAD"
              ? null
              : (Readable.toWeb(res) as ReadableStream<Uint8Array>),
            { status, headers },
          ),
        );
      },
    );
    req.setTimeout(15_000, () =>
      req.destroy(new Error("OAuth request timed out")),
    );
    req.on("error", reject);
    req.end(body);
  });
};

export async function readOAuthJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("Empty OAuth response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 1024 * 1024) throw new Error("OAuth response too large");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel();
  }
}
