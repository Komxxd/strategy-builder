from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import Any, Dict
import uvicorn
import traceback
from engine import BacktestEngine

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

if __name__ == "__main__":
    uvicorn.run("server:app", host="0.0.0.0", port=8000, reload=True)
