#!/usr/bin/env python3
import argparse
import csv
import gzip
import ipaddress
from pathlib import Path
from typing import Optional


GEO_COLUMNS = [
    "ip_version",
    "start_hex",
    "end_hex",
    "country_code",
    "country_name",
    "region",
    "city",
    "latitude",
    "longitude",
    "timezone",
    "asn",
    "as_organization",
    "source",
]

CITY_COLUMNS = [
    "ip_version",
    "start_hex",
    "end_hex",
    "continent_code",
    "country_code",
    "region",
    "city",
    "latitude",
    "longitude",
    "source",
]

ASN_COLUMNS = [
    "ip_version",
    "start_hex",
    "end_hex",
    "asn",
    "as_organization",
    "source",
]

COUNTRY_COLUMNS = [
    "ip_version",
    "start_hex",
    "end_hex",
    "country_code",
    "source",
]


ALIASES = {
    "start": ["start_ip", "ip_range_start", "ip_from", "from", "start"],
    "end": ["end_ip", "ip_range_end", "ip_to", "to", "end"],
    "cidr": ["cidr", "network", "network_cidr"],
    "country_code": ["country_code", "country", "country_short", "iso_code"],
    "country_name": ["country_name", "country_long", "country_full_name"],
    "continent_code": ["continent_code", "continent"],
    "region": ["region", "region_name", "subdivision", "subdivision_name"],
    "city": ["city", "city_name"],
    "latitude": ["latitude", "lat"],
    "longitude": ["longitude", "lon", "lng"],
    "timezone": ["timezone", "time_zone"],
    "asn": ["asn", "autonomous_system_number"],
    "as_organization": ["as_organization", "as_name", "autonomous_system_organization", "isp"],
}


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Convert normalized IP geo CSV rows into D1 SQL inserts."
    )
    parser.add_argument("input_csv", type=Path, help="CSV file with start/end IP or CIDR columns.")
    parser.add_argument("output_sql", type=Path, help="SQL file to write.")
    parser.add_argument(
        "--source",
        default="csv",
        help="Source label stored in ip_geo_ranges.source when the CSV has no source column.",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=0,
        help="Optional maximum number of rows to convert; 0 means all rows.",
    )
    parser.add_argument(
        "--columns",
        default="",
        help="Comma-separated column names for headerless CSV files, for example start_ip,end_ip,country_code.",
    )
    parser.add_argument(
        "--no-transaction",
        action="store_true",
        help="Do not wrap output in BEGIN/COMMIT. Use this for Wrangler remote D1 imports.",
    )
    parser.add_argument(
        "--target",
        choices=["geo", "city", "asn", "country"],
        default="geo",
        help="Output table shape. Use city/asn/country for the compact production schema.",
    )
    parser.add_argument(
        "--ip-version",
        choices=["4", "6", "all"],
        default="all",
        help="Only emit rows for a specific IP version.",
    )
    parser.add_argument(
        "--skip-unknown",
        action="store_true",
        help="Skip rows where country or continent is ZZ.",
    )
    args = parser.parse_args()

    written = convert_csv(
        args.input_csv,
        args.output_sql,
        args.source,
        args.limit,
        args.columns,
        not args.no_transaction,
        args.target,
        args.ip_version,
        args.skip_unknown,
    )
    print(f"Wrote {written} rows to {args.output_sql}")


def convert_csv(
    input_csv: Path,
    output_sql: Path,
    default_source: str,
    limit: int,
    columns: str = "",
    wrap_transaction: bool = True,
    target: str = "geo",
    ip_version: str = "all",
    skip_unknown: bool = False,
) -> int:
    with open_text(input_csv) as source_file:
        column_names = parse_columns(columns)
        reader = csv.DictReader(source_file, fieldnames=column_names if column_names else None)
        if not reader.fieldnames:
            raise SystemExit("CSV must contain a header row.")

        normalized_fields = {field.lower().strip(): field for field in reader.fieldnames}
        output_sql.parent.mkdir(parents=True, exist_ok=True)

        count = 0
        with output_sql.open("w", encoding="utf-8", newline="\n") as output_file:
            if wrap_transaction:
                output_file.write("BEGIN TRANSACTION;\n")
            for row in reader:
                if limit and count >= limit:
                    break

                converted = convert_row(row, normalized_fields, default_source, ip_version, skip_unknown)
                if converted is None:
                    continue

                output_file.write(render_insert(converted, target))
                count += 1
            if wrap_transaction:
                output_file.write("COMMIT;\n")

    return count


def open_text(path: Path):
    if path.suffix == ".gz":
        return gzip.open(path, "rt", encoding="utf-8-sig", newline="")
    return path.open("r", encoding="utf-8-sig", newline="")


