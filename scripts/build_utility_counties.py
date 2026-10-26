"""Build the US electric utility -> county CSVs from EIA Form 861.

Source: EIA-861 "Service Territory" + "Sales to Ultimate Customers", as
published (cleaned, with county FIPS codes attached) by the Catalyst
Cooperative PUDL project: https://catalyst.coop/pudl/

Outputs (public/data/), normalized — join them in a transform:
  utilities.csv         one row per utility: EIA id, name, ownership type, short-form filer
  utility_counties.csv  one row per (utility, county): the service-territory links

(Customers / sales / revenue — reported per utility per state — can become a
separate built-in later.)

County polygons are a separate built-in dataset (us-atlas), joined on county_fips.

Usage:  pip install pandas pyarrow && python scripts/build_utility_counties.py [year]
"""

import sys
import urllib.request
from pathlib import Path

import pandas as pd

PUDL = "https://s3.us-west-2.amazonaws.com/pudl.catalyst.coop/stable"
OUT = Path(__file__).resolve().parent.parent / "public" / "data"
CACHE = Path(__file__).resolve().parent / ".cache"

# Retired county FIPS codes still found in EIA-861 → their successors.
COUNTY_SUCCESSORS = {
    "51515": "51019",  # Bedford city, VA → Bedford County (2013)
    "46113": "46102",  # Shannon County, SD → Oglala Lakota County (2015)
    "02270": "02158",  # Wade Hampton, AK → Kusilvak Census Area (2015)
}


def table(name: str) -> pd.DataFrame:
    CACHE.mkdir(exist_ok=True)
    path = CACHE / f"{name}.parquet"
    if not path.exists():
        urllib.request.urlretrieve(f"{PUDL}/{name}.parquet", path)
    df = pd.read_parquet(path)
    df["year"] = pd.to_datetime(df["report_date"]).dt.year
    return df


def main() -> None:
    territory = table("core_eia861__yearly_service_territory")
    sales = table("core_eia861__yearly_sales")
    year = int(sys.argv[1]) if len(sys.argv) > 1 else int(territory["year"].max())
    territory = territory[territory["year"] == year]
    sales = sales[sales["year"] == year]

    entity = (
        sales.dropna(subset=["entity_type"])
        .groupby("utility_id_eia")["entity_type"].agg(lambda s: s.mode().iat[0])
        .rename("entity_type")
    )

    links = (
        territory[["utility_id_eia", "county_id_fips"]]
        .rename(columns={"county_id_fips": "county_fips"})
        .dropna(subset=["county_fips"])
    )
    # Retired county codes still reported → the county that replaced them.
    links["county_fips"] = links["county_fips"].replace(COUNTY_SUCCESSORS)
    links = links.drop_duplicates().sort_values(["county_fips", "utility_id_eia"])

    names = territory.drop_duplicates("utility_id_eia")[["utility_id_eia", "utility_name_eia"]].rename(columns={"utility_name_eia": "utility_name"})
    short = territory.groupby("utility_id_eia")["short_form"].agg(lambda s: bool(s.fillna(False).astype(bool).any())).rename("short_form")
    utilities = (
        names[names["utility_id_eia"].isin(links["utility_id_eia"])]
        .merge(entity, on="utility_id_eia", how="left")
        .merge(short, on="utility_id_eia", how="left")
        .sort_values("utility_name")
    )
    utilities["entity_type"] = utilities["entity_type"].fillna("Unknown")

    OUT.mkdir(parents=True, exist_ok=True)
    utilities.to_csv(OUT / "utilities.csv", index=False)
    links.to_csv(OUT / "utility_counties.csv", index=False)
    print(f"{year}: {utilities.shape[0]} utilities, {links.shape[0]} utility-county links, "
          f"{links['county_fips'].nunique()} counties")


if __name__ == "__main__":
    main()
