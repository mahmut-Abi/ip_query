CREATE TABLE IF NOT EXISTS ip_geo_ranges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip_version INTEGER NOT NULL CHECK (ip_version IN (4, 6)),
  start_hex TEXT NOT NULL,
  end_hex TEXT NOT NULL,
  country_code TEXT,
  country_name TEXT,
  region TEXT,
  city TEXT,
  latitude REAL,
  longitude REAL,
  timezone TEXT,
  asn INTEGER,
  as_organization TEXT,
  source TEXT NOT NULL DEFAULT 'custom',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (ip_version, start_hex, end_hex, source)
);

CREATE INDEX IF NOT EXISTS idx_ip_geo_ranges_lookup
  ON ip_geo_ranges (ip_version, start_hex, end_hex);
