import ipaddr from "ipaddr.js";
import { continents, countries, type TContinentCode, type TCountryCode } from "countries-list";
import tzLookup from "tz-lookup";

export interface Env {
  DB: D1Database;
  CITY_DB: D1Database;
}

type IpSource = "query" | "cf-connecting-ip" | "x-forwarded-for" | "x-real-ip";

export interface ComparableIp {
  ip: string;
  version: 4 | 6;
  hex: string;
}

interface TargetIp {
  value: string;
  source: IpSource;
}

interface CityRangeRow {
  continent_code?: string | null;
  country_code?: string | null;
  region?: string | null;
  city?: string | null;
  latitude?: number | string | null;
  longitude?: number | string | null;
  source?: string | null;
}

interface AsnRangeRow {
  asn?: number | string | null;
  as_organization?: string | null;
  source?: string | null;
}

interface CountryRangeRow {
  country_code?: string | null;
  source?: string | null;
}

interface GeoResult {
  found: boolean;
  countryCode: string | null;
  countryName: string | null;
  continentCode: string | null;
  continentName: string | null;
  region: string | null;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
  timezone: string | null;
  asn: number | null;
  asOrganization: string | null;
  source: string;
  sources: string[];
}

interface NetworkResult {
  isp: string | null;
  asn: number | null;
  asOrganization: string | null;
  source: string | null;
}

interface Attribution {
  source: string;
  url: string;
  license: string;
  licenseUrl: string;
  note: string;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

const COUNTRY_LOOKUP_SQL = `
  SELECT
    country_code,
    source
  FROM ip_country_ranges
  WHERE ip_version = ? AND start_hex <= ? AND end_hex >= ?
  ORDER BY start_hex DESC
  LIMIT 1
`;

const ASN_LOOKUP_SQL = `
  SELECT
    asn,
    as_organization,
    source
  FROM ip_asn_ranges
  WHERE ip_version = ? AND start_hex <= ? AND end_hex >= ?
  ORDER BY start_hex DESC
  LIMIT 1
`;

const CITY_V4_LOOKUP_SQL = `
  SELECT
    locations.continent_code,
    locations.country_code,
    locations.region,
    locations.city,
    locations.latitude,
    locations.longitude,
    'dbip-city-lite' AS source
  FROM ip_city_v4_ranges AS ranges
  INNER JOIN ip_city_locations AS locations ON locations.id = ranges.location_id
  WHERE ranges.start_hex <= ? AND ranges.end_hex >= ?
  ORDER BY ranges.start_hex DESC
  LIMIT 1
`;

const CITY_V6_LOOKUP_SQL = `
  SELECT
    locations.continent_code,
    locations.country_code,
    locations.region,
    locations.city,
    locations.latitude,
    locations.longitude,
    'dbip-city-lite' AS source
  FROM ip_city_v6_ranges AS ranges
  INNER JOIN ip_city_locations AS locations ON locations.id = ranges.location_id
  WHERE ranges.start_hex <= ? AND ranges.end_hex >= ?
  ORDER BY ranges.start_hex DESC
  LIMIT 1
`;

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type"
};

const HTML_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store"
};

const DBIP_ATTRIBUTION: Attribution = {
  source: "DB-IP",
  url: "https://db-ip.com/",
  license: "CC BY 4.0",
  licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
  note: "IP geolocation by DB-IP"
};

export function ipToComparableHex(input: string): ComparableIp {
  const cleanInput = cleanIpInput(input);

  if (!ipaddr.isValid(cleanInput)) {
    throw new HttpError(400, "INVALID_IP", `Invalid IP address: ${input}`);
  }

  const parsed = ipaddr.process(cleanInput);

  const version = parsed.kind() === "ipv4" ? 4 : 6;
  const hex = parsed
    .toByteArray()
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

  return {
    ip: parsed.toString(),
    version,
    hex
  };
}

