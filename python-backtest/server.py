from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import Any, Dict, Optional
import uvicorn
import traceback
from engine import BacktestEngine, fetch_stitched_data

app = FastAPI(title="Strategy Builder Backtest Engine")

cancelled_jobs = set()

class BacktestRequest(BaseModel):
    strategy: Dict[str, Any]
    fromDate: str
    toDate: str
    jobId: Optional[str] = None

@app.post("/cancel/{job_id}")
def cancel_job(job_id: str):
    cancelled_jobs.add(job_id)
    print(f"[Python] Job {job_id} marked as cancelled.")
    return {"success": True, "message": f"Job {job_id} cancelled"}

@app.post("/backtest")
def run_backtest(req: BacktestRequest):
    job_id = req.jobId
    if job_id and job_id in cancelled_jobs:
        cancelled_jobs.discard(job_id)
        raise HTTPException(status_code=499, detail="Backtest cancelled by user")

    def is_cancelled():
        return job_id is not None and job_id in cancelled_jobs

    try:
        engine = BacktestEngine(req.strategy, req.fromDate, req.toDate, is_cancelled=is_cancelled)
        engine.run()
        if is_cancelled():
            raise HTTPException(status_code=499, detail="Backtest cancelled by user")
        return engine.results
    except HTTPException:
        raise
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if job_id:
            cancelled_jobs.discard(job_id)
        # Clear cached parquet DataFrames to prevent OOM on long backtests.
        # The cache helps within a single backtest (reusing data across legs),
        # but accumulating across requests fills RAM on small droplets.
        fetch_stitched_data.cache_clear()

if __name__ == "__main__":
    uvicorn.run("server:app", host="0.0.0.0", port=8000, reload=True)
