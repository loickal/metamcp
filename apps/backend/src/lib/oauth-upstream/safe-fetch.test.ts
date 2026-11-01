import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));
vi.mock("node:https", () => ({ request: vi.fn() }));
import { lookup } from "node:dns/promises";
import { request } from "node:https";

import {
  isPublicAddress,
  readOAuthJson,
  safeOAuthFetch,
  validateOAuthUrl,
} from "./safe-fetch";

afterEach(() => vi.resetAllMocks());
describe("OAuth network boundary", () => {
  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.0.1",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fe80::1",
    "2002:7f00:1::",
    "2001:db8::1",
    "64:ff9b::7f00:1",
  ])("rejects non-public %s", (address) =>
    expect(isPublicAddress(address)).toBe(false),
  );
  it.each([
    "https://user:secret@example.com",
    "http://example.com",
    "file:///etc/passwd",
    "https://example.com/#fragment",
    "https://2130706433",
    "https://0x7f000001",
  ])("rejects unsafe URL %s", async (url) => {
    await expect(validateOAuthUrl(url)).rejects.toThrow();
  });
  it("rejects DNS answers mixing public and private addresses", async () => {
    vi.mocked(lookup).mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ] as never);
    await expect(validateOAuthUrl("https://mixed.example")).rejects.toThrow(
      "public",
    );
  });
  it.each([200, 302, 307, 308])(
    "pins DNS and enforces TLS; status %s never follows redirects",
    async (status) => {
      vi.mocked(lookup)
        .mockResolvedValueOnce([
          { address: "93.184.216.34", family: 4 },
        ] as never)
        .mockResolvedValue([{ address: "127.0.0.1", family: 4 }] as never);
      let options: Record<string, unknown> = {};
      vi.mocked(request).mockImplementation(((
        _url: unknown,
        opts: Record<string, unknown>,
        respond: (response: unknown) => void,
      ) => {
        options = opts;
        const req = new EventEmitter() as EventEmitter & {
          setTimeout: () => void;
          end: () => void;
        };
        req.setTimeout = () => {};
        req.end = () => {
          const res = Object.assign(new PassThrough(), {
            statusCode: status,
            headers: { location: "https://127.0.0.1/private" },
          });
          respond(res);
          res.end("{}");
        };
        return req;
      }) as never);
      const result = safeOAuthFetch("https://public.example/token", {
        method: "POST",
        body: "secret=value",
      });
      if (status === 200) expect(await (await result).json()).toEqual({});
      else await expect(result).rejects.toThrow("redirects");
      const callback = vi.fn();
      (
        options.lookup as (
          hostname: string,
          options: object,
          callback: typeof vi.fn,
        ) => void
      )("public.example", {}, callback);
      expect(callback).toHaveBeenCalledWith(null, "93.184.216.34", 4);
      expect(options.rejectUnauthorized).toBe(true);
      expect(options.agent).toBe(false);
      expect(lookup).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledTimes(1);
    },
  );
  it("bounds OAuth JSON responses", async () => {
    await expect(
      readOAuthJson(new Response('"' + "x".repeat(1024 * 1024) + '"')),
    ).rejects.toThrow("too large");
  });
});