function cleanIpInput(input: string): string {
  const trimmed = input.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function resolveTargetIp(request: Request): TargetIp {
  const url = new URL(request.url);
  const queryIp = url.searchParams.get("ip")?.trim();
  if (queryIp) {
    return { value: queryIp, source: "query" };
  }

  const cfConnectingIp = request.headers.get("cf-connecting-ip")?.trim();
  if (cfConnectingIp) {
    return { value: cfConnectingIp, source: "cf-connecting-ip" };
  }

  const forwardedFor = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwardedFor) {
    return { value: forwardedFor, source: "x-forwarded-for" };
  }

  const realIp = request.headers.get("x-real-ip")?.trim();
  if (realIp) {
    return { value: realIp, source: "x-real-ip" };
  }

  throw new HttpError(400, "IP_NOT_FOUND", "Provide ?ip= or send a client IP header.");
}

async function lookupGeo(db: D1Database, cityDb: D1Database, ip: ComparableIp): Promise<GeoResult> {
  const cityLookup = cityDb
    .prepare(ip.version === 4 ? CITY_V4_LOOKUP_SQL : CITY_V6_LOOKUP_SQL)
    .bind(ip.hex, ip.hex)
    .first<CityRangeRow>();
  const countryLookup = db
    .prepare(COUNTRY_LOOKUP_SQL)
    .bind(ip.version, ip.hex, ip.hex)
    .first<CountryRangeRow>();
  const asnLookup = db
    .prepare(ASN_LOOKUP_SQL)
    .bind(ip.version, ip.hex, ip.hex)
    .first<AsnRangeRow>();
  const [cityRow, countryRow, asnRow] = await Promise.all([cityLookup, countryLookup, asnLookup]);

  if (!cityRow && !countryRow && !asnRow) {
    return emptyGeoResult();
  }

  const countryCode = stringOrNull(cityRow?.country_code) ?? stringOrNull(countryRow?.country_code);
  const continentCode = stringOrNull(cityRow?.continent_code);
  const metadata = getCountryMetadata(countryCode, continentCode);
  const latitude = numberOrNull(cityRow?.latitude);
  const longitude = numberOrNull(cityRow?.longitude);
  const timezone = latitude !== null && longitude !== null ? timezoneFor(latitude, longitude) : null;
  const sources = uniqueStrings([cityRow?.source, countryRow?.source, asnRow?.source]);

  return {
    found: true,
    countryCode,
    countryName: metadata.name,
    continentCode: metadata.continentCode,
    continentName: metadata.continentName,
    region: stringOrNull(cityRow?.region),
    city: stringOrNull(cityRow?.city),
    latitude,
    longitude,
    timezone,
    asn: numberOrNull(asnRow?.asn),
    asOrganization: stringOrNull(asnRow?.as_organization),
    source: sources[0] ?? "d1",
    sources
  };
}

function emptyGeoResult(): GeoResult {
  return {
    found: false,
    countryCode: null,
    countryName: null,
    continentCode: null,
    continentName: null,
    region: null,
    city: null,
    latitude: null,
    longitude: null,
    timezone: null,
    asn: null,
    asOrganization: null,
    source: "d1",
    sources: []
  };
}

function networkFor(geo: GeoResult): NetworkResult {
  const source = geo.sources.includes("iptoasn-asn") ? "iptoasn-asn" : null;

  return {
    isp: geo.asOrganization,
    asn: geo.asn,
    asOrganization: geo.asOrganization,
    source
  };
}

function attributionFor(sources: string[]): Attribution[] {
  if (sources.some((source) => source.startsWith("dbip-"))) {
    return [DBIP_ATTRIBUTION];
  }

  return [];
}

