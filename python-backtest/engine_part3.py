    def execute_entry(self, active, t, price, node, reason, is_reentry=True):
        active['state'] = 'ACTIVE'
        if is_reentry: active['reentryCount'] += 1
        active['entryTime'] = t
        active['entryPrice'] = price
        active['slPrice'] = self.calculate_sl_price(active['leg'], active['entryPrice'], is_reentry)
        active['tslReferencePrice'] = active['entryPrice']
        
        trade_val = active['entryPrice'] * active['qty']
        active['trades'].append({
            'entryTime': active['entryTime'], 'entryPrice': active['entryPrice'],
            'exitTime': None, 'exitPrice': None, 'exitReason': None,
            'tradePnL': 0, 'tradeValue': trade_val, 'tradeSlPrice': active['slPrice']
        })
        
        idx = next((i for i, c in enumerate(active['optionDayChart']) if c['time'] == t), -1)
        if idx != -1:
            sl_str = f" | Init SL: ₹{active['slPrice']:.2f}" if active['slPrice'] is not None else ""
            entry_side = 'Sell' if active['leg'].get('side') == 'SELL' else 'Buy'
            prefix = "Re-Entry" if is_reentry else "Entry"
            action_str = f"{prefix} ({entry_side}) [{reason}]: {active['entryPrice']:.2f}{sl_str}"
            active['optionDayChart'][idx]['action'] = active['optionDayChart'][idx]['action'] + ' | ' + action_str if active['optionDayChart'][idx]['action'] else action_str
            
        open_pnl_diff = (active['entryPrice'] - node['open']) if active['leg'].get('side') == 'SELL' else (node['open'] - active['entryPrice'])
        close_pnl_diff = (active['entryPrice'] - node['close']) if active['leg'].get('side') == 'SELL' else (node['close'] - active['entryPrice'])
        
        return trade_val, open_pnl_diff * active['qty'], close_pnl_diff * active['qty']

    def handle_reentry_setup(self, active, node, exit_price, t):
        leg = active['leg']
        current_trade = active['trades'][-1]
        
        if leg.get('recost_enabled') and active['reentryCount'] < int(leg.get('max_reentry', 1)):
            active['state'] = 'WAITING_FOR_RECOST_RTP'
            mode = leg.get('recost_mode', 'RECOST_PLUS_PCT')
            val = float(leg.get('recost_value', 0))
            rtp = active['baseOtp']
            
            if mode == 'RECOST_PLUS_PCT': rtp += (rtp * val / 100)
            elif mode == 'RECOST_PLUS_PTS': rtp += val
            elif mode == 'RECOST_MINUS_PCT': rtp -= (rtp * val / 100)
            elif mode == 'RECOST_MINUS_PTS': rtp -= val
            
            active['rtp'] = self.round_to_tick(rtp)
            active['recostWaitDirection'] = 'DOWN' if active['slPrice'] > active['rtp'] else 'UP'
            current_trade['reentryCalcStr'] = f"Calc RTP: ₹{active['rtp']:.2f}"
            
            if leg.get('recost_mntm_enabled'):
                m_mode = leg.get('recost_mntm_mode', 'RECOST_PLUS_PCT')
                m_val = float(leg.get('recost_mntm_value', 0))
                mtp = active['rtp']
                if m_mode == 'RECOST_PLUS_PCT': mtp += (mtp * m_val / 100)
                elif m_mode == 'RECOST_PLUS_PTS': mtp += m_val
                elif m_mode == 'RECOST_MINUS_PCT': mtp -= (mtp * m_val / 100)
                elif m_mode == 'RECOST_MINUS_PTS': mtp -= m_val
                active['mtp'] = self.round_to_tick(mtp)
                current_trade['reentryCalcStr'] += f" | Calc MTP: ₹{active['mtp']:.2f}"
            else:
                active['mtp'] = None
                
        elif leg.get('resl_enabled') and active['reentryCount'] < int(leg.get('max_reentry', 1)):
            if active['reentryCount'] == 0 or 'reslRtpLocked' not in active:
                mode = leg.get('resl_mode', 'RESL_PLUS_PCT')
                val = float(leg.get('resl_value', 0))
                resl_target = active['slPrice']
                
                if mode == 'RESL_PLUS_PCT': resl_target += (resl_target * val / 100)
                elif mode == 'RESL_PLUS_PTS': resl_target += val
                elif mode == 'RESL_MINUS_PCT': resl_target -= (resl_target * val / 100)
                elif mode == 'RESL_MINUS_PTS': resl_target -= val
                
                active['reslRtpLocked'] = self.round_to_tick(resl_target)
                
                if leg.get('resl_mntm_enabled'):
                    m_mode = leg.get('resl_mntm_mode', 'RESL_PLUS_PCT')
                    m_val = float(leg.get('resl_mntm_value', 0))
                    mtp = active['reslRtpLocked']
                    if 'PLUS_PCT' in m_mode or m_mode == 'PERCENTAGE': mtp += (mtp * m_val / 100)
                    elif 'PLUS_PTS' in m_mode or m_mode == 'POINTS': mtp += m_val
                    elif 'MINUS_PCT' in m_mode: mtp -= (mtp * m_val / 100)
                    elif 'MINUS_PTS' in m_mode: mtp -= m_val
                    active['reslMtpLocked'] = self.round_to_tick(mtp)
                else:
                    active['reslMtpLocked'] = None
                    
            active['rtp'] = active['reslRtpLocked']
            active['mtp'] = active['reslMtpLocked']
            active['state'] = 'WAITING_FOR_RESL_RTP'
            active['reslWaitDirection'] = 'DOWN' if active['slPrice'] > active['rtp'] else 'UP'
            
        elif leg.get('rehigh_enabled') and active['reentryCount'] < int(leg.get('max_reentry', 1)):
            active['rehighPeak'] = exit_price
            if node['close'] > active['rehighPeak']: active['rehighPeak'] = node['close']
            active['state'] = 'WAITING_FOR_REHIGH_RTP'
            
            mode = leg.get('rehigh_mode', 'REHIGH_MINUS_PTS')
            val = float(leg.get('rehigh_value', 0))
            rtp = active['rehighPeak']
            if mode == 'REHIGH_MINUS_PCT': rtp -= (rtp * val / 100)
            elif mode == 'REHIGH_MINUS_PTS': rtp -= val
            active['rtp'] = self.round_to_tick(rtp)
            
            if leg.get('rehigh_mntm_enabled'):
                m_mode = leg.get('rehigh_mntm_mode', 'REHIGH_PLUS_PCT')
                m_val = float(leg.get('rehigh_mntm_value', 0))
                mtp = active['rtp']
                if m_mode in ('REHIGH_PLUS_PCT', 'PLUS_PCT', 'PERCENTAGE'): mtp += (mtp * m_val / 100)
                elif m_mode in ('REHIGH_PLUS_PTS', 'PLUS_PTS', 'POINTS'): mtp += m_val
                elif m_mode in ('REHIGH_MINUS_PCT', 'MINUS_PCT'): mtp -= (mtp * m_val / 100)
                elif m_mode in ('REHIGH_MINUS_PTS', 'MINUS_PTS'): mtp -= m_val
                active['mtp'] = self.round_to_tick(mtp)
            else:
                active['mtp'] = None
                
        elif leg.get('relow_enabled') and active['reentryCount'] < int(leg.get('max_reentry', 1)):
            active['relowLow'] = exit_price
            if node['close'] < active['relowLow']: active['relowLow'] = node['close']
            active['state'] = 'WAITING_FOR_RELOW_RTP'
            
            mode = leg.get('relow_mode', 'RELOW_PLUS_PTS')
            val = float(leg.get('relow_value', 0))
            rtp = active['relowLow']
            if mode == 'RELOW_PLUS_PCT': rtp += (rtp * val / 100)
            elif mode == 'RELOW_PLUS_PTS': rtp += val
            active['rtp'] = self.round_to_tick(rtp)
            
            if leg.get('relow_mntm_enabled'):
                m_mode = leg.get('relow_mntm_mode', 'RELOW_PLUS_PCT')
                m_val = float(leg.get('relow_mntm_value', 0))
                mtp = active['rtp']
                if m_mode in ('RELOW_PLUS_PCT', 'PLUS_PCT', 'PERCENTAGE'): mtp += (mtp * m_val / 100)
                elif m_mode in ('RELOW_PLUS_PTS', 'PLUS_PTS', 'POINTS'): mtp += m_val
                elif m_mode in ('RELOW_MINUS_PCT', 'MINUS_PCT'): mtp -= (mtp * m_val / 100)
                elif m_mode in ('RELOW_MINUS_PTS', 'MINUS_PTS'): mtp -= m_val
                active['mtp'] = self.round_to_tick(mtp)
            else:
                active['mtp'] = None
