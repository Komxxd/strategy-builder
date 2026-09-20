                    # --- START STATE MACHINE ---
                    if active['state'] == 'WAITING_FOR_MNTM':
                        mntm_hit = False
                        if 'PLUS_' in active['leg'].get('simple_mntm_mode', ''):
                            if node['high'] >= active['mtp']: mntm_hit = True
                        else:
                            if node['low'] <= active['mtp']: mntm_hit = True
                            
                        if mntm_hit:
                            self.execute_entry(active, t, active['mtp'], node, 'MNTM', False)
                    
                    elif active['state'] == 'ACTIVE':
                        is_entry_minute = (t == active.get('entryTime'))
                        is_reentered = active.get('reentryCount', 0) > 0
                        
                        tsl_on_close = (active['leg'].get('reentry_tsl_on_close', False) or (not active['leg'].get('reentry_tsl_on_close', False) and active['leg'].get('tsl_on_close', False))) if is_reentered else active['leg'].get('tsl_on_close', False)
                        
                        check_sl = True
                        trail_reference = node['close']
                        
                        if tsl_on_close:
                            if is_reentered and is_entry_minute: check_sl = False
                        else:
                            if not is_reentered:
                                check_sl = True
                                trail_reference = node['low'] if active['leg'].get('side') == 'SELL' else node['high']
                            else:
                                if is_entry_minute:
                                    check_sl = False
                                    trail_reference = node['close']
                                else:
                                    check_sl = True
                                    trail_reference = node['low'] if active['leg'].get('side') == 'SELL' else node['high']
                                    
                        is_tsl_enabled = active['leg'].get('reentry_tsl_enabled', False) if is_reentered else active['leg'].get('tsl_enabled', False)
                        trailed_in_this_minute = False
                        
                        # TSL Logic
                        if tsl_on_close:
                            hit_sl = False
                            if check_sl and active.get('slPrice') is not None:
                                if active['leg'].get('side') == 'SELL' and node['high'] >= active['slPrice']: hit_sl = True
                                if active['leg'].get('side') == 'BUY' and node['low'] <= active['slPrice']: hit_sl = True
                                
                            if not hit_sl and is_tsl_enabled and active.get('tslReferencePrice') is not None:
                                tsl_type = active['leg'].get('reentry_tsl_type', 'PERCENTAGE') if is_reentered else active['leg'].get('tsl_type', 'PERCENTAGE')
                                tsl_move = float(active['leg'].get('reentry_tsl_move') or active['leg'].get('tsl_move') or 0)
                                tsl_trail = float(active['leg'].get('reentry_tsl_trail') or active['leg'].get('tsl_trail') or 0)
                                
                                if tsl_move > 0 and tsl_trail > 0:
                                    move_threshold = active['entryPrice'] * (tsl_move / 100) if tsl_type == 'PERCENTAGE' else tsl_move
                                    trail_amount = active['entryPrice'] * (tsl_trail / 100) if tsl_type == 'PERCENTAGE' else tsl_trail
                                    
                                    peak_price = trail_reference
                                    favorable_move = (peak_price - active['tslReferencePrice']) if active['leg'].get('side') == 'BUY' else (active['tslReferencePrice'] - peak_price)
                                    
                                    if favorable_move >= move_threshold:
                                        steps = int(favorable_move // move_threshold)
                                        if steps > 0:
                                            if active['leg'].get('side') == 'BUY':
                                                active['slPrice'] += (steps * trail_amount)
                                                active['tslReferencePrice'] += (steps * move_threshold)
                                            else:
                                                active['slPrice'] -= (steps * trail_amount)
                                                active['tslReferencePrice'] -= (steps * move_threshold)
                                            active['slPrice'] = self.round_to_tick(active['slPrice'])
                                            trailed_in_this_minute = True
                        else:
                            if is_tsl_enabled and active.get('tslReferencePrice') is not None:
                                tsl_type = active['leg'].get('reentry_tsl_type', 'PERCENTAGE') if is_reentered else active['leg'].get('tsl_type', 'PERCENTAGE')
                                tsl_move = float(active['leg'].get('reentry_tsl_move') or active['leg'].get('tsl_move') or 0)
                                tsl_trail = float(active['leg'].get('reentry_tsl_trail') or active['leg'].get('tsl_trail') or 0)
                                
                                if tsl_move > 0 and tsl_trail > 0:
                                    move_threshold = active['entryPrice'] * (tsl_move / 100) if tsl_type == 'PERCENTAGE' else tsl_move
                                    trail_amount = active['entryPrice'] * (tsl_trail / 100) if tsl_type == 'PERCENTAGE' else tsl_trail
                                    
                                    peak_price = trail_reference
                                    favorable_move = (peak_price - active['tslReferencePrice']) if active['leg'].get('side') == 'BUY' else (active['tslReferencePrice'] - peak_price)
                                    
                                    if favorable_move >= move_threshold:
                                        steps = int(favorable_move // move_threshold)
                                        if steps > 0:
                                            if active['leg'].get('side') == 'BUY':
                                                active['slPrice'] += (steps * trail_amount)
                                                active['tslReferencePrice'] += (steps * move_threshold)
                                            else:
                                                active['slPrice'] -= (steps * trail_amount)
                                                active['tslReferencePrice'] -= (steps * move_threshold)
                                            active['slPrice'] = self.round_to_tick(active['slPrice'])
                                            trailed_in_this_minute = True
                                            
                        hit_sl = False
                        if check_sl and active.get('slPrice') is not None:
                            if tsl_on_close:
                                if active['leg'].get('side') == 'SELL' and node['high'] >= active['slPrice']: hit_sl = True
                                if active['leg'].get('side') == 'BUY' and node['low'] <= active['slPrice']: hit_sl = True
                            elif trailed_in_this_minute:
                                if active['leg'].get('side') == 'SELL' and node['close'] >= active['slPrice']: hit_sl = True
                                if active['leg'].get('side') == 'BUY' and node['close'] <= active['slPrice']: hit_sl = True
                            else:
                                if active['leg'].get('side') == 'SELL' and node['high'] >= active['slPrice']: hit_sl = True
                                if active['leg'].get('side') == 'BUY' and node['low'] <= active['slPrice']: hit_sl = True
                                
                        if hit_sl:
                            active['state'] = 'STOPPED_OUT'
                            exit_price = active['slPrice']
                            current_trade = active['trades'][-1]
                            current_trade['exitTime'] = t
                            current_trade['exitPrice'] = exit_price
                            current_trade['exitReason'] = 'LEG_SL'
                            
                            pnl_diff = (active['entryPrice'] - exit_price) if active['leg'].get('side') == 'SELL' else (exit_price - active['entryPrice'])
                            trade_pnl = pnl_diff * active['qty']
                            current_trade['tradePnL'] = trade_pnl
                            
                            active['slHitMinute'] = t
                            active['lockedPnL'] += trade_pnl
                            current_open_pnl += active['lockedPnL']
                            current_close_pnl += active['lockedPnL']
                            active['minutePnLMap'][t] = active['lockedPnL']
                            
                            self.handle_reentry_setup(active, node, exit_price, t)
                            continue

                        # Active PnL calculation
                        open_pnl_diff = (active['entryPrice'] - node['open']) if active['leg'].get('side') == 'SELL' else (node['open'] - active['entryPrice'])
                        close_pnl_diff = (active['entryPrice'] - node['close']) if active['leg'].get('side') == 'SELL' else (node['close'] - active['entryPrice'])
                        
                        current_open_pnl += active['lockedPnL'] + (open_pnl_diff * active['qty'])
                        current_close_pnl += active['lockedPnL'] + (close_pnl_diff * active['qty'])
                        active['minutePnLMap'][t] = active['lockedPnL'] + (close_pnl_diff * active['qty'])
                        
                    elif active['state'] in ('WAITING_FOR_RECOST_RTP', 'WAITING_FOR_RESL_RTP', 'WAITING_FOR_REHIGH_RTP', 'WAITING_FOR_RELOW_RTP', 
                                             'WAITING_FOR_RECOST_MTP', 'WAITING_FOR_RESL_MTP', 'WAITING_FOR_REHIGH_MTP', 'WAITING_FOR_RELOW_MTP'):
                        prefix = active['state'].replace('WAITING_FOR_', '').split('_')[0]
                        did_cross, did_execute = self.check_rtp_mtp_crossing(active, t, node, prefix)
                        if did_execute:
                            # Added open_pnl, close_pnl via execute_entry inside check_rtp_mtp
                            open_pnl_diff = (active['entryPrice'] - node['open']) if active['leg'].get('side') == 'SELL' else (node['open'] - active['entryPrice'])
                            close_pnl_diff = (active['entryPrice'] - node['close']) if active['leg'].get('side') == 'SELL' else (node['close'] - active['entryPrice'])
                            current_open_pnl += active['lockedPnL'] + (open_pnl_diff * active['qty'])
                            current_close_pnl += active['lockedPnL'] + (close_pnl_diff * active['qty'])
                            active['minutePnLMap'][t] = active['lockedPnL'] + (close_pnl_diff * active['qty'])
                        else:
                            current_open_pnl += active['lockedPnL']
                            current_close_pnl += active['lockedPnL']
                            active['minutePnLMap'][t] = active['lockedPnL']
                            
                    elif active['state'] in ('WAITING_FOR_RE_ASAP', 'WAITING_FOR_LAZY'):
                        prefix = 'LAZY' if active['state'] == 'WAITING_FOR_LAZY' else 'ASAP'
                        self.handle_dynamic_reentry(active, t, node, prefix, index_chart_map, expiry, year, month, date_str, step)
                        
                        current_open_pnl += active['lockedPnL']
                        current_close_pnl += active['lockedPnL']
                        active['minutePnLMap'][t] = active['lockedPnL']
                        
                    elif active['state'] == 'STOPPED_OUT':
                        current_open_pnl += active['lockedPnL']
                        current_close_pnl += active['lockedPnL']
                        active['minutePnLMap'][t] = active['lockedPnL']

                    active['lastMinutePnL'] = active['minutePnLMap'].get(t, active['lockedPnL'])

                if sl_enabled:
                    sl_amount = sl_val * multiplier if self.config.get('overall_sl_type') == 'AMOUNT' else (daily_trade_value * sl_val / 100)
                    if current_open_pnl <= -sl_amount:
                        actual_exit_time = t
                        exit_reason = 'OVER_SL'
                        exit_at_open = True
                        break
                    if current_close_pnl <= -sl_amount:
                        actual_exit_time = t
                        exit_reason = 'OVER_SL'
                        exit_at_open = False
                        break
                        
                if target_enabled:
                    target_amount = target_val * multiplier if self.config.get('overall_target_type') == 'AMOUNT' else (daily_trade_value * target_val / 100)
                    if current_open_pnl >= target_amount:
                        actual_exit_time = t
                        exit_reason = 'OVER_TGT'
                        exit_at_open = True
                        break
                    if current_close_pnl >= target_amount:
                        actual_exit_time = t
                        exit_reason = 'OVER_TGT'
                        exit_at_open = False
                        break
                        
                daily_overall_pnl_chart.append({'time': t, 'pnl': current_close_pnl})

            if exit_reason == 'EXIT_TIME': exit_at_open = True
            daily_pnl = 0
            
            for active in active_legs:
                if active['state'] == 'ACTIVE' and len(active['trades']) > 0:
                    exit_node = active['chartMap'].get(actual_exit_time)
                    if not exit_node:
                        exit_node = next((c for c in active['optionDayChart'] if c['time'] >= actual_exit_time), active['optionDayChart'][-1])
                        
                    exit_price = exit_node['open'] if exit_at_open else exit_node['close']
                    current_trade = active['trades'][-1]
                    current_trade['exitTime'] = exit_node['time']
                    current_trade['exitPrice'] = exit_price
                    current_trade['exitReason'] = exit_reason
                    
                    pnl_diff = (current_trade['entryPrice'] - exit_price) if active['leg'].get('side') == 'SELL' else (exit_price - current_trade['entryPrice'])
                    current_trade['tradePnL'] = pnl_diff * active['qty']
                    active['lockedPnL'] += current_trade['tradePnL']
                    active['minutePnLMap'][current_trade['exitTime']] = active['lockedPnL']
                    
                daily_pnl += active['lockedPnL']
                
            matched_overall = next((x for x in daily_overall_pnl_chart if x['time'] == actual_exit_time), None)
            if matched_overall: matched_overall['pnl'] = daily_pnl
            
            for active in active_legs:
                for i, trade in enumerate(active['trades']):
                    trade_symbol = f"{active['targetStrike']}_{active['leg'].get('option_type')}"
                    trade_chart_ref = active['optionDayChart']
                    
                    for hist in active.get('historicalCharts', []):
                        if trade['entryTime'] < hist['endTime']:
                            trade_symbol = hist['key']
                            trade_chart_ref = hist['chart']
                            break
                            
                    self.results['trades'].append({
                        'date': date_str, 'leg_id': active['leg'].get('id'), 'symbol': trade_symbol,
                        'side': active['leg'].get('side'), 'entry_time': trade['entryTime'],
                        'entry_price': trade['entryPrice'], 'exit_time': trade['exitTime'],
                        'exit_price': trade['exitPrice'], 'exit_reason': trade['exitReason'],
                        'qty': active['qty'], 'pnl': trade['tradePnL'], 'trade_value': trade['tradeValue'],
                        'pnl_percent': (trade['tradePnL'] / trade['tradeValue'] * 100) if trade['tradeValue'] > 0 else 0
                    })
                    
                start_time = active.get('strikeStartTime', self.entry_time)
                baseline_pnl = active.get('strikeBaselinePnL', 0)
                
                filtered_chart = []
                for n in active['optionDayChart']:
                    if start_time <= n['time'] <= actual_exit_time:
                        pnl = active['minutePnLMap'].get(n['time'], 0) - baseline_pnl if n['time'] <= actual_exit_time else 0
                        new_n = dict(n)
                        new_n['pnl'] = pnl
                        filtered_chart.append(new_n)
                        
                for hist in active.get('historicalCharts', []):
                    day_chart[hist['key']] = hist['chart']
                day_chart[f"{active['targetStrike']}_{active['leg'].get('option_type')}"] = filtered_chart
                
            all_day_times = sorted(list(index_chart_map.keys()))
            full_day_overall = []
            for t in all_day_times:
                matched = next((x for x in daily_overall_pnl_chart if x['time'] == t), None)
                if matched: full_day_overall.append({'time': t, 'pnl': matched['pnl']})
                elif t < self.entry_time: full_day_overall.append({'time': t, 'pnl': 0})
                else: full_day_overall.append({'time': t, 'pnl': daily_pnl})
                
            day_chart['OVERALL_PNL'] = full_day_overall
            
            dte = 0
            curr = datetime.strptime(date_str, "%Y-%m-%d") + timedelta(days=1)
            exp_date = datetime.strptime(expiry, "%Y-%m-%d")
            while curr <= exp_date:
                t_str = curr.strftime("%Y-%m-%d")
                y, m = t_str.split('-')[:2]
                idx_file = os.path.join(MARKET_DATA_DIR, 'index', self.index_name, y, m, f"{t_str}.parquet")
                if os.path.exists(idx_file): dte += 1
                curr += timedelta(days=1)
                
            self.results['dailySummary'][date_str] = {
                'pnl': daily_pnl, 'trade_value': daily_trade_value,
                'pnl_percent': (daily_pnl / daily_trade_value * 100) if daily_trade_value > 0 else 0,
                'dte': dte, 'expiry': expiry
            }
            self.results['totalPnL'] += daily_pnl
            self.results['chartData'][date_str] = day_chart
