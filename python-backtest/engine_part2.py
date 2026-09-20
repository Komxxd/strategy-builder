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

    def run(self):
        dates = self.generate_date_range()
        step = self.get_strike_step(self.index_name)
        
        for date_str in dates:
            year, month, _ = date_str.split('-')
            
            index_data = self.fetch_stitched_data('index', self.index_name, year, month, date_str)
            if not index_data: continue
            
            day_chart = {}
            index_entry_row = next((r for r in index_data if self.extract_time(r) == self.entry_time), None)
            if not index_entry_row: continue
            
            index_chart_map = {}
            for row in index_data:
                t = self.extract_time(row)
                if t: index_chart_map[t] = {'close': row[0], 'high': row[3], 'low': row[4], 'open': row[5]}
                
            spot_price = index_entry_row[5]
            atm_strike = self.calculate_atm(spot_price, step)
            
            expiry = self.find_closest_expiry(self.index_name, date_str)
            if not expiry: continue
            
            daily_pnl = 0
            daily_trade_value = 0
            
            active_legs = []
            lotsize = 65 if self.index_name == 'NIFTY' else (20 if self.index_name == 'SENSEX' else 1)
            multiplier = 1
            
            for leg in self.config.get('legs', []):
                strike_str = leg.get('strike') or leg.get('strike_selection') or 'ATM'
                
                type_ = 'ATM'
                offset = 0
                import re
                match = re.match(r'^([A-Z]+)(\d*)$', strike_str)
                if match:
                    type_ = match.group(1)
                    offset = int(match.group(2)) if match.group(2) else 0
                    
                target_strike = atm_strike
                if leg.get('strike_criteria') == 'CLOSEST_PREMIUM':
                    target_premium = float(leg.get('premium') or 0)
                    target_strike = self.find_closest_premium_strike(self.index_name, year, month, expiry, date_str, atm_strike, step, leg.get('option_type'), target_premium, self.entry_time)
                elif leg.get('strike_criteria') == 'SYNTHETIC_FUTURE':
                    sf_price = self.calculate_synthetic_future_backtest(self.index_name, year, month, expiry, date_str, spot_price, step, self.entry_time)
                    sf_atm = self.calculate_atm(sf_price, step)
                    if type_ == 'OTM':
                        target_strike = sf_atm + (offset * step) if leg.get('option_type') == 'CE' else sf_atm - (offset * step)
                    elif type_ == 'ITM':
                        target_strike = sf_atm - (offset * step) if leg.get('option_type') == 'CE' else sf_atm + (offset * step)
                    else:
                        target_strike = sf_atm
                elif type_ == 'OTM':
                    target_strike = atm_strike + (offset * step) if leg.get('option_type') == 'CE' else atm_strike - (offset * step)
                elif type_ == 'ITM':
                    target_strike = atm_strike - (offset * step) if leg.get('option_type') == 'CE' else atm_strike + (offset * step)
                    
                fallback_dir = 'ALTERNATE'
                if type_ == 'OTM': fallback_dir = 'UP' if leg.get('option_type') == 'CE' else 'DOWN'
                elif type_ == 'ITM': fallback_dir = 'DOWN' if leg.get('option_type') == 'CE' else 'UP'
                
                fallback_res = self.get_valid_option_data_with_fallback(self.index_name, year, month, date_str, expiry, target_strike, leg.get('option_type'), step, self.entry_time, 5, fallback_dir)
                target_strike = fallback_res['strike']
                option_data = fallback_res['data']
                
                if not option_data or len(option_data) == 0: continue
                
                chart_map = {}
                option_day_chart = []
                for row in option_data:
                    t = self.extract_time_option(row)
                    mapped = {'time': t, 'open': row[6], 'high': row[4], 'low': row[5], 'close': row[0], 'action': None}
                    if t: chart_map[t] = mapped
                    option_day_chart.append(mapped)
                    
                actual_entry_time = self.entry_time
                entry_node = chart_map.get(actual_entry_time)
                if not entry_node:
                    all_keys = sorted(list(chart_map.keys()))
                    next_time = next((t for t in all_keys if t >= self.entry_time), None)
                    if next_time:
                        actual_entry_time = next_time
                        entry_node = chart_map.get(actual_entry_time)
                        
                if not entry_node: continue
                
                base_price = entry_node['open']
                qty = leg.get('lots', 1) * lotsize * multiplier
                
                initial_state = 'ACTIVE'
                initial_trades = []
                initial_entry_price = None
                initial_sl_price = None
                initial_tsl_ref = None
                mtp = None
                
                if leg.get('simple_mntm_enabled'):
                    initial_state = 'WAITING_FOR_MNTM'
                    m_mode = leg.get('simple_mntm_mode', 'SIMPLE_PLUS_PCT')
                    m_val = float(leg.get('simple_mntm_value') or 0)
                    
                    if "PLUS_PCT" in m_mode: mtp = base_price + (base_price * m_val / 100)
                    elif "PLUS_PTS" in m_mode: mtp = base_price + m_val
                    elif "MINUS_PCT" in m_mode: mtp = base_price - (base_price * m_val / 100)
                    elif "MINUS_PTS" in m_mode: mtp = base_price - m_val
                    
                    mtp = self.round_to_tick(mtp)
                else:
                    initial_entry_price = base_price
                    daily_trade_value += (initial_entry_price * qty)
                    initial_sl_price = self.calculate_sl_price(leg, initial_entry_price, False)
                    initial_tsl_ref = initial_entry_price
                    initial_trades.append({
                        'entryTime': actual_entry_time, 'entryPrice': initial_entry_price,
                        'exitTime': None, 'exitPrice': None, 'exitReason': None,
                        'tradePnL': 0, 'tradeValue': initial_entry_price * qty, 'tradeSlPrice': initial_sl_price
                    })
                    
                active_legs.append({
                    'leg': leg, 'targetStrike': target_strike, 'qty': qty, 'chartMap': chart_map,
                    'optionDayChart': option_day_chart, 'optionData': option_data,
                    'state': initial_state, 'reentryCount': 0, 'trades': initial_trades,
                    'entryTime': actual_entry_time if initial_state == 'ACTIVE' else None,
                    'entryPrice': initial_entry_price, 'slPrice': initial_sl_price, 'lockedPnL': 0,
                    'rtp': None, 'mtp': mtp, 'tslReferencePrice': initial_tsl_ref, 'baseOtp': base_price,
                    'minutePnLMap': {}, 'historicalCharts': []
                })
                
            if len(active_legs) == 0: continue
            
            actual_exit_time = self.exit_time
            exit_reason = 'EXIT_TIME'
            
            all_times = sorted([t for t in active_legs[0]['chartMap'].keys() if self.entry_time <= t <= self.exit_time])
            
            sl_enabled = self.config.get('overall_sl_enabled') and float(self.config.get('overall_sl_value', 0)) > 0
            sl_val = float(self.config.get('overall_sl_value') or 0)
            
            target_enabled = self.config.get('overall_target_enabled') and float(self.config.get('overall_target_value', 0)) > 0
            target_val = float(self.config.get('overall_target_value') or 0)
            
            daily_overall_pnl_chart = []
            exit_at_open = False
            
            for t in all_times:
                current_open_pnl = 0
                current_close_pnl = 0
                
                for active in active_legs:
                    node = active['chartMap'].get(t)
                    if not node:
                        fallback_pnl = active.get('lastMinutePnL', active['lockedPnL'])
                        current_open_pnl += fallback_pnl
                        current_close_pnl += fallback_pnl
                        active['minutePnLMap'][t] = fallback_pnl
                        active['lastMinutePnL'] = fallback_pnl
                        continue
                        
                    # State machine goes here
                    # We will implement the simplified but exact state machine in the next file block
                    pass
