# IP Query Worker — IP 地理位置查询

一个运行在 Cloudflare Worker 上的 IP 查询服务，提供浏览器 UI 和 JSON API，基于 Cloudflare D1 离线数据库，无需调用外部 API。

**功能：**
- 通过 `?ip=8.8.8.8` 查询任意 IP，或自动检测客户端 IP
- 基于 Cloudflare D1 的离线地理位置数据，运行时无外部 API 调用
- 浏览器 Web UI，支持交互式查询、网络信息（navigator.connection）和响应头展示
- 自动识别 CLI 工具（`curl`、`httpie` 等）并返回 JSON
- 支持 IPv4 和 IPv6

---

## 快速部署

只需几分钟即可部署你自己的实例：

```bash
# 1. 克隆并安装依赖
git clone <本仓库>
cd ip-query
npm install

# 2. 创建 D1 数据库
wrangler d1 create ip-query-db           # 主数据库（ASN + 国家）
wrangler d1 create ip-query-city-db      # 城市数据库

# 3. 将返回的数据库 ID 填入 wrangler.toml
#    参考 wrangler.toml.example 模板

# 4. 执行数据库迁移
npm run db:migrate:remote
npm run db:migrate:city:remote

# 5. 导入地理数据（详见下方数据导入章节）
# 6. 部署
npm run deploy
```

模板文件见 [wrangler.toml.example](./wrangler.toml.example)。

---

## 安装

```bash
npm install
```

运行测试和类型检查：

```bash
npm test
npm run typecheck
```

---

## D1 数据库

创建两个 D1 数据库：

```bash
wrangler d1 create ip-query-db
wrangler d1 create ip-query-city-db
```

将返回的数据库 UUID 填入 `wrangler.toml`：

```toml
[[d1_databases]]
binding = "DB"
database_name = "ip-query-db"
database_id = "你的-主数据库-ID"
migrations_dir = "migrations"

[[d1_databases]]
binding = "CITY_DB"
database_name = "ip-query-city-db"
database_id = "你的-城市数据库-ID"
migrations_dir = "migrations-city"
```

执行迁移：

```bash
# 本地（用于 wrangler dev 开发）
npm run db:migrate:local

# 远程（生产环境）
npm run db:migrate:remote
npm run db:migrate:city:remote
```

迁移文件 `0002_seed_sample_ranges.sql` 包含了少量示例数据用于本地测试，不能替代真实的 IP 地理数据库。

---

## 导入离线地理数据

Worker 在运行时**不调用任何外部 API**，所有数据通过离线导入到 D1 数据库中。

### 数据库结构

**主数据库（DB）：**
- `ip_asn_ranges` — iptoasn IPv4/IPv6 范围，包含 ASN 和所属组织
- `ip_country_ranges` — iptoasn IPv4/IPv6 范围，作为国家级的备用数据

**城市数据库（CITY_DB）：**
- `ip_city_locations` — 去重后的 DB-IP City Lite 位置数据
- `ip_city_v4_ranges` — DB-IP City Lite IPv4 范围，关联到位置表
- `ip_city_v6_ranges` — DB-IP City Lite IPv6 范围，关联到位置表

