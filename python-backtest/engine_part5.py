    def handle_dynamic_reentry(self, active, t, node, state_prefix, index_data_map, expiry, year, month, date_str, step):
        if active['leg'].get('no_reentry_on_sl_candle') and active.get('slHitMinute') == t:
            return
            
        config = active.get('lazyLegConfig') if state_prefix == 'LAZY' else active['leg']
        next_strike_key = 'lazyNextStrike' if state_prefix == 'LAZY' else 'asapNextStrike'
        
        new_target_strike = active.get(next_strike_key, active['targetStrike'])
        
        if new_target_strike != active['targetStrike']:
            strike_str = config.get('strike') or config.get('strike_selection') or 'ATM'
            
            type_ = 'ATM'
            import re
            match = re.match(r'^([A-Z]+)(\d*)$', strike_str)
            if match: type_ = match.group(1)
            
            fallback_dir = 'ALTERNATE'
            if type_ == 'OTM': fallback_dir = 'UP' if config.get('option_type') == 'CE' else 'DOWN'
            elif type_ == 'ITM': fallback_dir = 'DOWN' if config.get('option_type') == 'CE' else 'UP'
            
            fallback_res = self.get_valid_option_data_with_fallback(self.index_name, year, month, date_str, expiry, new_target_strike, config.get('option_type'), step, t, 5, fallback_dir)
            final_target_strike = fallback_res['strike']
            new_option_data = fallback_res['data']
            
            if final_target_strike != new_target_strike:
                active[next_strike_key] = final_target_strike
                new_target_strike = final_target_strike
                
            if new_option_data and len(new_option_data) > 0:
                baseline_pnl = active.get('strikeBaselinePnL', 0)
                sl_time = active['trades'][-1].get('exitTime', t) if active['trades'] else t
                start_time = active.get('strikeStartTime', active.get('entryTime', '09:15:00'))
                
                old_chart = []
                for n in active['optionDayChart']:
                    pnl = active['minutePnLMap'].get(n['time'], 0) - baseline_pnl
                    new_n = dict(n)
                    new_n['pnl'] = pnl
                    if start_time <= n['time'] <= sl_time:
                        old_chart.append(new_n)
                        
                suffix = f" (Leg {len(active['historicalCharts']) + 1})" if state_prefix == 'LAZY' and len(active['historicalCharts']) > 0 else " (Leg 1)" if state_prefix == 'LAZY' else ""
                
                active['historicalCharts'].append({
                    'key': f"{active['targetStrike']}_{active['leg'].get('option_type')}{suffix}",
                    'chart': old_chart,
                    'endTime': t
                })
                
                active['strikeStartTime'] = t
                active['strikeBaselinePnL'] = active['lockedPnL']
                
                if state_prefix == 'LAZY':
                    active['leg'] = config
                    lotsize = 65 if self.index_name == 'NIFTY' else (20 if self.index_name == 'SENSEX' else 1)
                    active['qty'] = active['leg'].get('lots', 1) * lotsize * 1
                    active['lazyLegConfig'] = None
                    
                active['targetStrike'] = new_target_strike
                active['optionData'] = new_option_data
                
                chart_map = {}
                option_day_chart = []
                for row in new_option_data:
                    t_str = self.extract_time_option(row)
                    mapped = {'time': t_str, 'open': row[6], 'high': row[4], 'low': row[5], 'close': row[0], 'action': None}
                    if t_str: chart_map[t_str] = mapped
                    option_day_chart.append(mapped)
                    
                active['chartMap'] = chart_map
                active['optionDayChart'] = option_day_chart
                
                idx = next((i for i, c in enumerate(active['optionDayChart']) if c['time'] == t), -1)
                if idx != -1:
                    active['optionDayChart'][idx]['action'] = f"[{state_prefix} LEG] Loaded Strike for Re-entry"
                    
        new_node = active['chartMap'].get(t)
        if new_node:
            if config.get('simple_mntm_enabled'):
                active['state'] = 'WAITING_FOR_MNTM'
                base_price = new_node['open']
                m_mode = config.get('simple_mntm_mode', 'SIMPLE_PLUS_PCT')
                m_val = float(config.get('simple_mntm_value') or 0)
                mtp = base_price
                if "PLUS_PCT" in m_mode: mtp += (base_price * m_val / 100)
                elif "PLUS_PTS" in m_mode: mtp += m_val
                elif "MINUS_PCT" in m_mode: mtp -= (base_price * m_val / 100)
                elif "MINUS_PTS" in m_mode: mtp -= m_val
                active['mtp'] = self.round_to_tick(mtp)
                
                idx = next((i for i, c in enumerate(active['optionDayChart']) if c['time'] == t), -1)
                if idx != -1:
                    action_str = f"[{state_prefix} LEG] Waiting MNTM: ₹{active['mtp']:.2f}"
                    active['optionDayChart'][idx]['action'] = active['optionDayChart'][idx]['action'] + ' | ' + action_str if active['optionDayChart'][idx]['action'] else action_str
            else:
                self.execute_entry(active, t, new_node['open'], new_node, f"RE-{state_prefix}", state_prefix != 'LAZY')
                if state_prefix == 'LAZY': active['reentryCount'] = 0
