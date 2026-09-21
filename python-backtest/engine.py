import sys
import json
import os
from datetime import datetime, timedelta

# Limit Polars threads to prevent CPU oversubscription during high concurrency
os.environ["POLARS_MAX_THREADS"] = "2"
import polars as pl
import math

MARKET_DATA_DIR = os.path.join(os.path.dirname(__file__), '../market-data')
MARKET_DATA_1S_DIR = os.path.join(os.path.dirname(__file__), '../market-data-1-sec')

import functools

@functools.lru_cache(maxsize=8192)
def fetch_stitched_data(data_type, index_name, year, month, date, expiry=None, strike=None, option_type=None, requires_1s_data=False):
    if data_type == 'index':
        min_path = os.path.join(MARKET_DATA_DIR, 'index', index_name, year, month, f"{date}.parquet")
        sec_path = os.path.join(MARKET_DATA_1S_DIR, 'index', index_name, year, month, f"{date}.parquet")
    else:
        min_path = os.path.join(MARKET_DATA_DIR, 'options', index_name, year, month, f"expiry={expiry}", f"date={date}", f"{strike}_{option_type}.parquet")
        sec_path = os.path.join(MARKET_DATA_1S_DIR, 'options', index_name, year, month, f"expiry={expiry}", f"date={date}", f"{strike}_{option_type}.parquet")
        
    if not os.path.exists(min_path):
        return None
        
    try:
        min_df = pl.read_parquet(min_path)
    except Exception:
        return None
        
    if not requires_1s_data or not os.path.exists(sec_path):
        return min_df
        
    try:
        sec_df = pl.read_parquet(sec_path)
        
        time_col = min_df.columns[1] if data_type == 'index' else min_df.columns[13]
        min_df_filtered = min_df.filter(~pl.col(time_col).cast(pl.Utf8).str.contains("09:15:00"))
        
        if sec_df.schema != min_df_filtered.schema:
            for col_name in sec_df.columns:
                if sec_df[col_name].dtype != min_df_filtered[col_name].dtype:
                    sec_df = sec_df.with_columns(pl.col(col_name).cast(min_df_filtered[col_name].dtype))
                    
        return pl.concat([sec_df, min_df_filtered])
    except Exception:
        return min_df

