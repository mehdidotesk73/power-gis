"""Build the US electric utility -> county CSVs from EIA Form 861.

Source: EIA-861 "Service Territory" + "Sales to Ultimate Customers", as
published (cleaned, with county FIPS codes attached) by the Catalyst
Cooperative PUDL project: https://catalyst.coop/pudl/

Outputs (public/data/):
  utility_counties.csv  one row per (utility, state, county) — the map layer
  utilities.csv         one row per utility — the utility list

Usage:  pip install pandas pyarrow && python scripts/build_utility_counties.py [year]
"""

import sys
import urllib.request
from pathlib import Path

import pandas as pd

PUDL = "https://s3.us-west-2.amazonaws.com/pudl.catalyst.coop/stable"
OUT = Path(__file__).resolve().parent.parent / "public" / "data"
CACHE = Path(__file__).resolve().parent / ".cache"


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

    rows = (
        territory[["utility_id_eia", "utility_name_eia", "state", "county", "county_id_fips", "short_form"]]
        .drop_duplicates(subset=["utility_id_eia", "county_id_fips"])
        .merge(entity, on="utility_id_eia", how="left")
        .merge(by_state, on=keys, how="left")
        .rename(columns={"utility_name_eia": "utility_name", "county_id_fips": "county_fips"})
    )
    rows["entity_type"] = rows["entity_type"].fillna("Unknown")
    rows["short_form"] = rows["short_form"].fillna(False).astype(bool)
    rows["report_year"] = year
    n_counties = rows.groupby(keys)["county_fips"].transform("nunique")
    rows["counties_in_state"] = n_counties
    rows = rows.sort_values(["county_fips", "utility_name"])[
        [
            "utility_id_eia", "utility_name", "entity_type", "state", "county", "county_fips",
            "counties_in_state", "state_customers", "state_sales_mwh", "state_revenue_usd",
            "short_form", "report_year",
        ]
    ]

    utilities = (
        rows.groupby(["utility_id_eia", "utility_name", "entity_type"])
        .agg(
            states=("state", lambda s: ";".join(sorted(set(s)))),
            county_count=("county_fips", "nunique"),
        )
        .reset_index()
        .merge(
            by_state.groupby("utility_id_eia")[["state_customers", "state_sales_mwh", "state_revenue_usd"]]
            .sum(min_count=1)
            .rename(columns=lambda c: c.replace("state_", "total_")),
            on="utility_id_eia",
            how="left",
        )
        .sort_values("utility_name")
    )
    utilities["report_year"] = year

    OUT.mkdir(parents=True, exist_ok=True)
    int_cols = ["state_customers", "total_customers"]
    for df in (rows, utilities):
        for c in int_cols:
            if c in df:
                df[c] = df[c].astype("Int64")
    rows.to_csv(OUT / "utility_counties.csv", index=False, float_format="%.0f")
    utilities.to_csv(OUT / "utilities.csv", index=False, float_format="%.0f")
    print(f"{year}: {utilities.shape[0]} utilities, {rows.shape[0]} utility-county rows, "
          f"{rows['county_fips'].nunique()} counties")


if __name__ == "__main__":
    main()
