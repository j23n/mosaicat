import { describe, expect, it, vi } from "vitest";
import { assertPublicUrl, getJson, HttpError, isPrivateAddress } from "../src/http.js";

describe("isPrivateAddress", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254", // cloud metadata — the one that matters most
    "100.64.0.1",
    "0.0.0.0",
    "::1",
    "fe80::1",
    "fd00::1",
    "::ffff:127.0.0.1", // v4-mapped: must not sneak past the v6 branch
  ])("rejects %s", (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each(["93.184.216.34", "8.8.8.8", "2606:2800:220:1::1"])("allows %s", (ip) => {
    expect(isPrivateAddress(ip)).toBe(false);
  });

  it("refuses anything it cannot parse", () => {
    expect(isPrivateAddress("not-an-ip")).toBe(true);
  });
});

describe("assertPublicUrl", () => {
  const lookup = (addresses: string[]) => async () => addresses;

  it("passes a host resolving to a public address", async () => {
    await expect(assertPublicUrl("https://example.com", lookup(["93.184.216.34"]))).resolves
      .toBeUndefined;
  });

  it("rejects a host resolving to a private address", async () => {
    await expect(assertPublicUrl("https://evil.test", lookup(["169.254.169.254"]))).rejects.toThrow(
      /non-public/,
    );
  });

  // A single public answer must not launder a private one.
  it("rejects when any resolved address is private", async () => {
    await expect(
      assertPublicUrl("https://mixed.test", lookup(["93.184.216.34", "10.0.0.1"])),
    ).rejects.toThrow(/non-public/);
  });

  it("rejects non-HTTP schemes", async () => {
    await expect(assertPublicUrl("file:///etc/passwd")).rejects.toThrow(/scheme/);
  });

  it("rejects a host that does not resolve", async () => {
    await expect(assertPublicUrl("https://nowhere.test", lookup([]))).rejects.toThrow(
      /could not resolve/,
    );
  });
});

describe("getJson", () => {
  const publicLookup = async () => ["93.184.216.34"];
  const ok = (body: unknown) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));

  it("returns parsed JSON and appends params", async () => {
    const fetcher = ok({ hello: "world" });
    const body = await getJson<{ hello: string }>("https://example.com/x", {
      params: { a: "1", skip: undefined },
      fetcher: fetcher as never,
      dnsLookup: publicLookup,
    });

    expect(body.hello).toBe("world");
    const [url] = fetcher.mock.calls[0]! as unknown as [URL];
    expect(url.searchParams.get("a")).toBe("1");
    expect(url.searchParams.has("skip")).toBe(false);
  });

  // Following a redirect would move the destination somewhere never validated.
  it("refuses to follow redirects", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response("", { status: 302, headers: { location: "http://169.254.169.254" } }),
    );
    await expect(
      getJson("https://example.com", { fetcher: fetcher as never, dnsLookup: publicLookup }),
    ).rejects.toThrow(/refusing redirect/);
  });

  it("passes redirect: manual so fetch cannot follow one for us", async () => {
    const fetcher = ok({});
    await getJson("https://example.com", { fetcher: fetcher as never, dnsLookup: publicLookup });
    const [, init] = fetcher.mock.calls[0]! as unknown as [URL, RequestInit];
    expect(init.redirect).toBe("manual");
  });

  it("raises on a 4xx/5xx", async () => {
    const fetcher = vi.fn(async () => new Response("nope", { status: 503 }));
    await expect(
      getJson("https://example.com", { fetcher: fetcher as never, dnsLookup: publicLookup }),
    ).rejects.toThrow(HttpError);
  });

  it("raises on invalid JSON rather than returning undefined", async () => {
    const fetcher = vi.fn(async () => new Response("<html>", { status: 200 }));
    await expect(
      getJson("https://example.com", { fetcher: fetcher as never, dnsLookup: publicLookup }),
    ).rejects.toThrow(/invalid JSON/);
  });

  // Operator-configured endpoints are allowed to be internal.
  it("skips the address check when requirePublic is false", async () => {
    const fetcher = ok({ ok: true });
    await expect(
      getJson("http://pds-private:3000/x", {
        requirePublic: false,
        fetcher: fetcher as never,
        dnsLookup: async () => ["10.0.0.5"],
      }),
    ).resolves.toEqual({ ok: true });
  });
});
