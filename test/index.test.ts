import { describe, expect, it } from "vitest";

import worker, { ipToComparableHex } from "../src/index";

type FakeRow = Record<string, unknown> | null;

function createEnv(rows: FakeRow | FakeRow[]) {
  const calls: Array<{ sql: string; bindings: unknown[] }> = [];
  const rowQueue = Array.isArray(rows) ? [...rows] : [rows];
  const db = {
    prepare(sql: string) {
      return {
        bind(...bindings: unknown[]) {
          calls.push({ sql, bindings });
          return {
            async first() {
              return rowQueue.shift() ?? null;
            }
          };
        }
      };
    }
  } as unknown as D1Database;

  return { DB: db, calls };
}

function createSplitEnv(dbRows: FakeRow | FakeRow[], cityRows: FakeRow | FakeRow[]) {
  const db = createEnv(dbRows);
  const city = createEnv(cityRows);

  return {
    DB: db.DB,
    CITY_DB: city.DB,
    dbCalls: db.calls,
    cityCalls: city.calls
  };
}

describe("ipToComparableHex", () => {
  it("converts IPv4 and IPv6 addresses to comparable hex values", () => {
    expect(ipToComparableHex("8.8.8.8")).toEqual({
      ip: "8.8.8.8",
      version: 4,
      hex: "08080808"
    });

    expect(ipToComparableHex("2001:4860:4860::8888")).toEqual({
      ip: "2001:4860:4860::8888",
      version: 6,
      hex: "20014860486000000000000000008888"
    });
  });
});

