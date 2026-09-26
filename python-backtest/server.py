from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import Any, Dict
import uvicorn
import traceback
from engine import BacktestEngine, fetch_stitched_data

app = FastAPI(title="Strategy Builder Backtest Engine")

class BacktestRequest(BaseModel):
    strategy: Dict[str, Any]
    fromDate: str
    toDate: str

@app.post("/backtest")
def run_backtest(req: BacktestRequest):
    try:
        engine = BacktestEngine(req.strategy, req.fromDate, req.toDate)
        engine.run()
        return engine.results
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        # Clear cached parquet DataFrames to prevent OOM on long backtests.
        # The cache helps within a single backtest (reusing data across legs),
        # but accumulating across requests fills RAM on small droplets.
        fetch_stitched_data.cache_clear()

if __name__ == "__main__":
    uvicorn.run("server:app", host="0.0.0.0", port=8000, reload=True)