function getCountryMetadata(
  countryCode: string | null,
  fallbackContinentCode: string | null = null
): {
  name: string | null;
  continentCode: string | null;
  continentName: string | null;
} {
  if (!countryCode) {
    return {
      name: null,
      continentCode: fallbackContinentCode,
      continentName: continentNameFor(fallbackContinentCode)
    };
  }

  const normalizedCode = countryCode.toUpperCase() as TCountryCode;
  const country = countries[normalizedCode];
  if (!country) {
    return {
      name: null,
      continentCode: fallbackContinentCode,
      continentName: continentNameFor(fallbackContinentCode)
    };
  }

  const continentCode = fallbackContinentCode ?? (country.continent as TContinentCode);
  return {
    name: country.name,
    continentCode,
    continentName: continentNameFor(continentCode)
  };
}

function continentNameFor(continentCode: string | null): string | null {
  if (!continentCode) {
    return null;
  }
  return continents[continentCode as TContinentCode] ?? null;
}

function timezoneFor(latitude: number, longitude: number): string | null {
  try {
    return tzLookup(latitude, longitude);
  } catch {
    return null;
  }
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => stringOrNull(value)).filter((value) => value !== null))];
}

function stringOrNull(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function numberOrNull(value: number | string | null | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  for (const [key, value] of headers.entries()) {
    record[key] = value;
  }
  return record;
}

function shouldServeWebUi(request: Request): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return false;
  }

  const url = new URL(request.url);
  if (url.pathname !== "/" && url.pathname !== "/index.html") {
    return false;
  }

  if (url.searchParams.get("format") === "json") {
    return false;
  }

  const userAgent = request.headers.get("user-agent")?.toLowerCase() ?? "";
  if (isCliUserAgent(userAgent)) {
    return false;
  }

  const accept = request.headers.get("accept")?.toLowerCase() ?? "";
  if (accept.includes("application/json")) {
    return false;
  }

  return accept.includes("text/html") || isBrowserUserAgent(userAgent);
}

function isCliUserAgent(userAgent: string): boolean {
  return /\b(curl|wget|httpie|python-requests|go-http-client|libwww-perl|fetch|axios)\b/.test(
    userAgent
  );
}

function isBrowserUserAgent(userAgent: string): boolean {
  return /\b(mozilla|chrome|chromium|safari|firefox|edg|opr)\b/.test(userAgent);
}

function htmlResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: HTML_HEADERS
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: JSON_HEADERS
  });
}

function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    return jsonResponse(
      {
        error: {
          code: error.code,
          message: error.message
        }
      },
      error.status
    );
  }

  return jsonResponse(
    {
      error: {
        code: "GEO_LOOKUP_FAILED",
        message: "Failed to query geo data."
      }
    },
    500
  );
}

function webUiHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>IP Query</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f8fb;
      --panel: #ffffff;
      --ink: #1f2937;
      --muted: #667085;
      --line: #d8dde6;
      --accent: #0f766e;
      --accent-strong: #115e59;
      --danger: #b42318;
      --code: #101828;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--ink);
      font-family:
        Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: 0;
    }

    .shell {
      max-width: 940px;
      margin: 0 auto;
      padding: 28px 20px 40px;
    }

    header {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 20px;
      margin-bottom: 22px;
    }

    h1 {
      margin: 0;
      font-size: 28px;
      line-height: 1.15;
      font-weight: 700;
    }

    .status {
      min-height: 24px;
      color: var(--muted);
      font-size: 14px;
      text-align: right;
    }

    form {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto auto;
      gap: 10px;
      margin-bottom: 18px;
    }

    input {
      width: 100%;
      min-height: 44px;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 0 12px;
      color: var(--ink);
      background: var(--panel);
      font: inherit;
    }

    button {
      min-height: 44px;
      border: 1px solid var(--accent);
      border-radius: 6px;
      padding: 0 14px;
      background: var(--accent);
      color: #ffffff;
      font: inherit;
      font-weight: 650;
      cursor: pointer;
    }

    button.secondary {
      background: var(--panel);
      color: var(--accent-strong);
    }

    button:disabled {
      cursor: wait;
      opacity: 0.7;
    }

    .error {
      display: none;
      margin-bottom: 14px;
      border: 1px solid #fecdca;
      border-radius: 6px;
      padding: 10px 12px;
      color: var(--danger);
      background: #fffbfa;
      font-size: 14px;
    }

    .error.visible {
      display: block;
    }

    .grid {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 16px;
      align-items: start;
    }

    section {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 16px;
    }

    h2 {
      margin: 0 0 14px;
      font-size: 15px;
      line-height: 1.3;
      font-weight: 700;
      color: var(--muted);
      text-transform: uppercase;
    }

    .summary {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
      margin-bottom: 16px;
    }

    .metric {
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 12px;
      min-height: 76px;
    }

    .label {
      margin-bottom: 6px;
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
    }

    .value {
      overflow-wrap: anywhere;
      font-size: 18px;
      font-weight: 700;
    }

    dl {
      display: grid;
      grid-template-columns: 150px minmax(0, 1fr);
      gap: 8px 12px;
      margin: 0;
      font-size: 14px;
    }

    dt {
      color: var(--muted);
    }

    dd {
      margin: 0;
      overflow-wrap: anywhere;
      color: var(--ink);
    }

    details {
      margin-top: 16px;
      border-top: 1px solid var(--line);
      padding-top: 12px;
    }

    summary {
      cursor: pointer;
      color: var(--accent-strong);
      font-weight: 650;
    }

    pre {
      margin: 12px 0 0;
      max-height: 520px;
      overflow: auto;
      border-radius: 6px;
      padding: 12px;
      background: #111827;
      color: #e5e7eb;
      font-size: 12px;
      line-height: 1.55;
      tab-size: 2;
    }

    .attribution {
      margin-top: 12px;
      color: var(--muted);
      font-size: 12px;
    }

    .attribution a {
      color: var(--accent-strong);
    }

    .placeholder {
      color: var(--muted);
    }

    @media (max-width: 820px) {
      header {
        align-items: flex-start;
        flex-direction: column;
      }

      .status {
        text-align: left;
      }

      form {
        grid-template-columns: 1fr;
      }

      .grid,
      .summary,
      dl {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <main class="shell">
    <header>
      <h1>IP Query</h1>
      <div id="status" class="status">Ready</div>
    </header>

    <form id="query-form">
      <input id="ip-input" name="ip" autocomplete="off" spellcheck="false" placeholder="8.8.8.8 or 2a09:bac5:1f4b:16dc::247:5f">
      <button id="lookup-button" type="submit">Lookup</button>
      <button id="current-button" class="secondary" type="button">Current IP</button>
    </form>

    <div id="error" class="error"></div>

    <div class="grid">
      <section>
        <h2>Geo</h2>
        <div class="summary">
          <div class="metric">
            <div class="label">IP</div>
            <div id="metric-ip" class="value placeholder">-</div>
          </div>
          <div class="metric">
            <div class="label">Location</div>
            <div id="metric-location" class="value placeholder">-</div>
          </div>
          <div class="metric">
            <div class="label">Network</div>
            <div id="metric-network" class="value placeholder">-</div>
          </div>
        </div>
        <dl id="geo-list"></dl>
        <div id="attribution" class="attribution"></div>
      </section>

      <section>
        <h2>Request</h2>
        <dl id="request-list"></dl>
        <details open>
          <summary>Request Headers</summary>
          <pre id="headers-json">{}</pre>
        </details>
        <details>
          <summary>Response Headers</summary>
          <pre id="response-headers-json">{}</pre>
        </details>
        <details>
          <summary>JSON</summary>
          <pre id="raw-json">{}</pre>
        </details>
      </section>

      <section>
        <h2>Network</h2>
        <dl id="network-list"></dl>
      </section>
    </div>
  </main>

  <script>
    const form = document.querySelector("#query-form");
    const input = document.querySelector("#ip-input");
    const currentButton = document.querySelector("#current-button");
    const lookupButton = document.querySelector("#lookup-button");
    const statusNode = document.querySelector("#status");
    const errorNode = document.querySelector("#error");
    let latestData = null;

    const fields = [
      ["Country", "countryName", "countryCode"],
      ["Continent", "continentName", "continentCode"],
      ["Region", "region"],
      ["City", "city"],
      ["Latitude", "latitude"],
      ["Longitude", "longitude"],
      ["Timezone", "timezone"],
      ["ASN", "asn"],
      ["AS Organization", "asOrganization"],
      ["Source", "source"]
    ];

    function text(value) {
      if (value === null || value === undefined || value === "") return "-";
      return String(value);
    }

    function pair(primary, secondary) {
      const first = text(primary);
      const second = text(secondary);
      if (first === "-") return second;
      if (second === "-" || second === first) return first;
      return first + " (" + second + ")";
    }

    function connectionApi() {
      return navigator.connection || navigator.mozConnection || navigator.webkitConnection || null;
    }

    function collectBrowserNetwork() {
      const connection = connectionApi();
      if (!connection) {
        return {
          supported: false,
          type: null,
          effectiveType: null,
          downlink: null,
          rtt: null,
          saveData: null,
          source: null,
          radioTechnology: "Not exposed by browser"
        };
      }

      return {
        supported: true,
        type: connection.type || null,
        effectiveType: connection.effectiveType || null,
        downlink: typeof connection.downlink === "number" ? connection.downlink : null,
        rtt: typeof connection.rtt === "number" ? connection.rtt : null,
        saveData: typeof connection.saveData === "boolean" ? connection.saveData : null,
        source: "navigator.connection",
        radioTechnology: "Not exposed by browser"
      };
    }

    function formatConnectionType(value) {
      if (!value) return "-";
      const labels = {
        bluetooth: "Bluetooth",
        cellular: "Cellular",
        ethernet: "Ethernet",
        mixed: "Mixed",
        none: "None",
        other: "Other",
        unknown: "Unknown",
        wifi: "Wi-Fi",
        wimax: "WiMAX"
      };
      return labels[String(value).toLowerCase()] || text(value);
    }

    function formatEffectiveType(value) {
      if (!value) return "-";
      const labels = {
        "slow-2g": "Slow 2G",
        "2g": "2G",
        "3g": "3G",
        "4g": "4G"
      };
      return labels[String(value).toLowerCase()] || String(value).toUpperCase();
    }

    function formatMbps(value) {
      return typeof value === "number" ? value + " Mbps" : "-";
    }

    function formatMs(value) {
      return typeof value === "number" ? value + " ms" : "-";
    }

    function setLoading(loading) {
      lookupButton.disabled = loading;
      currentButton.disabled = loading;
      statusNode.textContent = loading ? "Loading" : "Ready";
    }

    function showError(message) {
      errorNode.textContent = message;
      errorNode.classList.add("visible");
    }

    function clearError() {
      errorNode.textContent = "";
      errorNode.classList.remove("visible");
    }

    function renderList(node, items) {
      node.innerHTML = "";
      for (const [label, value] of items) {
        const dt = document.createElement("dt");
        const dd = document.createElement("dd");
        dt.textContent = label;
        dd.textContent = text(value);
        node.append(dt, dd);
      }
    }

    function renderResult(data) {
      const geo = data.geo || {};
      const network = data.network || {};
      const browserNetwork = collectBrowserNetwork();
      const enrichedData = {
        ...data,
        network: {
          ...network,
          browserConnection: browserNetwork
        }
      };

      document.querySelector("#metric-ip").textContent = data.ip ? data.ip.value : "-";
      document.querySelector("#metric-ip").classList.remove("placeholder");
      document.querySelector("#metric-location").textContent = [geo.city, geo.region, geo.countryCode]
        .filter(Boolean)
        .join(", ") || "-";
      document.querySelector("#metric-location").classList.remove("placeholder");
      document.querySelector("#metric-network").textContent = network.isp || (geo.asn
        ? "AS" + geo.asn
        : "-");
      document.querySelector("#metric-network").classList.remove("placeholder");

      renderList(
        document.querySelector("#geo-list"),
        fields.map(([label, key, altKey]) => [
          label,
          altKey ? pair(geo[key], geo[altKey]) : geo[key]
        ])
      );

      renderList(document.querySelector("#request-list"), [
        ["IP Source", data.ip && data.ip.source],
        ["Version", data.ip && "IPv" + data.ip.version],
        ["Method", data.request && data.request.method],
        ["Timestamp", data.request && data.request.timestamp]
      ]);

      renderList(document.querySelector("#network-list"), [
        ["ISP", network.isp],
        ["ASN", network.asn ? "AS" + network.asn : null],
        ["AS Organization", network.asOrganization],
        ["Connection", formatConnectionType(browserNetwork.type)],
        ["Effective Type", formatEffectiveType(browserNetwork.effectiveType)],
        ["Downlink", formatMbps(browserNetwork.downlink)],
        ["RTT", formatMs(browserNetwork.rtt)],
        ["Save Data", typeof browserNetwork.saveData === "boolean" ? String(browserNetwork.saveData) : null],
        ["5G / LTE / SA / NSA", browserNetwork.radioTechnology],
        ["Source", [network.source, browserNetwork.source].filter(Boolean).join(" + ")]
      ]);

      const attribution = document.querySelector("#attribution");
      attribution.innerHTML = "";
      for (const item of data.attribution || []) {
        const link = document.createElement("a");
        link.href = item.url;
        link.rel = "noreferrer";
        link.target = "_blank";
        link.textContent = item.note || item.source;
        attribution.append(link, document.createTextNode(" - " + item.license));
      }

      document.querySelector("#headers-json").textContent = JSON.stringify(data.headers || {}, null, 2);
      document.querySelector("#response-headers-json").textContent = JSON.stringify(data.responseHeaders || {}, null, 2);
      document.querySelector("#raw-json").textContent = JSON.stringify(enrichedData, null, 2);
    }

    async function lookup(ip) {
      clearError();
      setLoading(true);
      try {
        const target = ip ? "/api?ip=" + encodeURIComponent(ip) : "/api";
        const response = await fetch(target, {
          headers: { accept: "application/json" }
        });
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data && data.error ? data.error.message : "Lookup failed");
        }
        const respHeaders = {};
        response.headers.forEach((value, key) => { respHeaders[key] = value; });
        data.responseHeaders = respHeaders;
        latestData = data;
        renderResult(data);
      } catch (error) {
        showError(error instanceof Error ? error.message : "Lookup failed");
      } finally {
        setLoading(false);
      }
    }

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      lookup(input.value.trim());
    });

    currentButton.addEventListener("click", () => {
      input.value = "";
      lookup("");
    });

    const browserConnection = connectionApi();
    if (browserConnection && typeof browserConnection.addEventListener === "function") {
      browserConnection.addEventListener("change", () => {
        if (latestData) renderResult(latestData);
      });
    }

    const initialIp = new URLSearchParams(location.search).get("ip");
    if (initialIp) {
      input.value = initialIp;
      lookup(initialIp);
    } else {
      lookup("");
    }
  </script>
</body>
</html>`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: JSON_HEADERS });
    }

    const url = new URL(request.url);
    if (shouldServeWebUi(request)) {
      return htmlResponse(webUiHtml());
    }

    try {
      const target = resolveTargetIp(request);
      const comparableIp = ipToComparableHex(target.value);
      const geo = await lookupGeo(env.DB, env.CITY_DB, comparableIp);

      return jsonResponse({
        ip: {
          value: comparableIp.ip,
          version: comparableIp.version,
          source: target.source
        },
        geo,
        network: networkFor(geo),
        attribution: attributionFor(geo.sources),
        headers: headersToRecord(request.headers),
        request: {
          method: request.method,
          url: request.url,
          timestamp: new Date().toISOString()
        }
      });
    } catch (error) {
      return errorResponse(error);
    }
  }
};