def parse_columns(columns: str) -> Optional[list[str]]:
    if columns.strip() == "":
        return None
    parsed = [column.strip() for column in columns.split(",") if column.strip()]
    if not parsed:
        raise SystemExit("--columns must contain at least one column name.")
    return parsed


def convert_row(
    row: dict[str, str],
    normalized_fields: dict[str, str],
    default_source: str,
    ip_version_filter: str,
    skip_unknown: bool,
) -> Optional[dict[str, object]]:
    cidr = value_for(row, normalized_fields, ALIASES["cidr"])
    if cidr:
        network = ipaddress.ip_network(cidr.strip(), strict=False)
        start_ip = network.network_address
        end_ip = network.broadcast_address
    else:
        start_raw = value_for(row, normalized_fields, ALIASES["start"])
        end_raw = value_for(row, normalized_fields, ALIASES["end"])
        if not start_raw or not end_raw:
            return None
        start_ip = parse_ip_value(start_raw)
        end_ip = parse_ip_value(end_raw)

    if start_ip.version != end_ip.version:
        raise SystemExit(f"IP version mismatch: {start_ip} - {end_ip}")

    if ip_version_filter != "all" and str(start_ip.version) != ip_version_filter:
        return None

    if int(start_ip) > int(end_ip):
        raise SystemExit(f"Range start is greater than end: {start_ip} - {end_ip}")

    continent_code = clean_text(value_for(row, normalized_fields, ALIASES["continent_code"]))
    country_code = clean_text(value_for(row, normalized_fields, ALIASES["country_code"]))
    if skip_unknown and (country_code == "ZZ" or continent_code == "ZZ"):
        return None

    return {
        "ip_version": start_ip.version,
        "start_hex": ip_to_hex(start_ip),
        "end_hex": ip_to_hex(end_ip),
        "country_code": country_code,
        "country_name": clean_text(value_for(row, normalized_fields, ALIASES["country_name"])),
        "continent_code": continent_code,
        "region": clean_text(value_for(row, normalized_fields, ALIASES["region"])),
        "city": clean_text(value_for(row, normalized_fields, ALIASES["city"])),
        "latitude": clean_number(value_for(row, normalized_fields, ALIASES["latitude"])),
        "longitude": clean_number(value_for(row, normalized_fields, ALIASES["longitude"])),
        "timezone": clean_text(value_for(row, normalized_fields, ALIASES["timezone"])),
        "asn": clean_int(value_for(row, normalized_fields, ALIASES["asn"])),
        "as_organization": clean_text(value_for(row, normalized_fields, ALIASES["as_organization"])),
        "source": clean_text(row.get("source")) or default_source,
    }


def value_for(row: dict[str, str], normalized_fields: dict[str, str], aliases: list[str]) -> Optional[str]:
    for alias in aliases:
        original_field = normalized_fields.get(alias)
        if original_field is not None:
            value = row.get(original_field)
            if value is not None and value.strip() != "":
                return value.strip()
    return None


def parse_ip_value(value: str) -> ipaddress._BaseAddress:
    stripped = value.strip().strip('"')
    if stripped.isdigit():
        return ipaddress.ip_address(int(stripped))
    return ipaddress.ip_address(stripped)


def ip_to_hex(ip: ipaddress._BaseAddress) -> str:
    width = 8 if ip.version == 4 else 32
    return f"{int(ip):0{width}x}"


def clean_text(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    stripped = value.strip().strip('"')
    if stripped == "" or stripped == "-":
        return None
    return stripped


def clean_number(value: Optional[str]) -> Optional[float]:
    text = clean_text(value)
    if text is None:
        return None
    return float(text)


def clean_int(value: Optional[str]) -> Optional[int]:
    text = clean_text(value)
    if text is None:
        return None
    return int(text)


def render_insert(row: dict[str, object], target: str) -> str:
    if target == "geo":
        table = "ip_geo_ranges"
        columns = GEO_COLUMNS
    elif target == "city":
        table = "ip_city_ranges"
        columns = CITY_COLUMNS
    elif target == "asn":
        table = "ip_asn_ranges"
        columns = ASN_COLUMNS
    elif target == "country":
        table = "ip_country_ranges"
        columns = COUNTRY_COLUMNS
    else:
        raise SystemExit(f"Unsupported target: {target}")

    values = ", ".join(sql_value(row[column]) for column in columns)
    joined_columns = ", ".join(columns)
    return f"INSERT OR REPLACE INTO {table} ({joined_columns}) VALUES ({values});\n"


def sql_value(value: object) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, (int, float)):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


if __name__ == "__main__":
    main()
