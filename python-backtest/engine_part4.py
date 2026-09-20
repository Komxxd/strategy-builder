    def check_rtp_mtp_crossing(self, active, t, node, state_prefix):
        if active['leg'].get('no_reentry_on_sl_candle') and active.get('slHitMinute') == t:
            return False, False
            
        high = node['high']
        low = node['low']
        
        if active['state'] == f'WAITING_FOR_{state_prefix}_RTP':
            direction = active.get(f'{state_prefix.lower()}WaitDirection', 'UP')
            if state_prefix == 'REHIGH': rtp_crossed = (active['rtp'] <= active['rehighPeak'] and active['rtp'] >= node['close'])
            elif state_prefix == 'RELOW': rtp_crossed = (active['rtp'] >= active['relowLow'] and active['rtp'] <= node['close'])
            else:
                rtp_crossed = (low <= active['rtp']) if direction == 'DOWN' else (high >= active['rtp'])
                
            if rtp_crossed:
                if active['mtp'] is not None and active['mtp'] != active['rtp']:
                    active['state'] = f'WAITING_FOR_{state_prefix}_MTP'
                    idx = next((i for i, c in enumerate(active['optionDayChart']) if c['time'] == t), -1)
                    if idx != -1:
                        action_str = f"[RTP Hit] Waiting MTP: ₹{active['mtp']:.2f}"
                        active['optionDayChart'][idx]['action'] = active['optionDayChart'][idx]['action'] + ' | ' + action_str if active['optionDayChart'][idx]['action'] else action_str
                    return True, False
                else:
                    self.execute_entry(active, t, active['rtp'], node, f"RE-{state_prefix.replace('RE', '')}", True)
                    return True, True
                    
        elif active['state'] == f'WAITING_FOR_{state_prefix}_MTP':
            mtp_crossed = False
            if state_prefix in ('REHIGH', 'RELOW'):
                if active['mtp'] < active['rtp']: mtp_crossed = (node['low'] <= active['mtp'])
                else: mtp_crossed = (node['high'] >= active['mtp'])
            else:
                if active['mtp'] > active['rtp']: mtp_crossed = (high >= active['mtp'])
                else: mtp_crossed = (low <= active['mtp'])
                
            if mtp_crossed:
                self.execute_entry(active, t, active['mtp'], node, f"RE-{state_prefix.replace('RE', '')}", True)
                return True, True
                
        return False, False
