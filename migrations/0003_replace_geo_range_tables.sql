DROP TABLE IF EXISTS ip_geo_ranges;
DROP TABLE IF EXISTS ip_city_ranges;
DROP TABLE IF EXISTS ip_asn_ranges;
DROP TABLE IF EXISTS ip_country_ranges;

CREATE TABLE IF NOT EXISTS ip_city_ranges (
  ip_version INTEGER NOT NULL CHECK (ip_version IN (4, 6)),
  start_hex TEXT NOT NULL,
  end_hex TEXT NOT NULL,
  continent_code TEXT,
  country_code TEXT,
  region TEXT,
  city TEXT,
  latitude REAL,
  longitude REAL,
  source TEXT NOT NULL DEFAULT 'custom',
  PRIMARY KEY (ip_version, start_hex, end_hex)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS ip_asn_ranges (
  ip_version INTEGER NOT NULL CHECK (ip_version IN (4, 6)),
  start_hex TEXT NOT NULL,
  end_hex TEXT NOT NULL,
  asn INTEGER,
  as_organization TEXT,
  source TEXT NOT NULL DEFAULT 'custom',
  PRIMARY KEY (ip_version, start_hex, end_hex)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS ip_country_ranges (
  ip_version INTEGER NOT NULL CHECK (ip_version IN (4, 6)),
  start_hex TEXT NOT NULL,
  end_hex TEXT NOT NULL,
  country_code TEXT,
  source TEXT NOT NULL DEFAULT 'custom',
  PRIMARY KEY (ip_version, start_hex, end_hex)
) WITHOUT ROWID;
