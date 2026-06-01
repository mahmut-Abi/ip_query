#!/usr/bin/env python3
import argparse
import csv
import gzip
import ipaddress
from pathlib import Path
from typing import Iterable


LOCATION_COLUMNS = [
    "id",
    "continent_code",
    "country_code",
    "region",
    "city",
    "latitude",
    "longitude",
]

RANGE_COLUMNS = ["start_hex", "end_hex", "location_id"]


class ChunkWriter:
    def __init__(self, directory: Path, prefix: str, table: str, columns: list[str], chunk_size: int):
        self.directory = directory
        self.prefix = prefix
        self.table = table
        self.columns = columns
        self.chunk_size = chunk_size
        self.file_index = 0
        self.row_count = 0
        self.current_count = 0
        self.current_file = None
        self.directory.mkdir(parents=True, exist_ok=True)

    def write(self, values: Iterable[object]) -> None:
        if self.current_file is None or self.current_count >= self.chunk_size:
            self.close()
            path = self.directory / f"{self.prefix}{self.file_index:04d}.sql"
            self.current_file = path.open("w", encoding="utf-8", newline="\n")
            self.file_index += 1
            self.current_count = 0

        columns = ", ".join(self.columns)
        rendered_values = ", ".join(sql_value(value) for value in values)
        self.current_file.write(
            f"INSERT OR REPLACE INTO {self.table} ({columns}) VALUES ({rendered_values});\n"
        )
        self.current_count += 1
        self.row_count += 1

    def close(self) -> None:
        if self.current_file is not None:
            self.current_file.close()
            self.current_file = None


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Convert DB-IP City Lite CSV rows into normalized D1 SQL chunks."
    )
    parser.add_argument("input_csv", type=Path, help="DB-IP City Lite CSV or csv.gz file.")
    parser.add_argument("output_dir", type=Path, help="Directory for generated SQL chunks.")
    parser.add_argument(
        "--location-chunk-size",
        type=int,
        default=50000,
        help="Rows per generated location SQL chunk.",
    )
    parser.add_argument(
        "--range-chunk-size",
        type=int,
        default=100000,
        help="Rows per generated range SQL chunk.",
    )
    parser.add_argument(
        "--include-unknown",
        action="store_true",
        help="Keep rows where continent or country code is ZZ. Unknown rows are skipped by default.",
    )
    args = parser.parse_args()

    counts = convert_dbip_city(
        args.input_csv,
        args.output_dir,
        args.location_chunk_size,
        args.range_chunk_size,
        not args.include_unknown,
    )
    print(
        "Wrote "
        f"{counts['locations']} locations, "
        f"{counts['v4']} IPv4 ranges, "
        f"{counts['v6']} IPv6 ranges to {args.output_dir}"
    )


def convert_dbip_city(
    input_csv: Path,
    output_dir: Path,
    location_chunk_size: int,
    range_chunk_size: int,
    skip_unknown: bool,
) -> dict[str, int]:
    location_writer = ChunkWriter(
        output_dir / "locations",
        "dbip-city-locations-",
        "ip_city_locations",
        LOCATION_COLUMNS,
        location_chunk_size,
    )
    v4_writer = ChunkWriter(
        output_dir / "v4",
        "dbip-city-v4-",
        "ip_city_v4_ranges",
        RANGE_COLUMNS,
        range_chunk_size,
    )
    v6_writer = ChunkWriter(
        output_dir / "v6",
        "dbip-city-v6-",
        "ip_city_v6_ranges",
        RANGE_COLUMNS,
        range_chunk_size,
    )

    location_ids: dict[tuple[object, ...], int] = {}
    next_location_id = 1

    try:
        with open_text(input_csv) as source_file:
            reader = csv.reader(source_file)
            for row in reader:
                if len(row) < 8:
                    continue

                continent_code = clean_text(row[2])
                country_code = clean_text(row[3])
                if skip_unknown and (continent_code == "ZZ" or country_code == "ZZ"):
                    continue

                start_ip = ipaddress.ip_address(row[0].strip())
                end_ip = ipaddress.ip_address(row[1].strip())
                if start_ip.version != end_ip.version:
                    raise SystemExit(f"IP version mismatch: {start_ip} - {end_ip}")

                location = (
                    continent_code,
                    country_code,
                    clean_text(row[4]),
                    clean_text(row[5]),
                    clean_number(row[6]),
                    clean_number(row[7]),
                )
                location_id = location_ids.get(location)
                if location_id is None:
                    location_id = next_location_id
                    next_location_id += 1
                    location_ids[location] = location_id
                    location_writer.write((location_id, *location))

                values = (ip_to_hex(start_ip), ip_to_hex(end_ip), location_id)
                if start_ip.version == 4:
                    v4_writer.write(values)
                else:
                    v6_writer.write(values)
    finally:
        location_writer.close()
        v4_writer.close()
        v6_writer.close()

    return {
        "locations": location_writer.row_count,
        "v4": v4_writer.row_count,
        "v6": v6_writer.row_count,
    }


def open_text(path: Path):
    if path.suffix == ".gz":
        return gzip.open(path, "rt", encoding="utf-8-sig", newline="")
    return path.open("r", encoding="utf-8-sig", newline="")


def ip_to_hex(ip: ipaddress._BaseAddress) -> str:
    width = 8 if ip.version == 4 else 32
    return f"{int(ip):0{width}x}"


def clean_text(value: str) -> str | None:
    stripped = value.strip().strip('"')
    return stripped if stripped else None


def clean_number(value: str) -> float | None:
    stripped = value.strip()
    return float(stripped) if stripped else None


def sql_value(value: object) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, (int, float)):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


if __name__ == "__main__":
    main()
