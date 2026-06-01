# IP Query Worker

A Cloudflare Worker that returns IP geolocation data with a browser UI for interactive lookups and JSON for CLI/API callers.

**Features:**
- Query any IP via `?ip=8.8.8.8` or auto-detect the client IP from request headers
- Offline geo lookup using Cloudflare D1 — no external API calls at runtime
- Browser web UI with interactive form, network info (navigator.connection), and response headers
- CLI friendly — `curl`, `httpie`, and similar tools get JSON automatically
- IPv4 and IPv6 support

<!-- Live demo — replace with your own deployment URL -->

---

## Quick Deploy

Deploy your own instance in minutes:

```bash
# 1. Clone and install
git clone <this-repo>
cd ip-query
npm install

# 2. Create D1 databases
wrangler d1 create ip-query-db
wrangler d1 create ip-query-city-db

# 3. Copy the returned IDs into wrangler.toml
#    (see wrangler.toml.example for the template)

# 4. Apply database migrations
npm run db:migrate:remote
npm run db:migrate:city:remote

# 5. Import geo data (see "Import Offline Geo Data" section below)
# 6. Deploy
npm run deploy
```

See [wrangler.toml.example](./wrangler.toml.example) for the configuration template.

---

## Setup

```bash
npm install
```

Run tests and type checking:

```bash
npm test
npm run typecheck
```

---

## D1 Database

Create the two D1 databases:

```bash
wrangler d1 create ip-query-db
wrangler d1 create ip-query-city-db
```

Copy the returned database UUIDs into `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "ip-query-db"
database_id = "your-main-d1-database-id"
migrations_dir = "migrations"

[[d1_databases]]
binding = "CITY_DB"
database_name = "ip-query-city-db"
database_id = "your-city-d1-database-id"
migrations_dir = "migrations-city"
```

Apply migrations:

```bash
# Local (for wrangler dev)
npm run db:migrate:local

# Remote
npm run db:migrate:remote
npm run db:migrate:city:remote
```

Migration `0002_seed_sample_ranges.sql` inserts a few sample rows for local smoke testing. They are not a replacement for a real IP geo database.

---

## Import Offline Geo Data

The worker uses three types of data, split across two D1 databases.

**Main database (`DB`):**
- `ip_asn_ranges` — iptoasn IPv4/IPv6 ranges with ASN and AS organization
- `ip_country_ranges` — iptoasn IPv4/IPv6 ranges as country fallback

**City database (`CITY_DB`):**
- `ip_city_locations` — deduplicated DB-IP City Lite locations
- `ip_city_v4_ranges` — DB-IP City Lite IPv4 ranges referencing locations
- `ip_city_v6_ranges` — DB-IP City Lite IPv6 ranges referencing locations