describe("worker fetch", () => {
  it("serves the web UI for browser requests to the root path", async () => {
    const env = createSplitEnv([null, null], null);

    const response = await worker.fetch(
      new Request("https://example.test/", {
        headers: {
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "User-Agent": "Mozilla/5.0 Chrome/147.0.0.0 Safari/537.36"
        }
      }),
      env
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(body).toContain("<title>IP Query</title>");
    expect(body).toContain("/api");
    expect(env.dbCalls).toHaveLength(0);
    expect(env.cityCalls).toHaveLength(0);
  });

  it("stacks the Request panel directly under the Geo panel", async () => {
    const env = createSplitEnv([null, null], null);

    const response = await worker.fetch(
      new Request("https://example.test/", {
        headers: {
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "User-Agent": "Mozilla/5.0 Chrome/147.0.0.0 Safari/537.36"
        }
      }),
      env
    );
    const body = await response.text();

    expect(body.indexOf("<h2>Geo</h2>")).toBeLessThan(body.indexOf("<h2>Request</h2>"));
    expect(body).toContain("grid-template-columns: minmax(0, 1fr);");
  });

  it("serves a Network panel backed by browser connection information", async () => {
    const env = createSplitEnv([null, null], null);

    const response = await worker.fetch(
      new Request("https://example.test/", {
        headers: {
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "User-Agent": "Mozilla/5.0 Chrome/147.0.0.0 Safari/537.36"
        }
      }),
      env
    );
    const body = await response.text();

    expect(body).toContain("<h2>Network</h2>");
    expect(body).toContain('id="network-list"');
    expect(body).toContain("navigator.connection");
    expect(body).toContain("Effective Type");
    expect(body).toContain("5G / LTE / SA / NSA");
  });

  it("keeps returning JSON for CLI requests to the root path", async () => {
    const env = createSplitEnv(
      [
        {
          country_code: "US",
          source: "iptoasn-country"
        },
        {
          asn: 15169,
          as_organization: "GOOGLE",
          source: "iptoasn-asn"
        }
      ],
      {
        continent_code: "NA",
        country_code: "US",
        region: "California",
        city: "Mountain View",
        latitude: 37.422,
        longitude: -122.085,
        source: "dbip-city-lite"
      }
    );

    const response = await worker.fetch(
      new Request("https://example.test/", {
        headers: {
          "CF-Connecting-IP": "8.8.8.8",
          Accept: "*/*",
          "User-Agent": "curl/8.20.0"
        }
      }),
      env
    );
    const body = (await response.json()) as Record<string, any>;

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(body.ip).toMatchObject({ value: "8.8.8.8", source: "cf-connecting-ip" });
    expect(body.geo).toMatchObject({ city: "Mountain View" });
  });

  it("keeps the API path JSON-only for browser callers", async () => {
    const env = createSplitEnv(
      [
        {
          country_code: "US",
          source: "iptoasn-country"
        },
        {
          asn: 15169,
          as_organization: "GOOGLE",
          source: "iptoasn-asn"
        }
      ],
      {
        continent_code: "NA",
        country_code: "US",
        region: "California",
        city: "Mountain View",
        latitude: 37.422,
        longitude: -122.085,
        source: "dbip-city-lite"
      }
    );

    const response = await worker.fetch(
      new Request("https://example.test/api?ip=8.8.8.8", {
        headers: {
          Accept: "text/html,application/xhtml+xml",
          "User-Agent": "Mozilla/5.0 Chrome/147.0.0.0 Safari/537.36"
        }
      }),
      env
    );
    const body = (await response.json()) as Record<string, any>;

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(body.ip).toMatchObject({ value: "8.8.8.8", source: "query" });
    expect(body.geo).toMatchObject({ city: "Mountain View" });
  });

  it("uses query ip and returns D1 geo data plus request headers", async () => {
    const env = createSplitEnv(
      [
        {
          country_code: "US",
          source: "iptoasn-country"
        },
        {
          asn: 15169,
          as_organization: "GOOGLE, US",
          source: "iptoasn-asn"
        }
      ],
      {
        continent_code: "NA",
        country_code: "US",
        region: "California",
        city: "Mountain View",
        latitude: 37.386,
        longitude: -122.0838,
        source: "dbip-city-lite"
      }
    );

    const response = await worker.fetch(
      new Request("https://example.test/?ip=8.8.8.8", {
        headers: { "User-Agent": "vitest" }
      }),
      env
    );
    const body = (await response.json()) as Record<string, any>;

    expect(response.status).toBe(200);
    expect(env.cityCalls[0]?.bindings).toEqual(["08080808", "08080808"]);
    expect(env.dbCalls[0]?.bindings).toEqual([4, "08080808", "08080808"]);
    expect(env.dbCalls[1]?.bindings).toEqual([4, "08080808", "08080808"]);
    expect(body.ip).toMatchObject({ value: "8.8.8.8", version: 4, source: "query" });
    expect(body.geo).toMatchObject({
      found: true,
      countryCode: "US",
      countryName: "United States",
      continentCode: "NA",
      continentName: "North America",
      region: "California",
      city: "Mountain View",
      latitude: 37.386,
      longitude: -122.0838,
      timezone: "America/Los_Angeles",
      asn: 15169,
      asOrganization: "GOOGLE, US",
      sources: ["dbip-city-lite", "iptoasn-country", "iptoasn-asn"]
    });
    expect(body.network).toEqual({
      isp: "GOOGLE, US",
      asn: 15169,
      asOrganization: "GOOGLE, US",
      source: "iptoasn-asn"
    });
    expect(body.attribution).toEqual([
      {
        source: "DB-IP",
        url: "https://db-ip.com/",
        license: "CC BY 4.0",
        licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
        note: "IP geolocation by DB-IP"
      }
    ]);
    expect(body.headers["user-agent"]).toBe("vitest");
  });

  it("uses the normalized city D1 binding for IPv6 city data", async () => {
    const env = createSplitEnv(
      [
        {
          country_code: "US",
          source: "iptoasn-country"
        },
        {
          asn: 13335,
          as_organization: "CLOUDFLARENET",
          source: "iptoasn-asn"
        }
      ],
      {
        continent_code: "AS",
        country_code: "CN",
        region: "Beijing",
        city: "Beijing",
        latitude: 39.9042,
        longitude: 116.407,
        source: "dbip-city-lite"
      }
    );

    const response = await worker.fetch(
      new Request("https://example.test/?ip=2a09:bac5:1f4b:16dc::247:5f"),
      env
    );
    const body = (await response.json()) as Record<string, any>;

    expect(response.status).toBe(200);
    expect(env.cityCalls[0]?.bindings).toEqual([
      "2a09bac51f4b16dc000000000247005f",
      "2a09bac51f4b16dc000000000247005f"
    ]);
    expect(env.dbCalls[0]?.bindings).toEqual([
      6,
      "2a09bac51f4b16dc000000000247005f",
      "2a09bac51f4b16dc000000000247005f"
    ]);
    expect(body.geo).toMatchObject({
      found: true,
      countryCode: "CN",
      countryName: "China",
      continentCode: "AS",
      continentName: "Asia",
      region: "Beijing",
      city: "Beijing",
      latitude: 39.9042,
      longitude: 116.407,
      timezone: "Asia/Shanghai",
      asn: 13335,
      asOrganization: "CLOUDFLARENET",
      sources: ["dbip-city-lite", "iptoasn-country", "iptoasn-asn"]
    });
  });

  it("falls back to CF-Connecting-IP when query ip is absent", async () => {
    const env = createSplitEnv(
      [
        {
          country_code: "US",
          source: "iptoasn-country"
        },
        {
          asn: 13335,
          as_organization: "CLOUDFLARENET",
          source: "iptoasn-asn"
        }
      ],
      {
        continent_code: "AS",
        country_code: "CN",
        region: "Beijing",
        city: "Beijing",
        latitude: 39.9042,
        longitude: 116.407,
        source: "dbip-city-lite"
      }
    );

    const response = await worker.fetch(
      new Request("https://example.test/", {
        headers: { "CF-Connecting-IP": "2a09:bac5:1f4b:16dc::247:5f" }
      }),
      env
    );
    const body = (await response.json()) as Record<string, any>;

    expect(response.status).toBe(200);
    expect(body.ip).toMatchObject({
      value: "2a09:bac5:1f4b:16dc::247:5f",
      version: 6,
      source: "cf-connecting-ip"
    });
    expect(body.geo).toMatchObject({
      found: true,
      countryCode: "CN",
      city: "Beijing",
      timezone: "Asia/Shanghai"
    });
    expect(body.attribution).toHaveLength(1);
  });

  it("returns 400 JSON for invalid query ip and does not query D1", async () => {
    const env = createSplitEnv([null, null], null);

    const response = await worker.fetch(new Request("https://example.test/?ip=not-an-ip"), env);
    const body = (await response.json()) as Record<string, any>;

    expect(response.status).toBe(400);
    expect(env.dbCalls).toHaveLength(0);
    expect(env.cityCalls).toHaveLength(0);
    expect(body.error).toMatchObject({ code: "INVALID_IP" });
  });

  it("returns 400 JSON when no query or client ip is available", async () => {
    const env = createSplitEnv([null, null], null);

    const response = await worker.fetch(new Request("https://example.test/"), env);
    const body = (await response.json()) as Record<string, any>;

    expect(response.status).toBe(400);
    expect(body.error).toMatchObject({ code: "IP_NOT_FOUND" });
  });
});
