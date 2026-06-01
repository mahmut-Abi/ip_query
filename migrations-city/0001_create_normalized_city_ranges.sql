DROP TABLE IF EXISTS ip_city_v4_ranges;
DROP TABLE IF EXISTS ip_city_v6_ranges;
DROP TABLE IF EXISTS ip_city_locations;

CREATE TABLE IF NOT EXISTS ip_city_locations (
  id INTEGER PRIMARY KEY,
  continent_code TEXT,
  country_code TEXT,
  region TEXT,
  city TEXT,
  latitude REAL,
  longitude REAL,
  UNIQUE (continent_code, country_code, region, city, latitude, longitude)
);

CREATE TABLE IF NOT EXISTS ip_city_v4_ranges (
  start_hex TEXT NOT NULL,
  end_hex TEXT NOT NULL,
  location_id INTEGER NOT NULL,
  PRIMARY KEY (start_hex, end_hex)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS ip_city_v6_ranges (
  start_hex TEXT NOT NULL,
  end_hex TEXT NOT NULL,
  location_id INTEGER NOT NULL,
  PRIMARY KEY (start_hex, end_hex)
) WITHOUT ROWID;
