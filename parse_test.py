import polars as pl
import sys
df = pl.read_parquet('/Users/komalkumari/Developer/strategy-builder/market-data/index/SENSEX/2026/05/2026-05-04.parquet')
print("INDEX COLS:", df.columns)
print("INDEX ROW 0:", df.head(1))

df2 = pl.read_parquet('/Users/komalkumari/Developer/strategy-builder/market-data/options/SENSEX/2026/05/expiry=2026-05-08/date=2026-05-04/72000_PE.parquet')
print("OPTION COLS:", df2.columns)
print("OPTION ROW 0:", df2.head(1))
