from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import Any, Dict, Optional
import uvicorn
import traceback
import resource
import sys
from engine import BacktestEngine, fetch_stitched_data, get_month_expiries

app = FastAPI(title="Strategy Builder Backtest Engine")

cancelled_jobs = set()

def check_memory_and_clear_cache(threshold_mb=600):
    """Clears LRU cache only if process memory exceeds threshold_mb to prevent OOM."""
    try:
        usage = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        max_mb = usage / (1024 * 1024) if sys.platform == 'darwin' else usage / 1024
        if max_mb > threshold_mb:
            print(f"[Python] Memory usage ({max_mb:.1f} MB) exceeded threshold ({threshold_mb} MB). Clearing cache.")
            fetch_stitched_data.cache_clear()
            get_month_expiries.cache_clear()
    except Exception:
        pass

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

@app.post("/cache/clear")
def clear_cache():
    fetch_stitched_data.cache_clear()
    get_month_expiries.cache_clear()
    return {"success": True, "message": "Backtest data cache cleared"}

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
        # Protect memory by clearing only if memory usage exceeds threshold
        check_memory_and_clear_cache(threshold_mb=600)

if __name__ == "__main__":
    uvicorn.run("server:app", host="0.0.0.0", port=8000, reload=True)
