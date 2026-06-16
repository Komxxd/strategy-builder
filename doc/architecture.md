# Architecture Overview

This document is designed to give you a comprehensive understanding of the system's architecture. It covers the services, modules, the core trade lifecycle, client-server communication, and data storage.

---

## What Problems Does This System Solve?

The platform allows traders to:
- Configure multi-leg option strategies.
- Run live automated execution.
- Manage stop losses and trailing stops.
- Execute re-entry logic automatically.
- Backtest strategies against historical data.

---

## Technology Stack

**Frontend**
- React
- Socket.IO Client

**Backend**
- Node.js
- Express

**Database**
- PostgreSQL (Supabase)

**Caching / Queue**
- Redis
- BullMQ

**Broker**
- Angel One SmartAPI

**Realtime**
- WebSockets
- Socket.IO

---

## 1. What Services Exist?

The backend is composed of several independent but cooperating services:

- **Main API Server (Express):** The entry point for the frontend. Handles authentication, routing, rate limiting, and CRUD operations for strategies and market data.
- **Market WebSocket Service (`marketSocket.service.js`):** Integrates directly with the broker (Angel One via `smartapi-javascript`). It manages the persistent WebSocket connection to receive real-time market ticks (LTP).
- **Trading Engine:** The core execution system that evaluates strategies tick-by-tick. It is composed of multiple sub-modules (detailed below).
- **Backtest Service (`backtest-server.js` & `backtestWorker.js`):** A separate worker process using BullMQ and Redis. It processes historical data asynchronously to simulate trades without blocking the main Node.js event loop.

---

## 2. What Modules Exist?

The core trading logic is modularized inside `server/src/services/trading/`:

- **Engine (`strategy.engine.js`):** The orchestrator. It manages a 1-second interval loop for every active strategy, deciding when to enter, monitor, or stop.
- **State (`strategy.state.js`):** In-memory storage. Holds `activeStrategies` and the `globalLtpMap`. It acts as a buffer, syncing state to the database every 5 seconds.
- **Monitor (`strategy.monitor.js`):** Evaluates open positions. It continuously checks the latest LTP against Stop Loss (SL), Targets (MTP), and Trailing Stop Loss (TSL).
- **Lifecycle (`strategy.lifecycle.js`):** Handles what happens *after* an exit. If a leg hits its Stop Loss, this module decides if Re-Entry logic (e.g., RE-COST, RE-SL, RE-HIGH) should be triggered.
- **Execution (`strategy.execution.js`):** Interacts with the broker's API to place actual Buy/Sell orders and Stop-Loss orders.
- **Instruments (`strategy.instruments.js`):** Maps human-readable symbols (e.g., `NIFTY24DEC21000CE`) to broker-specific token IDs required for execution.

---

## 3. How Does a Trade Flow Through the System? (Trade Lifecycle)

Understanding the lifecycle of a single market tick until it becomes an executed order is the key to understanding this platform.

1. **Tick Reception:** 
   The broker WebSocket pushes a live `tick` event to our system.
2. **State Update:** 
   `marketSocket.service.js` extracts the Last Traded Price (LTP) and token, immediately calling `updateLtp()` in `strategy.state.js`. This updates the `globalLtpMap` in memory (sub-millisecond latency).
3. **The Engine Loop:** 
   Every 1 second, `strategy.engine.js` iterates over all active strategies.
4. **Monitoring & Evaluation:** 
   If a strategy is `IN_POSITION`, the Engine delegates to `strategy.monitor.js`. The Monitor calculates real-time PnL using the freshly updated `globalLtpMap`.
5. **Exit Trigger:** 
   If the LTP crosses a defined Stop Loss or Target threshold, the Monitor calls `strategy.execution.js` to place a live exit order with the broker.
6. **Post-Exit Processing:** 
   Once the order is filled, `strategy.lifecycle.js` (`handleLegStopOut`) takes over. It marks the leg as `COMPLETED`. If the user configured Re-Entry rules (e.g., Re-Enter at Cost), it sets up a new pending leg waiting for that price.
7. **Persistence:** 
   To avoid locking the database during rapid ticks, `strategy.state.js` batches the updated strategy state and flushes it to PostgreSQL every 5 seconds.

---

## 4. How Does the Client Talk to the Server?

The system uses a hybrid communication model to balance persistence and real-time performance:

- **REST APIs (HTTP):** Used for standard, non-streaming operations such as logging in (`/api/auth`), saving a strategy configuration (`/api/strategy`), or fetching historical executions.
- **Socket.IO (WebSocket):** Used for bidirectional real-time data. 
  - **Server -> Client:** Pushes live prices (`ltp_update`), execution logs (`strategy_log`), and broker connectivity status (`broker_status`).
  - *Why Socket.IO?* Polling a REST API for live LTPs would overwhelm the server and introduce unacceptable latency for a trading application.

---

## 5. Where is Data Stored?

Data is distributed across different layers depending on access speed requirements:

- **In-Memory (Node.js Heap):** 
  - `activeStrategies`: The live state of all running strategies.
  - `globalLtpMap`: The absolute latest price for every subscribed token. 
  - *Purpose:* Enables the Trading Engine to evaluate conditions tick-by-tick without database I/O latency.
- **PostgreSQL (Supabase):** 
  - The permanent source of truth. Stores user accounts, strategy templates, execution history, and final PnL.
  - *Mechanism:* The in-memory state is flushed to Postgres via the `postgres` npm module (and sometimes Prisma) every 5 seconds (`runGlobalDbWriter`).
- **Redis (`ioredis`):** 
  - Acts as the message broker and state store for BullMQ. Used primarily to offload heavy Backtesting jobs to background workers.
- **Local Filesystem:** 
  - `data/instruments.json`: A massive JSON file downloaded daily containing the mapping of all available broker tokens. Stored locally to avoid hammering the broker's API on every lookup.

---

## Critical Failure Points

### Broker WebSocket Disconnect
**Impact:**
- LTP updates stop.
- Strategies continue using stale prices.

**Recovery:**
- Auto reconnect logic attempts to restore connection with exponential backoff.
- Operator must be alerted if reconnect fails and max attempts are reached (requires manual re-login).

### PostgreSQL Unavailable
**Impact:**
- Strategies continue running in-memory.
- State persistence fails, causing potential data loss if the server crashes before DB recovers.

**Recovery:**
- `withDbRetry` wrapper retries queries.
- Periodic DB writer (`runGlobalDbWriter`) buffers updates in memory and retries writing them on the next 5-second cycle.

---

## Startup Sequence

1. Express server starts.
2. PostgreSQL connection established.
3. Redis connection established (for Backtesting Queue).
4. Instrument file loaded (downloads if missing or stale).
5. Broker authenticated (on manual user login).
6. Market WebSocket connected (on manual user login).
7. Active strategies loaded from DB and restored into memory (`initializeActiveStrategies`).
8. Trading Engine loops started for active strategies.

---

## Shutdown Sequence

1. PM2 sends `SIGTERM` / User hits `Ctrl+C`.
2. Stop accepting new HTTP connections.
3. Flush pending DB writes (`pendingDbUpdates`) to Supabase.
4. Close broker WebSocket connections cleanly.
5. Exit process.

---

## Operational Rules

- Never deploy directly to production.
- Production tracks `main` branch.
- Staging tracks `develop` branch.
- All new strategies must be tested in backtest mode before live deployment.
- Production releases must be tagged.