class BacktestEngine:
    def __init__(self, strategy, from_date, to_date):
        self.strategy = strategy
        self.from_date = from_date
        self.to_date = to_date
        
        self.config = strategy.get('config', {})
        self.index_name = self.config.get('index')
        
        entry_time = self.config.get('entry_time', '09:15:00')
        if entry_time and len(entry_time) == 5: entry_time += ':00'
        if not entry_time: entry_time = '09:15:00'
        self.entry_time = entry_time
        
        exit_time = self.config.get('exit_time', '15:15:00')
        if exit_time and len(exit_time) == 5: exit_time += ':00'
        if not exit_time: exit_time = '15:15:00'
        self.exit_time = exit_time
        
        self.requires_1s_data = (self.entry_time == '09:15:00')
        
        self.results = {
            'trades': [],
            'dailySummary': {},
            'totalPnL': 0,
            'maxDrawdown': 0,
            'winRate': 0,
            'chartData': {}
        }
        
    def generate_date_range(self):
        start = datetime.strptime(self.from_date, "%Y-%m-%d")
        end = datetime.strptime(self.to_date, "%Y-%m-%d")
        dates = []
        curr = start
        while curr <= end:
            dates.append(curr.strftime("%Y-%m-%d"))
            curr += timedelta(days=1)
        return dates

    def fetch_stitched_data(self, data_type, index_name, year, month, date, expiry=None, strike=None, option_type=None):
        return fetch_stitched_data(data_type, index_name, year, month, date, expiry, strike, option_type, self.requires_1s_data)

    def extract_time(self, row):
        if len(row) > 8 and isinstance(row[8], str) and 'T' in row[8]:
            return row[8].split('T')[1][:8]
        if row[1]:
            try:
                return row[1].strftime("%H:%M:%S")
            except:
                pass
        return None

    def extract_time_option(self, row):
        if len(row) > 13 and isinstance(row[13], str) and 'T' in row[13]:
            return row[13].split('T')[1][:8]
        if row[1]:
            try:
                return row[1].strftime("%H:%M:%S")
            except:
                pass
        return None

    def get_strike_step(self, index_name):
        return 100 if index_name == 'SENSEX' else 50

    def calculate_atm(self, spot_price, step):
        return round(spot_price / step) * step

    def get_valid_option_data_with_fallback(self, index_name, year, month, date_str, expiry, initial_strike, option_type, step, required_time=None, max_steps=5, fallback_direction='ALTERNATE'):
        def check_data(strike_to_test):
            df = self.fetch_stitched_data('options', index_name, year, month, date_str, expiry, strike_to_test, option_type)
            if df is not None and df.height > 0:
                # Extract time from datetime column (e.g. '2026-05-04 09:15:00')
                df = df.with_columns(
                    pl.col('datetime').cast(pl.Utf8).str.split(' ').list.last().str.slice(0, 8).alias('time')
                ).sort('time')
                return df
            return None

        # Try initial
        df = check_data(initial_strike)
        if df is not None:
            return {'strike': initial_strike, 'data': df}

        # Fallback loop
        for i in range(1, max_steps + 1):
            if fallback_direction == 'UP':
                strike_up = initial_strike + (i * step)
                df = check_data(strike_up)
                if df is not None: return {'strike': strike_up, 'data': df}
            elif fallback_direction == 'DOWN':
                strike_down = initial_strike - (i * step)
                df = check_data(strike_down)
                if df is not None: return {'strike': strike_down, 'data': df}
            else:
                # ALTERNATE
                strike_up = initial_strike + (i * step)
                df = check_data(strike_up)
                if df is not None: return {'strike': strike_up, 'data': df}

                strike_down = initial_strike - (i * step)
                df = check_data(strike_down)
                if df is not None: return {'strike': strike_down, 'data': df}

        return {'strike': initial_strike, 'data': None}

    def get_option_price_at_time(self, index_name, year, month, expiry, date_str, strike, option_type, time_str):
        res = self.get_valid_option_data_with_fallback(index_name, year, month, date_str, expiry, strike, option_type, 0, max_steps=0)
        df = res['data']
        if df is None or df.height == 0: return None
        
        row = df.filter(pl.col('time') == time_str)
        if row.height > 0:
            return row['open'][0]
        return None

    def calculate_synthetic_future_backtest(self, index_name, year, month, expiry, date_str, spot_price, step, entry_time):
        atm_strike = self.calculate_atm(spot_price, step)
        ce_price = self.get_option_price_at_time(index_name, year, month, expiry, date_str, atm_strike, 'CE', entry_time)
        pe_price = self.get_option_price_at_time(index_name, year, month, expiry, date_str, atm_strike, 'PE', entry_time)

        if ce_price is None or pe_price is None:
            return spot_price # Fallback to spot
            
        sf = spot_price + ce_price - pe_price
        return sf

    def find_closest_premium_strike(self, index_name, year, month, expiry, date_str, atm_strike, step, option_type, target_premium, entry_time):
        fallback_res = self.get_valid_option_data_with_fallback(index_name, year, month, date_str, expiry, atm_strike, option_type, step, entry_time, 5, 'ALTERNATE')
        valid_atm_strike = fallback_res['strike']
        valid_atm_df = fallback_res['data']
        
        current_strike = valid_atm_strike
        current_price = None
        if valid_atm_df is not None and valid_atm_df.height > 0:
            row = valid_atm_df.filter(pl.col('time') == entry_time)
            if row.height == 0:
                row = valid_atm_df.filter(pl.col('time') >= entry_time)
            if row.height > 0:
                current_price = row['open'][0]
                
        if current_price is None: return atm_strike
        
        best_strike = current_strike
        min_diff = abs(current_price - target_premium)
        
        direction = 1
        if current_price > target_premium:
            direction = 1 if option_type == 'CE' else -1
        else:
            direction = -1 if option_type == 'CE' else 1
            
        for _ in range(1, 21):
            next_strike = current_strike + (direction * step)
            next_price = self.get_option_price_at_time(index_name, year, month, expiry, date_str, next_strike, option_type, entry_time)
            
            if next_price is None: break
            
            diff = abs(next_price - target_premium)
            if diff < min_diff:
                min_diff = diff
                best_strike = next_strike
            
            if diff > min_diff: break
            
            current_strike = next_strike
            
        return best_strike

    def find_closest_expiry(self, index_name, date_str):
        year, month = date_str.split('-')[:2]
        month_dir = os.path.join(MARKET_DATA_DIR, 'options', index_name, year, month)
        if not os.path.exists(month_dir): return None
        
        try:
            dirs = os.listdir(month_dir)
            expiries = [d.split('=')[1] for d in dirs if d.startswith('expiry=')]
            expiries = [e for e in expiries if e >= date_str]
            expiries.sort()
            return expiries[0] if expiries else None
        except Exception:
            return None




    def round_to_tick(self, price, tick=0.05):
        if price is None or math.isnan(price): return 0
        return float(max(tick, round(price / tick) * tick))

    def calculate_sl_price(self, leg, entry_price, is_reentry):
        is_sl_enabled = True if (is_reentry and leg.get('reentry_sl_enabled')) else leg.get('sl_enabled') is not False
        active_sl_type = leg.get('reentry_sl_type', 'PERCENTAGE') if (is_reentry and leg.get('reentry_sl_enabled')) else leg.get('sl_type', 'PERCENTAGE')
        active_sl_value = leg.get('reentry_sl_value') if (is_reentry and leg.get('reentry_sl_enabled')) else leg.get('stop_loss')
        
        if is_sl_enabled and active_sl_value is not None and float(active_sl_value) > 0:
            sl_val = float(active_sl_value)
            if active_sl_type == 'POINTS':
                return self.round_to_tick(entry_price - sl_val if leg.get('side') == 'BUY' else entry_price + sl_val)
            else:
                return self.round_to_tick(entry_price * (1 - sl_val / 100) if leg.get('side') == 'BUY' else entry_price * (1 + sl_val / 100))
        return None

    def calculate_trade_vectorized(self, leg, df, config, is_reentry=False, override_entry_price=None):
        if df.height == 0:
            return None, df, 'NO_DATA'
            
        side = leg.get('side', 'SELL')
        mntm_enabled = config.get('simple_mntm_enabled', False) if not is_reentry else False # MNTM on re-entry is handled by MTP check
        entry_time = None
        entry_price = None
        
        if mntm_enabled:
            base_price = df['open'][0]
            m_mode = config.get('simple_mntm_mode', 'SIMPLE_PLUS_PCT')
            m_val = float(config.get('simple_mntm_value') or 0)
            mtp = base_price
            if "PLUS_PCT" in m_mode: mtp += (base_price * m_val / 100)
            elif "PLUS_PTS" in m_mode: mtp += m_val
            elif "MINUS_PCT" in m_mode: mtp -= (base_price * m_val / 100)
            elif "MINUS_PTS" in m_mode: mtp -= m_val
            mtp = self.round_to_tick(mtp)
            
            if 'PLUS_' in m_mode: hit_mask = df['high'] >= mtp
            else: hit_mask = df['low'] <= mtp
                
            if hit_mask.any():
                hit_idx = hit_mask.arg_true()[0]
                entry_time = df['time'][hit_idx]
                entry_price = mtp
                df = df[hit_idx:]
            else:
                return None, df, 'MNTM_NOT_HIT'
        else:
            entry_time = df['time'][0]
            entry_price = override_entry_price if override_entry_price is not None else df['open'][0]
            
        initial_sl = self.calculate_sl_price(leg, entry_price, is_reentry)
        
        tsl_enabled = config.get('reentry_tsl_enabled', False) if is_reentry else config.get('tsl_enabled', False)
        tsl_on_close = config.get('reentry_tsl_on_close', False) if is_reentry else config.get('tsl_on_close', False)
        tsl_on_close_high = config.get('reentry_tsl_on_close_high', False) if is_reentry else config.get('tsl_on_close_high', False)
        tsl_on_close_low = config.get('reentry_tsl_on_close_low', False) if is_reentry else config.get('tsl_on_close_low', False)
        
        # As requested: "on close checked marked, on close high checked marked - normal trailing logic... 
        # This should match the values and outputs of when we have no check marks"
        if tsl_on_close_high or tsl_on_close_low:
            tsl_on_close = False
        
        if initial_sl is None:
            return self._build_trade_res(entry_time, entry_price, df[-1]['time'][0], df[-1]['close'][0], 'END_OF_DAY', None), df[-1:], 'END_OF_DAY'

        if not tsl_enabled:
            if tsl_on_close:
                hit_mask = df['close'] >= initial_sl if side == 'SELL' else df['close'] <= initial_sl
            else:
                hit_mask = df['high'] >= initial_sl if side == 'SELL' else df['low'] <= initial_sl
                
            # Filter out entry minute if TSL on Close
            if tsl_on_close:
                # Set hit_mask to False at index 0
                hit_mask_arr = hit_mask.to_numpy()
                hit_mask_arr[0] = False
                hit_mask = pl.Series(hit_mask_arr)
                
            if hit_mask.any():
                hit_idx = hit_mask.arg_true()[0]
                exit_price = df['close'][hit_idx] if tsl_on_close else initial_sl
                return self._build_trade_res(entry_time, entry_price, df['time'][hit_idx], exit_price, 'SL', initial_sl, initial_sl=initial_sl), df[hit_idx:], 'SL'
            else:
                return self._build_trade_res(entry_time, entry_price, df[-1]['time'][0], df[-1]['close'][0], 'END_OF_DAY', initial_sl, initial_sl=initial_sl), df[-1:], 'END_OF_DAY'
                
        else:
            tsl_type = config.get('reentry_tsl_type', 'PERCENTAGE') if is_reentry else config.get('tsl_type', 'PERCENTAGE')
            tsl_move = float(config.get('reentry_tsl_move') or config.get('tsl_move') or 0)
            tsl_trail = float(config.get('reentry_tsl_trail') or config.get('tsl_trail') or 0)
            
            if tsl_move > 0 and tsl_trail > 0:
                move_threshold = entry_price * (tsl_move / 100) if tsl_type == 'PERCENTAGE' else tsl_move
                trail_amount = entry_price * (tsl_trail / 100) if tsl_type == 'PERCENTAGE' else tsl_trail
                
                trail_ref = df['close'] if tsl_on_close else (df['low'] if side == 'SELL' else df['high'])
                    
                if side == 'BUY':
                    peak_price = trail_ref.cum_max()
                    favorable_move = peak_price - entry_price
                    steps = (favorable_move / move_threshold).clip(lower_bound=0.0).floor()
                    dynamic_sl = initial_sl + (steps * trail_amount)
                    
                    hit_mask = df['close'] <= dynamic_sl if tsl_on_close else df['low'] <= dynamic_sl
                else:
                    peak_price = trail_ref.cum_min()
                    favorable_move = entry_price - peak_price
                    steps = (favorable_move / move_threshold).clip(lower_bound=0.0).floor()
                    dynamic_sl = initial_sl - (steps * trail_amount)
                    
                    hit_mask = df['close'] >= dynamic_sl if tsl_on_close else df['high'] >= dynamic_sl
                        
                if tsl_on_close:
                    hit_mask_arr = hit_mask.to_numpy()
                    hit_mask_arr[0] = False
                    hit_mask = pl.Series(hit_mask_arr)
                
                if hit_mask.any():
                    hit_idx = hit_mask.arg_true()[0]
                    tsl_series = dict(zip(df['time'][:hit_idx+1].to_list(), dynamic_sl[:hit_idx+1].to_list()))
                    exit_price = df['close'][hit_idx] if tsl_on_close else dynamic_sl[hit_idx]
                    return self._build_trade_res(entry_time, entry_price, df['time'][hit_idx], exit_price, 'TSL', dynamic_sl[hit_idx], tsl_series, initial_sl), df[hit_idx:], 'TSL'
                else:
                    tsl_series = dict(zip(df['time'].to_list(), dynamic_sl.to_list()))
                    return self._build_trade_res(entry_time, entry_price, df[-1]['time'][0], df[-1]['close'][0], 'END_OF_DAY', dynamic_sl[-1], tsl_series, initial_sl), df[-1:], 'END_OF_DAY'
            else:
                return self.calculate_trade_vectorized(leg, df, {**config, 'tsl_enabled': False}, is_reentry)
                
    def _build_trade_res(self, entry_time, entry_price, exit_time, exit_price, reason, sl_price, tsl_series=None, initial_sl=None):
        return {
            'entryTime': entry_time, 'entryPrice': entry_price,
            'exitTime': exit_time, 'exitPrice': exit_price,
            'exitReason': reason, 'tradeSlPrice': sl_price,
            'tslSeries': tsl_series or {},
            'initialSlPrice': initial_sl if initial_sl is not None else sl_price
        }

    def calculate_leg_trades(self, leg, df, config, index_name, expiry, year, month, date_str, step, index_df, current_strike):
        all_trades = []
        reentry_count = 0
        max_reentry = int(leg.get('no_of_reentry', 0)) if leg.get('reentry_enabled') else 0
        if leg.get('re_asap_enabled'):
            max_reentry = int(leg.get('re_asap_max_entries', max_reentry))
        if leg.get('recost_enabled') or leg.get('resl_enabled') or leg.get('rehigh_enabled') or leg.get('relow_enabled'):
            max_reentry = max(max_reentry, int(leg.get('max_reentry', 1)))
            
        is_exhausted = True
        master_leg_df = df
        pending_reentry_method = None
        pending_rtp = None
        pending_mtp = None
        pending_rtp_hit_time = None
        pending_override_entry_price = None
        
        while df.height > 0:
            trade_info, remaining_df, exit_reason = self.calculate_trade_vectorized(leg, df, config, reentry_count > 0, pending_override_entry_price)
            
            if not trade_info: break
            trade_info['strike'] = current_strike
            trade_info['option_type'] = leg.get('option_type')
            trade_info['side'] = leg.get('side')
            trade_info['lots'] = leg.get('lots', 1)
            trade_info['leg_config'] = leg.copy()
            trade_info['reentry_method'] = pending_reentry_method
            trade_info['reentry_rtp'] = pending_rtp
            trade_info['reentry_mtp'] = pending_mtp
            trade_info['rtp_hit_time'] = pending_rtp_hit_time
            pending_reentry_method = None
            pending_rtp = None
            pending_mtp = None
            pending_rtp_hit_time = None
            pending_override_entry_price = None
            all_trades.append(trade_info)
            if exit_reason == 'END_OF_DAY': break
            if reentry_count >= max_reentry and not leg.get('lazy_leg_enabled'): break
                
            rtp = None
            wait_dir = 'UP'
            
            # LAZY LEG Logic
            if leg.get('lazy_leg_enabled') and exit_reason == 'SL':
                lazy_config = leg.get('lazy_leg')
                if lazy_config:
                    if remaining_df.height > 1:
                        re_entry_time = remaining_df['time'][1]
                        
                        spot_row = index_df.filter(pl.col('time') == re_entry_time)
                        if spot_row.height > 0:
                            new_spot_price = spot_row['open'][0]
                            new_target_strike = self.get_target_strike(lazy_config, new_spot_price, step, index_name, year, month, expiry, date_str, re_entry_time)
                            
                            res = self.get_valid_option_data_with_fallback(index_name, year, month, date_str, expiry, new_target_strike, lazy_config.get('option_type'), step, re_entry_time, 5, 'ALTERNATE')
                            if res['data'] is not None and res['data'].height > 0:
                                current_strike = res['strike']
                                new_leg_df = res['data'].with_columns(
                                    pl.col('datetime').cast(pl.Utf8).str.split(' ').list.last().str.slice(0, 8).alias('time')
                                ).sort('time')
                                
                                df = new_leg_df.filter(pl.col('time') >= re_entry_time)
                                
                                # Lazy Leg Momentum Wait
                                if lazy_config.get('simple_mntm_enabled'):
                                    base_otp = df['open'][0]
                                    mntm_mode = lazy_config.get('simple_mntm_mode', 'PLUS_PCT')
                                    mntm_val = float(lazy_config.get('simple_mntm_value', 0))
                                    mtp = base_otp
                                    if mntm_mode == 'PLUS_PCT': mtp += (mtp * mntm_val / 100)
                                    elif mntm_mode == 'PLUS_PTS': mtp += mntm_val
                                    elif mntm_mode == 'MINUS_PCT': mtp -= (mtp * mntm_val / 100)
                                    elif mntm_mode == 'MINUS_PTS': mtp -= mntm_val
                                    mtp = self.round_to_tick(mtp)
                                    
                                    wait_dir = 'DOWN' if base_otp > mtp else 'UP'
                                    cross_mask = df['low'] <= mtp if wait_dir == 'DOWN' else df['high'] >= mtp
                                    if cross_mask.any():
                                        cross_idx = cross_mask.arg_true()[0]
                                        df = df[cross_idx:]
                                        re_entry_time = df['time'][0]
                                        pending_override_entry_price = mtp
                                    else:
                                        df = df[0:0]
                                
                                if df.height > 0:
                                    pending_reentry_method = 'LAZY'
                                    leg = lazy_config
                                    reentry_count = 0
                                    max_reentry = int(leg.get('re_asap_max_entries', 0))
                                    master_leg_df = pl.concat([master_leg_df.filter(pl.col('time') < re_entry_time), df])
                                    continue
                                else:
                                    is_exhausted = False
                                    break
                    
                    is_exhausted = False
                    break

            # Check if reentry_type matches the exit reason for standard reentries!
            re_type = leg.get('reentry_type', 'REENTRY_ON_SL')
            if re_type == 'REENTRY_ON_SL' and exit_reason != 'SL':
                break
            if re_type == 'REENTRY_ON_TARGET' and exit_reason != 'TARGET':
                break
            
            # Re-entry triggers
            if leg.get('re_asap_enabled'):
                pending_reentry_method = 'ASAP'
                reentry_count += 1
                if remaining_df.height > 1:
                    re_entry_time = remaining_df['time'][1]
                    
                    # Fetch spot price to calculate new strike
                    spot_row = index_df.filter(pl.col('time') == re_entry_time)
                    if spot_row.height > 0:
                        new_spot_price = spot_row['open'][0]
                        new_target_strike = self.get_target_strike(leg, new_spot_price, step, index_name, year, month, expiry, date_str, re_entry_time)
                        
                        if new_target_strike != current_strike:
                            res = self.get_valid_option_data_with_fallback(index_name, year, month, date_str, expiry, new_target_strike, leg.get('option_type'), step, re_entry_time, 5, 'ALTERNATE')
                            if res['data'] is not None and res['data'].height > 0:
                                current_strike = res['strike']
                                new_leg_df = res['data']
                                new_leg_df = new_leg_df.with_columns(
                                    pl.col('datetime').cast(pl.Utf8).str.split(' ').list.last().str.slice(0, 8).alias('time')
                                ).sort('time')
                                
                                df = new_leg_df.filter(pl.col('time') >= re_entry_time)
                                # Stitch the master_leg_df
                                master_leg_df = pl.concat([master_leg_df.filter(pl.col('time') < re_entry_time), df])
                                continue
                                
                    # If strike hasn't changed or failed to fetch, just use the remaining_df
                    df = remaining_df[1:]
                    continue
                else:
                    is_exhausted = False
                    break
                    
            if leg.get('recost_enabled'):
                mode, val = leg.get('recost_mode', 'RECOST_PLUS_PCT'), float(leg.get('recost_value', 0))
                rtp = trade_info['entryPrice']
                if mode == 'RECOST_PLUS_PCT': rtp += (rtp * val / 100)
                elif mode == 'RECOST_PLUS_PTS': rtp += val
                elif mode == 'RECOST_MINUS_PCT': rtp -= (rtp * val / 100)
                elif mode == 'RECOST_MINUS_PTS': rtp -= val
                rtp = self.round_to_tick(rtp)
                trade_info['next_rtp'] = rtp
                wait_dir = 'DOWN' if trade_info['tradeSlPrice'] > rtp else 'UP'
                
                # Calculate MTP if momentum is enabled
                mtp = None
                if leg.get('recost_mntm_enabled'):
                    m_mode = leg.get('recost_mntm_mode', 'RECOST_PLUS_PCT')
                    m_val = float(leg.get('recost_mntm_value', 0))
                    mtp = rtp
                    if m_mode == 'RECOST_PLUS_PCT': mtp += (mtp * m_val / 100)
                    elif m_mode == 'RECOST_PLUS_PTS': mtp += m_val
                    elif m_mode == 'RECOST_MINUS_PCT': mtp -= (mtp * m_val / 100)
                    elif m_mode == 'RECOST_MINUS_PTS': mtp -= m_val
                    mtp = self.round_to_tick(mtp)
                    trade_info['next_mtp'] = mtp
                
            elif leg.get('resl_enabled'):
                mode, val = leg.get('resl_mode', 'RESL_PLUS_PCT'), float(leg.get('resl_value', 0))
                rtp = trade_info['tradeSlPrice']
                if mode == 'RESL_PLUS_PCT': rtp += (rtp * val / 100)
                elif mode == 'RESL_PLUS_PTS': rtp += val
                elif mode == 'RESL_MINUS_PCT': rtp -= (rtp * val / 100)
                elif mode == 'RESL_MINUS_PTS': rtp -= val
                rtp = self.round_to_tick(rtp)
                trade_info['next_rtp'] = rtp
                wait_dir = 'DOWN' if trade_info['tradeSlPrice'] > rtp else 'UP'
                
                mtp = None
                if leg.get('resl_mntm_enabled'):
                    m_mode = leg.get('resl_mntm_mode', 'RESL_PLUS_PCT')
                    m_val = float(leg.get('resl_mntm_value', 0))
                    mtp = rtp
                    if 'PLUS_PCT' in m_mode or m_mode == 'PERCENTAGE': mtp += (mtp * m_val / 100)
                    elif 'PLUS_PTS' in m_mode or m_mode == 'POINTS': mtp += m_val
                    elif 'MINUS_PCT' in m_mode: mtp -= (mtp * m_val / 100)
                    elif 'MINUS_PTS' in m_mode: mtp -= m_val
                    mtp = self.round_to_tick(mtp)
                    trade_info['next_mtp'] = mtp
                    
            elif leg.get('rehigh_enabled'):
                exit_price = trade_info['exitPrice']
                mode = leg.get('rehigh_mode', 'REHIGH_MINUS_PTS')
                val = float(leg.get('rehigh_value', 0))
                
                # For REHIGH, we need to track the peak from exit onwards
                search_df = remaining_df
                if leg.get('no_reentry_on_sl_candle'):
                    search_df = remaining_df[1:] if remaining_df.height > 1 else remaining_df[0:0]
                
                if search_df.height > 0:
                    # Find the peak price (cumulative max of close)
                    cum_high = search_df['close'].cum_max()
                    peak_start = max(exit_price, cum_high[0])
                    cum_high = cum_high.map_elements(lambda x: max(x, exit_price), return_dtype=pl.Float64)
                    
                    # RTP = peak - val (the price must fall from the peak)
                    if mode == 'REHIGH_MINUS_PCT':
                        rtp_series = cum_high * (1 - val / 100)
                    elif mode == 'REHIGH_MINUS_PTS':
                        rtp_series = cum_high - val
                    else:
                        rtp_series = cum_high
                    
                    rtp_series = rtp_series.map_elements(lambda x: self.round_to_tick(x), return_dtype=pl.Float64)
                    
                    # RTP hit: close drops to or below the rtp level
                    rtp_hit_mask = search_df['close'] <= rtp_series
                    
                    if rtp_hit_mask.any():
                        rtp_idx = rtp_hit_mask.arg_true()[0]
                        rtp = rtp_series[rtp_idx]
                        
                        mtp = None
                        if leg.get('rehigh_mntm_enabled'):
                            m_mode = leg.get('rehigh_mntm_mode', 'REHIGH_PLUS_PCT')
                            m_val = float(leg.get('rehigh_mntm_value', 0))
                            mtp = rtp
                            if m_mode in ('REHIGH_PLUS_PCT', 'PLUS_PCT', 'PERCENTAGE'): mtp += (mtp * m_val / 100)
                            elif m_mode in ('REHIGH_PLUS_PTS', 'PLUS_PTS', 'POINTS'): mtp += m_val
                            elif m_mode in ('REHIGH_MINUS_PCT', 'MINUS_PCT'): mtp -= (mtp * m_val / 100)
                            elif m_mode in ('REHIGH_MINUS_PTS', 'MINUS_PTS'): mtp -= m_val
                            mtp = self.round_to_tick(mtp)
                            
                            # Find MTP crossing after RTP hit
                            mtp_search = search_df[rtp_idx:]
                            mtp_wait_dir = 'DOWN' if mtp < rtp else 'UP'
                            check_col = pl.when(pl.col('time') == trade_info['exitTime']).then(pl.col('close')).otherwise(pl.col('low') if mtp_wait_dir == 'DOWN' else pl.col('high'))
                            mtp_mask = mtp_search.select(check_col <= mtp if mtp_wait_dir == 'DOWN' else check_col >= mtp).to_series()
                            if mtp_mask.any():
                                mtp_idx = mtp_mask.arg_true()[0]
                                reentry_count += 1
                                pending_reentry_method = 'REHIGH'
                                pending_rtp = rtp
                                pending_mtp = mtp
                                pending_rtp_hit_time = search_df['time'][rtp_idx]
                                trade_info['next_rtp'] = rtp
                                trade_info['next_mtp'] = mtp
                                pending_override_entry_price = mtp
                                df = mtp_search[mtp_idx:]
                                continue
                        else:
                            # No MTP, enter at RTP
                            reentry_count += 1
                            pending_reentry_method = 'REHIGH'
                            pending_rtp = rtp
                            trade_info['next_rtp'] = rtp
                            pending_override_entry_price = rtp
                            df = search_df[rtp_idx:]
                            continue
                
                is_exhausted = False
                break
                
            elif leg.get('relow_enabled'):
                exit_price = trade_info['exitPrice']
                mode = leg.get('relow_mode', 'RELOW_PLUS_PTS')
                val = float(leg.get('relow_value', 0))
                
                search_df = remaining_df
                if leg.get('no_reentry_on_sl_candle'):
                    search_df = remaining_df[1:] if remaining_df.height > 1 else remaining_df[0:0]
                
                if search_df.height > 0:
                    # Track the trough (cumulative min of close)
                    cum_low = search_df['close'].cum_min()
                    cum_low = cum_low.map_elements(lambda x: min(x, exit_price), return_dtype=pl.Float64)
                    
                    # RTP = trough + val (price must rise from the trough)
                    if mode == 'RELOW_PLUS_PCT':
                        rtp_series = cum_low * (1 + val / 100)
                    elif mode == 'RELOW_PLUS_PTS':
                        rtp_series = cum_low + val
                    else:
                        rtp_series = cum_low
                    
                    rtp_series = rtp_series.map_elements(lambda x: self.round_to_tick(x), return_dtype=pl.Float64)
                    
                    # RTP hit: close rises to or above the rtp level
                    rtp_hit_mask = search_df['close'] >= rtp_series
                    
                    if rtp_hit_mask.any():
                        rtp_idx = rtp_hit_mask.arg_true()[0]
                        rtp = rtp_series[rtp_idx]
                        
                        mtp = None
                        if leg.get('relow_mntm_enabled'):
                            m_mode = leg.get('relow_mntm_mode', 'RELOW_PLUS_PCT')
                            m_val = float(leg.get('relow_mntm_value', 0))
                            mtp = rtp
                            if m_mode in ('RELOW_PLUS_PCT', 'PLUS_PCT', 'PERCENTAGE'): mtp += (mtp * m_val / 100)
                            elif m_mode in ('RELOW_PLUS_PTS', 'PLUS_PTS', 'POINTS'): mtp += m_val
                            elif m_mode in ('RELOW_MINUS_PCT', 'MINUS_PCT'): mtp -= (mtp * m_val / 100)
                            elif m_mode in ('RELOW_MINUS_PTS', 'MINUS_PTS'): mtp -= m_val
                            mtp = self.round_to_tick(mtp)
                            
                            mtp_search = search_df[rtp_idx:]
                            mtp_wait_dir = 'DOWN' if mtp < rtp else 'UP'
                            check_col = pl.when(pl.col('time') == trade_info['exitTime']).then(pl.col('close')).otherwise(pl.col('low') if mtp_wait_dir == 'DOWN' else pl.col('high'))
                            mtp_mask = mtp_search.select(check_col <= mtp if mtp_wait_dir == 'DOWN' else check_col >= mtp).to_series()
                            if mtp_mask.any():
                                mtp_idx = mtp_mask.arg_true()[0]
                                reentry_count += 1
                                pending_reentry_method = 'RELOW'
                                pending_rtp = rtp
                                pending_mtp = mtp
                                pending_rtp_hit_time = search_df['time'][rtp_idx]
                                trade_info['next_rtp'] = rtp
                                trade_info['next_mtp'] = mtp
                                pending_override_entry_price = mtp
                                df = mtp_search[mtp_idx:]
                                continue
                        else:
                            reentry_count += 1
                            pending_reentry_method = 'RELOW'
                            pending_rtp = rtp
                            trade_info['next_rtp'] = rtp
                            pending_override_entry_price = rtp
                            df = search_df[rtp_idx:]
                            continue
                
                is_exhausted = False
                break
                
            # If we have RTP (RECOST/RESL), find crossing + MTP
            if rtp is not None:
                # We skip the exact SL hit candle if no_reentry_on_sl_candle
                if leg.get('no_reentry_on_sl_candle'):
                    remaining_df = remaining_df[1:]
                    if remaining_df.height == 0:
                        is_exhausted = False
                        break
                
                check_col = pl.when(pl.col('time') == trade_info['exitTime']).then(pl.col('close')).otherwise(pl.col('low') if wait_dir == 'DOWN' else pl.col('high'))
                cross_mask = remaining_df.select(check_col <= rtp if wait_dir == 'DOWN' else check_col >= rtp).to_series()
                if cross_mask.any():
                    cross_idx = cross_mask.arg_true()[0]
                    
                    # Check if MTP is configured
                    rtp_hit_time = remaining_df['time'][cross_idx]
                    if mtp is not None and mtp != rtp:
                        mtp_search = remaining_df[cross_idx:]
                        mtp_wait_dir = 'DOWN' if mtp < rtp else 'UP'
                        check_col = pl.when(pl.col('time') == trade_info['exitTime']).then(pl.col('close')).otherwise(pl.col('low') if mtp_wait_dir == 'DOWN' else pl.col('high'))
                        mtp_mask = mtp_search.select(check_col <= mtp if mtp_wait_dir == 'DOWN' else check_col >= mtp).to_series()
                        if mtp_mask.any():
                            mtp_cross_idx = mtp_mask.arg_true()[0]
                            reentry_count += 1
                            pending_reentry_method = 'RECOST' if leg.get('recost_enabled') else 'RESL'
                            pending_rtp = rtp
                            pending_mtp = mtp
                            pending_rtp_hit_time = rtp_hit_time
                            pending_override_entry_price = mtp
                            df = mtp_search[mtp_cross_idx:]
                            continue
                        else:
                            is_exhausted = False
                            break
                    else:
                        # No MTP, enter directly at RTP
                        reentry_count += 1
                        pending_reentry_method = 'RECOST' if leg.get('recost_enabled') else 'RESL'
                        pending_rtp = rtp
                        pending_override_entry_price = rtp
                        df = remaining_df[cross_idx:]
                        continue
                else:
                    is_exhausted = False
                    break
            else:
                break
                
        return all_trades, is_exhausted, master_leg_df



    def get_target_strike(self, leg, spot_price, step, index_name, year, month, expiry, date_str, entry_time):
        strike_criteria = leg.get('strike_criteria')
        effective_spot = spot_price
        
        if strike_criteria == 'SYNTHETIC_FUTURE':
            sf = self.calculate_synthetic_future_backtest(index_name, year, month, expiry, date_str, spot_price, step, entry_time)
            effective_spot = sf
            
        strike_str = leg.get('strike') or leg.get('strike_selection') or 'ATM'
        type_ = 'ATM'
        import re
        match = re.match(r'^([A-Z]+)(\d*)$', strike_str)
        if match: type_ = match.group(1)
        
        target_strike = self.calculate_atm(effective_spot, step)
        if type_ != 'ATM' and match.group(2):
            steps = int(match.group(2))
            if type_ == 'OTM':
                target_strike = target_strike + (steps * step) if leg.get('option_type') == 'CE' else target_strike - (steps * step)
            elif type_ == 'ITM':
                target_strike = target_strike - (steps * step) if leg.get('option_type') == 'CE' else target_strike + (steps * step)
                
        if strike_criteria == 'CLOSEST_PREMIUM' or type_ == 'PREMIUM':
            target_premium = float(leg.get('premium', 0))
            target_strike = self.find_closest_premium_strike(index_name, year, month, expiry, date_str, target_strike, step, leg.get('option_type'), target_premium, entry_time)
            
        return target_strike

    def build_pnl_array(self, leg, trades, df, start_time, end_time):
        """
        Creates a time-series PnL DataFrame for the leg across the entire day.
        """
        # Create a base dataframe with all times and OHLC
        time_df = df.select(['time', 'open', 'high', 'low', 'close']).filter((pl.col('time') >= start_time) & (pl.col('time') <= end_time))
        
        # We will iterate through trades and assign PnL
        locked_pnl = 0
        pnl_series = []
        open_pnl_series = []
        action_series = []
        
        trade_idx = 0
        for t in time_df['time']:
            action = None
            if trade_idx < len(trades):
                trade = trades[trade_idx]
                if t < trade['entryTime']:
                    pnl_series.append(locked_pnl)
                    open_pnl_series.append(locked_pnl)
                    # Show RTP Hit annotation during waiting period
                    if trade.get('rtp_hit_time') == t and trade.get('reentry_mtp') is not None:
                        action = f"[RTP Hit] ₹{trade['reentry_rtp']:.2f} | Waiting MTP: ₹{trade['reentry_mtp']:.2f}"
                elif t >= trade['entryTime'] and t <= trade['exitTime']:
                    if t == trade['entryTime']:
                        side = 'Sell' if leg.get('side') == 'SELL' else 'Buy'
                        reentry_method = trade.get('reentry_method')
                        if trade_idx == 0 and not reentry_method:
                            prefix = 'Entry'
                        elif reentry_method:
                            prefix = f'Re-Entry [{reentry_method}]'
                        else:
                            prefix = 'Re-Entry'
                        
                        init_sl_val = trade.get('initialSlPrice') or trade.get('tradeSlPrice', 0)
                        sl_str = f" | Init SL: ₹{init_sl_val:.2f}" if init_sl_val else ""
                        # Show RTP/MTP that triggered this re-entry
                        rtp_mtp_str = ""
                        if trade.get('reentry_rtp') is not None:
                            rtp_mtp_str += f" | RTP: ₹{trade['reentry_rtp']:.2f}"
                        if trade.get('reentry_mtp') is not None:
                            rtp_mtp_str += f" | MTP: ₹{trade['reentry_mtp']:.2f}"
                        action = f"{prefix} ({side}): {trade['entryPrice']:.2f}{sl_str}{rtp_mtp_str}"
                    
                    row = df.filter(pl.col('time') == t)
                    if t == trade['exitTime']:
                        price = trade['exitPrice']
                    else:
                        price = row['close'][0] if row.height > 0 else trade['entryPrice']
                    open_price = row['open'][0] if row.height > 0 else trade['entryPrice']
                    
                    diff = (trade['entryPrice'] - price) if leg.get('side') == 'SELL' else (price - trade['entryPrice'])
                    open_diff = (trade['entryPrice'] - open_price) if leg.get('side') == 'SELL' else (open_price - trade['entryPrice'])
                    
                    pnl_series.append(locked_pnl + (diff * leg.get('lots', 1)))
                    open_pnl_series.append(locked_pnl + (open_diff * leg.get('lots', 1)))
                    
                    # Track TSL updates
                    current_sl = trade.get('tslSeries', {}).get(t)
                    if current_sl is not None:
                        if 'last_seen_sl' not in trade:
                            trade['last_seen_sl'] = trade.get('tradeSlPrice')
                            
                        if current_sl != trade['last_seen_sl']:
                            tsl_action = f"TSL updated to: ₹{current_sl:.2f}"
                            if action:
                                action = f"{action} | {tsl_action}"
                            else:
                                action = tsl_action
                            trade['last_seen_sl'] = current_sl
                            
                    if t == trade['exitTime']:
                        exit_diff = (trade['entryPrice'] - trade['exitPrice']) if leg.get('side') == 'SELL' else (trade['exitPrice'] - trade['entryPrice'])
                        locked_pnl += (exit_diff * leg.get('lots', 1))
                        
                        side = 'Buy' if leg.get('side') == 'SELL' else 'Sell'
                        # Show calculated RTP/MTP for next re-entry
                        calc_str = ""
                        if trade.get('next_rtp') is not None:
                            calc_str += f" | Calc RTP: ₹{trade['next_rtp']:.2f}"
                        if trade.get('next_mtp') is not None:
                            calc_str += f" | Calc MTP: ₹{trade['next_mtp']:.2f}"
                        exit_action = f"Exit ({side}) [{trade['exitReason']}]: {trade['exitPrice']:.2f}{calc_str}"
                        if action:
                            action = f"{action} | {exit_action}"
                        else:
                            action = exit_action
                        trade_idx += 1
                else:
                    pnl_series.append(locked_pnl)
                    open_pnl_series.append(locked_pnl)
            else:
                pnl_series.append(locked_pnl)
                open_pnl_series.append(locked_pnl)
            action_series.append(action)
                
        return time_df.with_columns([
            pl.Series("pnl", pnl_series, dtype=pl.Float64),
            pl.Series("open_pnl", open_pnl_series, dtype=pl.Float64),
            pl.Series("action", action_series)
        ])

    def run(self):
        date_range = self.generate_date_range()
        
        lotsize = 65 if self.index_name == 'NIFTY' else (20 if self.index_name == 'SENSEX' else 1)
        
        for date_str in date_range:
            year, month = date_str.split('-')[:2]
            expiry = self.find_closest_expiry(self.index_name, date_str)
            if not expiry: continue
            
            step = self.get_strike_step(self.index_name)
            index_df = self.fetch_stitched_data('index', self.index_name, year, month, date_str)
            if index_df is None or index_df.height == 0: continue
            
            # Format index_df time
            index_df = index_df.with_columns(
                pl.col('datetime').cast(pl.Utf8).str.split(' ').list.last().str.slice(0, 8).alias('time')
            ).sort('time')
            
            entry_row = index_df.filter(pl.col('time') >= self.entry_time)
            if entry_row.height == 0: continue
            
            spot_price = entry_row['open'][0]
            entry_time = entry_row['time'][0]
            
            daily_trades = []
            leg_pnl_dfs = []
            
            all_legs_exhausted = True
            max_exit_time = "00:00:00"
            
            legs = self.config.get('legs', [])
            
            for leg in legs:
                qty = leg.get('lots', 1) * lotsize
                
                target_strike = self.get_target_strike(leg, spot_price, step, self.index_name, year, month, expiry, date_str, entry_time)
                
                res = self.get_valid_option_data_with_fallback(self.index_name, year, month, date_str, expiry, target_strike, leg.get('option_type'), step, entry_time, 5, 'ALTERNATE')
                final_strike = res['strike']
                leg_df = res['data']
                
                if leg_df is None or leg_df.height == 0: 
                    continue
                
                # Extract time from datetime
                leg_df = leg_df.with_columns(
                    pl.col('datetime').cast(pl.Utf8).str.split(' ').list.last().str.slice(0, 8).alias('time')
                ).sort('time')
                
                # Filter to start at entry_time
                leg_df = leg_df.filter(pl.col('time') >= entry_time)
                
                # Calculate trades for this leg!
                trades, is_exhausted, stitched_leg_df = self.calculate_leg_trades(leg, leg_df, leg, self.index_name, expiry, year, month, date_str, step, index_df, final_strike)
                
                if not is_exhausted:
                    all_legs_exhausted = False
                    
                if trades:
                    last_trade_time = trades[-1]['exitTime']
                    if last_trade_time > max_exit_time:
                        max_exit_time = last_trade_time
                
                for tr in trades:
                    actual_qty = int(tr.get('lots', leg.get('lots', 1))) * lotsize
                    tr['qty'] = actual_qty
                    tr['tradeValue'] = tr['entryPrice'] * actual_qty
                    
                    tr_side = tr.get('side', leg.get('side', 'SELL'))
                    exit_diff = (tr['entryPrice'] - tr['exitPrice']) if tr_side == 'SELL' else (tr['exitPrice'] - tr['entryPrice'])
                    tr['tradePnL'] = exit_diff * actual_qty
                    tr['leg_id'] = leg.get('id')
                    
                    opt_type = tr.get('option_type', leg.get('option_type', 'CE'))
                    tr['symbol'] = f"{tr.get('strike', final_strike)}_{opt_type}"
                    tr['side'] = tr_side
                    daily_trades.append(tr)
                    
                if not trades:
                    # No trades at all, just build a flat array with the initial strike
                    pnl_df = self.build_pnl_array(leg, [], stitched_leg_df, entry_time, self.exit_time)
                    pnl_df = pnl_df.with_columns(
                        (pl.col("pnl") * lotsize).alias("pnl"),
                        (pl.col("open_pnl") * lotsize).alias("open_pnl")
                    )
                    leg_key = f"{final_strike}_{leg.get('option_type')}"
                    leg_pnl_dfs.append((leg_key, pnl_df))
                else:
                    # Group trades by their exact strike/symbol so each gets its own chart column
                    groups = {}
                    for tr in trades:
                        groups.setdefault(tr['symbol'], []).append(tr)
                        
                    for symbol, sym_trades in groups.items():
                        actual_leg = sym_trades[0].get('leg_config', leg)
                        pnl_df = self.build_pnl_array(actual_leg, sym_trades, stitched_leg_df, entry_time, self.exit_time)
                        
                        actual_lotsize = int(actual_leg.get('lots', 1)) * (lotsize / int(leg.get('lots', 1))) if lotsize > 0 else lotsize
                        
                        pnl_df = pnl_df.with_columns(
                            (pl.col("pnl") * actual_lotsize).alias("pnl"),
                            (pl.col("open_pnl") * actual_lotsize).alias("open_pnl")
                        )
                        leg_pnl_dfs.append((symbol, pnl_df))
            if not leg_pnl_dfs: continue
            
            # --- Overall SL / Target Aggregation ---
            overall_df = leg_pnl_dfs[0][1]
            for i in range(1, len(leg_pnl_dfs)):
                overall_df = overall_df.join(leg_pnl_dfs[i][1], on="time", how="full", coalesce=True)
                overall_df = overall_df.with_columns(
                    (pl.col("pnl").fill_null(0) + pl.col("pnl_right").fill_null(0)).alias("pnl"),
                    (pl.col("open_pnl").fill_null(0) + pl.col("open_pnl_right").fill_null(0)).alias("open_pnl")
                )
                # Drop all suffixed columns from the join so the next join doesn't clash
                drop_cols = [c for c in overall_df.columns if c.endswith('_right')]
                if drop_cols:
                    overall_df = overall_df.drop(drop_cols)
                
            # Calculate total invested value for percentage calculations
            total_invested = 0
            for leg_key, l_df in leg_pnl_dfs:
                # Find the initial trade for this leg from daily_trades
                for tr in daily_trades:
                    if tr['symbol'] == leg_key:
                        total_invested += tr['entryPrice'] * tr['qty']
                        break
                        
            multiplier = float(self.config.get('quantity_multiplier', 1))
            
            # Parse overall SL config
            overall_sl_enabled = self.config.get('overall_sl_enabled', False)
            overall_sl_value = float(self.config.get('overall_sl_value') or 0)
            overall_sl_type = self.config.get('overall_sl_type', 'PERCENTAGE')
            legacy_sl = float(self.config.get('overall_sl') or 0)
            if legacy_sl > 0 and not overall_sl_enabled:
                overall_sl_enabled = True
                overall_sl_value = legacy_sl
                overall_sl_type = 'AMOUNT'
                
            sl_amt = 0
            if overall_sl_enabled and overall_sl_value > 0:
                sl_amt = (overall_sl_value / 100.0) * total_invested if overall_sl_type == 'PERCENTAGE' else (overall_sl_value * multiplier)
                
            # Parse overall Target config
            overall_tgt_enabled = self.config.get('overall_target_enabled', False)
            overall_tgt_value = float(self.config.get('overall_target_value') or 0)
            overall_tgt_type = self.config.get('overall_target_type', 'PERCENTAGE')
            legacy_tgt = float(self.config.get('overall_target') or 0)
            if legacy_tgt > 0 and not overall_tgt_enabled:
                overall_tgt_enabled = True
                overall_tgt_value = legacy_tgt
                overall_tgt_type = 'AMOUNT'
                
            tgt_amt = 0
            if overall_tgt_enabled and overall_tgt_value > 0:
                tgt_amt = (overall_tgt_value / 100.0) * total_invested if overall_tgt_type == 'PERCENTAGE' else (overall_tgt_value * multiplier)
            
            overall_exit_time = self.exit_time
            overall_exit_reason = None
            overall_hit_on = None
            
            if sl_amt > 0 or tgt_amt > 0:
                hit_mask_open = pl.Series([False] * len(overall_df))
                hit_mask_close = pl.Series([False] * len(overall_df))
                
                overall_sl_on_close = self.config.get('overall_sl_on_close', False)
                overall_tgt_on_close = self.config.get('overall_target_on_close', False)
                
                if sl_amt > 0:
                    if not overall_sl_on_close:
                        hit_mask_open = hit_mask_open | (overall_df['open_pnl'] <= -sl_amt)
                    hit_mask_close = hit_mask_close | (overall_df['pnl'] <= -sl_amt)
                if tgt_amt > 0:
                    if not overall_tgt_on_close:
                        hit_mask_open = hit_mask_open | (overall_df['open_pnl'] >= tgt_amt)
                    hit_mask_close = hit_mask_close | (overall_df['pnl'] >= tgt_amt)
                    
                hit_idx_open = hit_mask_open.arg_true()[0] if hit_mask_open.any() else None
                hit_idx_close = hit_mask_close.arg_true()[0] if hit_mask_close.any() else None
                
                hit_idx = None
                if hit_idx_open is not None and hit_idx_close is not None:
                    if hit_idx_open <= hit_idx_close:
                        hit_idx = hit_idx_open
                        overall_hit_on = 'open'
                    else:
                        hit_idx = hit_idx_close
                        overall_hit_on = 'close'
                elif hit_idx_open is not None:
                    hit_idx = hit_idx_open
                    overall_hit_on = 'open'
                elif hit_idx_close is not None:
                    hit_idx = hit_idx_close
                    overall_hit_on = 'close'
                    
                if hit_idx is not None:
                    overall_exit_time = overall_df['time'][hit_idx]
                    overall_pnl_val = overall_df['open_pnl'][hit_idx] if overall_hit_on == 'open' else overall_df['pnl'][hit_idx]
                    overall_exit_reason = 'OVER_SL' if (sl_amt > 0 and overall_pnl_val <= -sl_amt) else 'OVER_TGT'
                    
            if all_legs_exhausted and max_exit_time != "00:00:00":
                if overall_exit_time > max_exit_time:
                    overall_exit_time = max_exit_time
                    # DO NOT set overall_exit_reason, we want the legs to retain their natural exit reasons!
                    
            # Truncate trades after overall_exit_time
            truncated_trades = []
            for tr in daily_trades:
                if tr['entryTime'] > overall_exit_time:
                    continue # Trade never happened
                    
                if tr['exitTime'] >= overall_exit_time:
                    if tr['exitTime'] > overall_exit_time:
                        tr['exitTime'] = overall_exit_time
                        
                    if overall_exit_reason:
                        tr['exitReason'] = overall_exit_reason
                    elif tr['exitTime'] >= self.exit_time:
                        tr['exitReason'] = 'EXIT_TIME'
                    
                    for l_key, l_df in leg_pnl_dfs:
                        if l_key == tr['symbol']:
                            row = l_df.filter(pl.col('time') == overall_exit_time)
                            if row.height > 0:
                                if tr['exitReason'] == 'EXIT_TIME':
                                    tr['exitPrice'] = row['open'][0]
                                elif tr['exitReason'] in ('OVER_SL', 'OVER_TGT') and overall_hit_on == 'open':
                                    tr['exitPrice'] = row['open'][0]
                                else:
                                    tr['exitPrice'] = row['close'][0]
                            break
                                
                    # Recalculate PnL with new exit price
                    exit_diff = (tr['entryPrice'] - tr['exitPrice']) if tr['side'] == 'SELL' else (tr['exitPrice'] - tr['entryPrice'])
                    tr['tradePnL'] = exit_diff * tr['qty']
                    
                truncated_trades.append(tr)
                
            day_chart = {}
            for leg_key, df in leg_pnl_dfs:
                # Filter to overall_exit_time
                df_filtered = df.filter(pl.col('time') <= overall_exit_time)
                
                # Check if this specific strike was traded, and filter to its active periods to cut off the table when inactive
                # Only cut off for strike-changing re-entries (ASAP/LAZY). For same-strike re-entries (RECOST/RESL/REHIGH/RELOW), show full candles.
                has_trades = False
                has_strike_change = False
                mask = pl.lit(False)
                for tr in truncated_trades:
                    if tr['symbol'] == leg_key:
                        has_trades = True
                        if tr.get('reentry_method') in ('ASAP', 'LAZY'):
                            has_strike_change = True
                        mask = mask | ((pl.col('time') >= tr['entryTime']) & (pl.col('time') <= tr['exitTime']))
                
                if has_trades and has_strike_change:
                    df_filtered = df_filtered.filter(mask)
                    
                dicts = df_filtered.to_dicts()
                if dicts:
                    last_row = dicts[-1]
                    existing_action = last_row.get('action') or ''
                    
                    # Find exit side and price for this leg
                    for tr in truncated_trades:
                        if tr['symbol'] == leg_key and tr['exitTime'] == overall_exit_time:
                            if "Exit" not in existing_action:
                                side = 'Buy' if tr['side'] == 'SELL' else 'Sell'
                                price = tr['exitPrice']
                                reason = tr['exitReason']
                                sep = " | " if existing_action else ""
                                last_row['action'] = f"{existing_action}{sep}Exit ({side}) [{reason}]: {price:.2f}".strip()
                            break
                            
                day_chart[leg_key] = dicts
                
            # Filter overall_df to overall_exit_time
            overall_df_filtered = overall_df.filter(pl.col('time') <= overall_exit_time)
            day_chart["OVERALL_PNL"] = overall_df_filtered.to_dicts()
                
            self.results['chartData'][date_str] = day_chart
            
            dte = 0
            curr = datetime.strptime(date_str, "%Y-%m-%d") + timedelta(days=1)
            exp_date = datetime.strptime(expiry, "%Y-%m-%d")
            while curr <= exp_date:
                t_str = curr.strftime("%Y-%m-%d")
                y, m = t_str.split('-')[:2]
                idx_file = os.path.join(MARKET_DATA_DIR, 'index', self.index_name, y, m, f"{t_str}.parquet")
                if os.path.exists(idx_file): dte += 1
                curr += timedelta(days=1)
                
            final_daily_trades = []
            for tr in truncated_trades:
                final_daily_trades.append({
                    'date': date_str,
                    'leg_id': tr['leg_id'],
                    'symbol': tr['symbol'],
                    'side': tr['side'],
                    'entry_time': tr['entryTime'],
                    'entry_price': tr['entryPrice'],
                    'exit_time': tr['exitTime'],
                    'exit_price': tr['exitPrice'],
                    'exit_reason': tr['exitReason'],
                    'qty': tr['qty'],
                    'pnl': tr['tradePnL'],
                    'trade_value': tr['tradeValue'],
                    'pnl_percent': (tr['tradePnL'] / tr['tradeValue'] * 100) if tr['tradeValue'] > 0 else 0
                })
            
            self.results['trades'].extend(final_daily_trades)
            daily_pnl = sum(t['tradePnL'] for t in truncated_trades)
            daily_trade_value = sum(t.get('tradeValue', 0) for t in truncated_trades)
            
            self.results['dailySummary'][date_str] = {
                'pnl': daily_pnl,
                'trade_value': daily_trade_value,
                'pnl_percent': (daily_pnl / daily_trade_value * 100) if daily_trade_value > 0 else 0,
                'dte': dte,
                'expiry': expiry
            }

        # Calculate total PnL and Max Drawdown
        total_pnl = 0
        peak_pnl = 0
        max_dd = 0
        
        # Sort trades by exit time
        all_trades = self.results['trades']
        all_trades.sort(key=lambda x: x['exit_time'] if isinstance(x['exit_time'], str) else str(x['exit_time']))
        
        for tr in all_trades:
            total_pnl += tr['pnl']
            if total_pnl > peak_pnl:
                peak_pnl = total_pnl
            dd = peak_pnl - total_pnl
            if dd > max_dd:
                max_dd = dd
                
        self.results['totalPnL'] = total_pnl
        self.results['maxDrawdown'] = max_dd

if __name__ == "__main__":
    import sys, json
    try:
        input_data = sys.stdin.read()
        data = json.loads(input_data)
        engine = BacktestEngine(data['strategy'], data['fromDate'], data['toDate'])
        engine.run()
        print(json.dumps(engine.results))
    except Exception as e:
        import traceback
        sys.stderr.write(traceback.format_exc())
        sys.exit(1)
