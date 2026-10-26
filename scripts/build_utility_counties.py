"""Build the US electric utility -> county CSVs from EIA Form 861.

Source: EIA-861 "Service Territory" + "Sales to Ultimate Customers", as
published (cleaned, with county FIPS codes attached) by the Catalyst
Cooperative PUDL project: https://catalyst.coop/pudl/

Outputs (public/data/), normalized — join them in a transform:
  utilities.csv         one row per utility: EIA id, name, ownership type, business totals
  utility_counties.csv  one row per (utility, county): the service-territory links

EIA reports customers / sales / revenue per utility per state, never per
county; utilities.csv carries each utility's totals across its states.

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

    # Per utility+state figures. Customers are counted on the wires side
    # (bundled + delivery) and energy on the supply side (bundled + energy),
    # so choice-state customers aren't counted twice.
    wires = sales[sales["service_type"].isin(["bundled", "delivery"])]
    supply = sales[sales["service_type"].isin(["bundled", "energy"])]
    keys = ["utility_id_eia", "state"]
    by_state = (
        wires.groupby(keys)["customers"].sum(min_count=1).rename("state_customers").to_frame()
        .join(supply.groupby(keys)["sales_mwh"].sum(min_count=1).rename("state_sales_mwh"), how="outer")
        .join(sales.groupby(keys)["sales_revenue"].sum(min_count=1).rename("state_revenue_usd"), how="outer")
        .reset_index()
    )
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
    totals = (
        by_state.groupby("utility_id_eia")[["state_customers", "state_sales_mwh", "state_revenue_usd"]]
        .sum(min_count=1)
        .rename(columns=lambda c: c.replace("state_", ""))
    )
    utilities = (
        names[names["utility_id_eia"].isin(links["utility_id_eia"])]
        .merge(entity, on="utility_id_eia", how="left")
        .merge(totals, on="utility_id_eia", how="left")
        .merge(short, on="utility_id_eia", how="left")
        .sort_values("utility_name")
    )
    utilities["entity_type"] = utilities["entity_type"].fillna("Unknown")
    utilities["customers"] = utilities["customers"].astype("Int64")
    utilities["report_year"] = year

    OUT.mkdir(parents=True, exist_ok=True)
    utilities.to_csv(OUT / "utilities.csv", index=False, float_format="%.0f")
    links.to_csv(OUT / "utility_counties.csv", index=False)
    print(f"{year}: {utilities.shape[0]} utilities, {links.shape[0]} utility-county links, "
          f"{links['county_fips'].nunique()} counties")


if __name__ == "__main__":
    main()