国家名称、大洲信息通过 [`countries-list`](https://www.npmjs.com/package/countries-list)（MIT 许可）从国家代码派生。时区信息通过 [`tz-lookup`](https://www.npmjs.com/package/tz-lookup)（CC0 许可）从经纬度派生。

### 数据来源

**iptoasn**（国家和 ASN 数据）来自 [@ip-location-db](https://github.com/sapics/ip-location-db)，采用 `PDDL-1.0` 许可，可无需署名使用。

```bash
# 从 ip-location-db 的 releases 下载 CSV 文件
# 分别放入 data/raw/iptoasn-country/ 和 data/raw/iptoasn-asn/ 目录
```

**DB-IP City Lite** 来自 [db-ip.com](https://db-ip.com/)：

```bash
mkdir -p data/raw/dbip-city
curl -L 'https://download.db-ip.com/free/dbip-city-lite-2026-05.csv.gz' \
  -o data/raw/dbip-city/dbip-city-lite-2026-05.csv.gz
```

DB-IP City Lite 采用 `CC BY 4.0` 许可。API 响应中会包含 DB-IP 的署名信息。如果你在其他服务或 UI 中展示地理结果，请保留该署名。

### 存储格式

IP 范围以固定长度的小写十六进制字符串存储：

- IPv4：8 位十六进制，例如 `8.8.8.8` → `08080808`
- IPv6：32 位十六进制，例如 `2001:4860:4860::8888` → `20014860486000000000000000008888`

查询通过 `ip_version` 过滤，然后按字典序进行范围比较：

```sql
WHERE ip_version = ? AND start_hex <= ? AND end_hex >= ?
ORDER BY start_hex DESC
LIMIT 1
```

### 导入工具

包含两个 Python 脚本：

- `scripts/csv-to-d1-sql.py` — 将通用 CSV 转换为紧凑 SQL
- `scripts/dbip-city-to-d1-sql.py` — 将 DB-IP City Lite 转换为归一化的 SQL 分块

支持的范围列名：`start_ip,end_ip`、`ip_range_start,ip_range_end`、`ip_from,ip_to`、`from,to`、`cidr`

无表头的 CSV 文件可通过 `--columns` 参数指定列名。

**转换 iptoasn 数据：**

```bash
# 国家数据 - IPv4
python3 scripts/csv-to-d1-sql.py \
  data/raw/iptoasn-country/iptoasn-country-ipv4.csv \
  data/generated/iptoasn-country-ipv4-compact.sql \
  --source iptoasn-country \
  --columns ip_range_start,ip_range_end,country_code \
  --target country \
  --no-transaction

# 国家数据 - IPv6
python3 scripts/csv-to-d1-sql.py \
  data/raw/iptoasn-country/iptoasn-country-ipv6.csv \
  data/generated/iptoasn-country-ipv6-compact.sql \
  --source iptoasn-country \
  --columns ip_range_start,ip_range_end,country_code \
  --target country \
  --no-transaction

# ASN 数据 - IPv4
python3 scripts/csv-to-d1-sql.py \
  data/raw/iptoasn-asn/iptoasn-asn-ipv4.csv \
  data/generated/iptoasn-asn-ipv4-compact.sql \
  --source iptoasn-asn \
  --columns ip_range_start,ip_range_end,autonomous_system_number,autonomous_system_organization \
  --target asn \
  --no-transaction

# ASN 数据 - IPv6
python3 scripts/csv-to-d1-sql.py \
  data/raw/iptoasn-asn/iptoasn-asn-ipv6.csv \
  data/generated/iptoasn-asn-ipv6-compact.sql \
  --source iptoasn-asn \
  --columns ip_range_start,ip_range_end,autonomous_system_number,autonomous_system_organization \
  --target asn \
  --no-transaction
```

**转换 DB-IP City Lite 为归一化 SQL 分块：**

```bash
rm -rf data/generated/city-normalized
python3 scripts/dbip-city-to-d1-sql.py \
  data/raw/dbip-city/dbip-city-lite-2026-05.csv.gz \
  data/generated/city-normalized \
  --location-chunk-size 50000 \
  --range-chunk-size 100000
```

**拆分大文件以便导入远程 D1（有文件大小限制）：**

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

**重新导入前清理旧数据：**

```bash
wrangler d1 execute ip-query-db --remote --command "DELETE FROM ip_asn_ranges;"
wrangler d1 execute ip-query-db --remote --command "DELETE FROM ip_country_ranges;"
```

**导入到远程 D1：**

```bash
# 国家数据
for file in data/generated/chunks/country/*.sql; do
  wrangler d1 execute ip-query-db --remote --file="$file"
done

# ASN 数据
for file in data/generated/chunks/asn/*.sql; do
  wrangler d1 execute ip-query-db --remote --file="$file"
done

# 城市数据 - 位置
for file in data/generated/city-normalized/locations/*.sql; do
  wrangler d1 execute ip-query-city-db --remote --file="$file"
done

# 城市数据 - IPv4
for file in data/generated/city-normalized/v4/*.sql; do
  wrangler d1 execute ip-query-city-db --remote --file="$file"
done

# 城市数据 - IPv6
for file in data/generated/city-normalized/v6/*.sql; do
  wrangler d1 execute ip-query-city-db --remote --file="$file"
done
```

完整导入后（2026 年 5 月数据集）的预期行数：

| 表 | 行数 |
|---|---|
| `ip_city_locations` | 567,049 |
| `ip_city_v4_ranges` | 3,687,752 |
| `ip_city_v6_ranges` | 4,373,909 |
| `ip_asn_ranges` (IPv4) | 389,132 |
| `ip_asn_ranges` (IPv6) | 94,042 |
| `ip_country_ranges` (IPv4) | 220,736 |
| `ip_country_ranges` (IPv6) | 64,467 |

---

## 开发

启动本地 Worker：

```bash
npm run dev
```

查询指定 IP：

```bash
curl 'http://localhost:8787/api?ip=8.8.8.8'
```

查询当前客户端 IP：

```bash
curl 'http://localhost:8787/api'
```

本地开发时 Wrangler 可能不会发送 `CF-Connecting-IP` 头，请使用 `?ip=` 参数进行确定性的本地测试。

生产部署：

```bash
npm run deploy
```

---

## API 接口

### 端点

| 路径 | 请求方 | 返回 |
|---|---|---|
| `GET /api?ip=8.8.8.8` | 任意 | JSON |
| `GET /?ip=8.8.8.8` | CLI / `Accept: application/json` | JSON |
| `GET /` | 浏览器（`Accept: text/html`） | Web UI |

### 响应格式

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

> **说明：** `responseHeaders` 字段由浏览器 UI 在渲染时添加，包含 Worker 返回的实际 HTTP 响应头（如 `content-type`、`access-control-allow-origin`、`cf-ray` 等）。

### 错误响应

**无效 IP：**

```json
{
  "error": {
    "code": "INVALID_IP",
    "message": "Invalid IP address: not-an-ip"
  }
}
```

**未提供 IP：**

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

浏览器访问 `/` 时（请求头包含 `Accept: text/html`）返回 Web UI。页面包含以下面板：

- **地理位置（Geo）** — 国家、大洲、地区、城市、坐标、时区、ASN
- **请求信息（Request）** — IP 来源、请求方法、时间戳、请求头、响应头、原始 JSON
- **网络信息（Network）** — ISP、ASN、浏览器网络连接信息（可用时）：连接类型、有效类型、下行速度、RTT、省流模式状态、5G/NR 无线技术

UI 内部通过 `fetch('/api')` 获取数据，并将响应的响应头捕获后展示在"Response Headers"（响应头）区域中。

---

## 项目结构

```
src/index.ts              Worker 入口
test/index.test.ts        单元测试
migrations/               主数据库的 D1 迁移文件
migrations-city/          城市数据库的 D1 迁移文件
scripts/                  Python 数据导入工具
wrangler.toml             Worker 配置
wrangler.toml.example     新部署用的配置模板
```

---

## 许可

Worker 代码本身采用 MIT 许可。导入的地理数据集遵循其各自的许可协议（iptoasn 为 PDDL-1.0，DB-IP City Lite 为 CC BY 4.0）。