The worker does not call any external geo API at runtime. It derives `countryName`, `continentCode`, and `continentName` from the MIT-licensed [`countries-list`](https://www.npmjs.com/package/countries-list) package, and derives `timezone` from DB-IP lat/lng with the CC0-licensed [`tz-lookup`](https://www.npmjs.com/package/tz-lookup) package.

### Data Sources

**iptoasn** (country and ASN data) is available from [@ip-location-db/iptoasn-country](https://github.com/sapics/ip-location-db) and [@ip-location-db/iptoasn-asn](https://github.com/sapics/ip-location-db). It is licensed under `PDDL-1.0` and may be used without attribution.

```bash
# Download the CSV files from the ip-location-db releases
# and place them under data/raw/iptoasn-country/ and data/raw/iptoasn-asn/
```

**DB-IP City Lite** is available from [db-ip.com](https://db-ip.com/):

```bash
mkdir -p data/raw/dbip-city
curl -L 'https://download.db-ip.com/free/dbip-city-lite-2026-05.csv.gz' \
  -o data/raw/dbip-city/dbip-city-lite-2026-05.csv.gz
```

DB-IP City Lite is licensed under `CC BY 4.0`. The API response includes a DB-IP attribution entry whenever the result uses `dbip-city-lite`. Keep that attribution visible if another service or UI redisplays the geo result.

### Schema

IP ranges are stored as fixed-length lowercase hex strings:

- IPv4: 8 hex chars — `8.8.8.8` → `08080808`
- IPv6: 32 hex chars — `2001:4860:4860::8888` → `20014860486000000000000000008888`

Each lookup filters by `ip_version`, so lexicographic range comparison is stable:

```sql
WHERE ip_version = ? AND start_hex <= ? AND end_hex >= ?
ORDER BY start_hex DESC
LIMIT 1
```

### Import Tools

Two Python scripts are included:

- `scripts/csv-to-d1-sql.py` — converts generic CSV to compact SQL
- `scripts/dbip-city-to-d1-sql.py` — converts DB-IP City Lite rows to normalized SQL chunks

Supported range column names: `start_ip,end_ip`, `ip_range_start,ip_range_end`, `ip_from,ip_to`, `from,to`, `cidr`

Headerless CSV is supported with `--columns`.

**Convert the iptoasn data:**

```bash
python3 scripts/csv-to-d1-sql.py \
  data/raw/iptoasn-country/iptoasn-country-ipv4.csv \
  data/generated/iptoasn-country-ipv4-compact.sql \
  --source iptoasn-country \
  --columns ip_range_start,ip_range_end,country_code \
  --target country \
  --no-transaction

python3 scripts/csv-to-d1-sql.py \
  data/raw/iptoasn-country/iptoasn-country-ipv6.csv \
  data/generated/iptoasn-country-ipv6-compact.sql \
  --source iptoasn-country \
  --columns ip_range_start,ip_range_end,country_code \
  --target country \
  --no-transaction

python3 scripts/csv-to-d1-sql.py \
  data/raw/iptoasn-asn/iptoasn-asn-ipv4.csv \
  data/generated/iptoasn-asn-ipv4-compact.sql \
  --source iptoasn-asn \
  --columns ip_range_start,ip_range_end,autonomous_system_number,autonomous_system_organization \
  --target asn \
  --no-transaction

python3 scripts/csv-to-d1-sql.py \
  data/raw/iptoasn-asn/iptoasn-asn-ipv6.csv \
  data/generated/iptoasn-asn-ipv6-compact.sql \
  --source iptoasn-asn \
  --columns ip_range_start,ip_range_end,autonomous_system_number,autonomous_system_organization \
  --target asn \
  --no-transaction
```

**Convert DB-IP City Lite to normalized SQL chunks:**

```bash
rm -rf data/generated/city-normalized
python3 scripts/dbip-city-to-d1-sql.py \
  data/raw/dbip-city/dbip-city-lite-2026-05.csv.gz \
  data/generated/city-normalized \
  --location-chunk-size 50000 \
  --range-chunk-size 100000
```

**Split large files for remote D1 import (which has file size limits):**

```bash
rm -rf data/generated/chunks
mkdir -p data/generated/chunks/{asn,country}

for prefix in asn country; do
  for version in ipv4 ipv6; do
    split -l 100000 -d --additional-suffix=.sql \
      data/generated/iptoasn-${prefix}-${version}-compact.sql \
      data/generated/chunks/${prefix}/iptoasn-${prefix}-${version}-
  done
done
```

**Clear old data before re-importing:**

```bash
wrangler d1 execute ip-query-db --remote --command "DELETE FROM ip_asn_ranges;"
wrangler d1 execute ip-query-db --remote --command "DELETE FROM ip_country_ranges;"
```

**Import chunks into remote D1:**

```bash
for file in data/generated/chunks/country/*.sql; do
  wrangler d1 execute ip-query-db --remote --file="$file"
done

for file in data/generated/chunks/asn/*.sql; do
  wrangler d1 execute ip-query-db --remote --file="$file"
done

for file in data/generated/city-normalized/locations/*.sql; do
  wrangler d1 execute ip-query-city-db --remote --file="$file"
done

for file in data/generated/city-normalized/v4/*.sql; do
  wrangler d1 execute ip-query-city-db --remote --file="$file"
done

for file in data/generated/city-normalized/v6/*.sql; do
  wrangler d1 execute ip-query-city-db --remote --file="$file"
done
```

Expected row counts after a full May 2026 import:

| Table | Rows |
|---|---|
| `ip_city_locations` | 567,049 |
| `ip_city_v4_ranges` | 3,687,752 |
| `ip_city_v6_ranges` | 4,373,909 |
| `ip_asn_ranges` (IPv4) | 389,132 |
| `ip_asn_ranges` (IPv6) | 94,042 |
| `ip_country_ranges` (IPv4) | 220,736 |
| `ip_country_ranges` (IPv6) | 64,467 |

---

## Development

Start the local Worker:

```bash
npm run dev
```

Query a specific IP:

```bash
curl 'http://localhost:8787/api?ip=8.8.8.8'
```

Query the current client IP:

```bash
curl 'http://localhost:8787/api'
```

When running locally, Wrangler may not send `CF-Connecting-IP`. Use `?ip=` for deterministic local checks.

Deploy:

```bash
npm run deploy
```

---

## API

### Endpoints

| Path | Accepts | Result |
|---|---|---|
| `GET /api?ip=8.8.8.8` | Any | JSON |
| `GET /?ip=8.8.8.8` | CLI / `Accept: application/json` | JSON |
| `GET /` | Browser (`text/html`) | Web UI |

### Response

```json
{
  "ip": {
    "value": "8.8.8.8",
    "version": 4,
    "source": "query"
  },
  "geo": {
    "found": true,
    "countryCode": "US",
    "countryName": "United States",
    "continentCode": "NA",
    "continentName": "North America",
    "region": "California",
    "city": "Mountain View",
    "latitude": 37.386,
    "longitude": -122.0838,
    "timezone": "America/Los_Angeles",
    "asn": 15169,
    "asOrganization": "GOOGLE, US",
    "source": "dbip-city-lite",
    "sources": ["dbip-city-lite", "iptoasn-country", "iptoasn-asn"]
  },
  "network": {
    "isp": "Google LLC",
    "asn": 15169,
    "asOrganization": "GOOGLE, US",
    "source": "iptoasn-asn"
  },
  "attribution": [
    {
      "source": "DB-IP",
      "url": "https://db-ip.com/",
      "license": "CC BY 4.0",
      "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
      "note": "IP geolocation by DB-IP"
    }
  ],
  "headers": {
    "accept": "*/*",
    "user-agent": "curl/8.0.0",
    "cf-connecting-ip": "203.0.113.1"
  },
  "request": {
    "method": "GET",
    "url": "https://example.com/?ip=8.8.8.8",
    "timestamp": "2026-06-01T00:00:00.000Z"
  }
}
```

> **Note:** The `responseHeaders` field is added by the browser UI when rendering — it contains the actual HTTP response headers returned by the worker (e.g. `content-type`, `access-control-allow-origin`, `cf-ray`).

### Errors

**Invalid IP:**

```json
{
  "error": {
    "code": "INVALID_IP",
    "message": "Invalid IP address: not-an-ip"
  }
}
```

**No query IP and no client IP header:**

```json
{
  "error": {
    "code": "IP_NOT_FOUND",
    "message": "Provide ?ip= or send a client IP header."
  }
}
```

---

## Web UI

The browser UI renders at `/` for requests that accept `text/html`. It shows:

- **Geo panel** — country, continent, region, city, coordinates, timezone, ASN
- **Request panel** — IP source, method, timestamp, request headers, response headers, raw JSON
- **Network panel** — ISP, ASN, browser connection info (when available): connection type, effective type, downlink, RTT, save-data status, 5G/NR radio technology

The UI fetches `/api` internally. Response headers are captured from the fetch response and displayed in the "Response Headers" section.

---

## Project Structure

```
src/index.ts              Worker entry point
test/index.test.ts        Unit tests
migrations/               D1 migrations for the main database
migrations-city/          D1 migrations for the city database
scripts/                  Python data import tools
wrangler.toml             Worker configuration
wrangler.toml.example     Configuration template for new deployments
```

---

## License

The worker code itself is MIT. The imported geo datasets carry their own licenses (PDDL-1.0 for iptoasn, CC BY 4.0 for DB-IP City Lite).
