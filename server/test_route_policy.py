import importlib.util
import unittest
import json
import subprocess
import sys
import tempfile
from pathlib import Path
from cfsm_route_core import route_type, merge_candidate

spec = importlib.util.spec_from_file_location('forward', Path(__file__).with_name('cfsm-forward-route-update.py'))
forward = importlib.util.module_from_spec(spec)
spec.loader.exec_module(forward)

spec_ret = importlib.util.spec_from_file_location('returnroute', Path(__file__).with_name('cfsm-return-route.py'))
returnroute = importlib.util.module_from_spec(spec_ret)
spec_ret.loader.exec_module(returnroute)


def _trace(entries):
    """构造一份最小可用的 nexttrace -j 输出；entries 为 [(ttl, ip, country, asn)]。"""
    hops = []
    for ttl, ip, country, asn in entries:
        hops.append([{
            'TTL': ttl, 'Success': True, 'Address': {'IP': ip},
            'Geo': {'asnumber': str(asn), 'country': country, 'isp': 'test', 'owner': 'test'},
        }])
    return {'Hops': hops}


def _hop(ttl, ip, ok=True, country='', asn=None, tag=None):
    return {'ttl': ttl, 'ip': ip, 'ok': ok, 'country': country, 'asn': asn,
            'tag': tag, 'isp': '', 'owner': '', 'src': ''}

class RoutePolicyTests(unittest.TestCase):
    def test_node_capability_and_online_checks(self):
        node = {'enabled': True, 'runtime_state': 'online', 'capabilities': {'traceroute': True, 'ipv6': False}}
        self.assertTrue(forward.node_available(node, 'ipv4'))
        self.assertFalse(forward.node_available(node, 'ipv6'))
        node['runtime_state'] = 'offline'
        self.assertFalse(forward.node_available(node, 'ipv4'))

    def test_mobile_asn_does_not_infer_n2_from_name(self):
        self.assertEqual(route_type('mobile', ['58453']), 'CMI')
        self.assertEqual(route_type('mobile', ['58807']), 'CMIN2')
        self.assertEqual(route_type('mobile', ['9808']), 'CMNET')
        self.assertEqual(route_type('telecom', ['4809']), 'CN2')

    def test_partial_results_keep_other_carrier_clock(self):
        record = {'telecom': 'CN2', 'unicom': '9929', 'probed_at': '2026-10-01T00:00:00Z'}
        merge_candidate(record, 'telecom', None, '2026-10-03T00:00:00Z')
        merge_candidate(record, 'unicom', {'route': '9929', 'confidence': 'high'}, '2026-10-03T00:00:00Z')
        self.assertEqual(record['carrier_meta']['telecom']['probed_at'], '2026-10-01T00:00:00Z')
        self.assertEqual(record['carrier_meta']['unicom']['probed_at'], '2026-10-03T00:00:00Z')

    def test_downgrade_requires_two_daily_observations_despite_failure(self):
        record = {'telecom': 'CN2'}
        candidate = {'route': '普通国际', 'confidence': 'high'}
        self.assertFalse(merge_candidate(record, 'telecom', candidate, '2026-10-01T00:00:00Z'))
        self.assertFalse(merge_candidate(record, 'telecom', candidate, '2026-10-01T12:00:00Z'))
        # 中间一次探测失败不再清空已确认计数，次日同向观察即生效。
        merge_candidate(record, 'telecom', None, '2026-10-02T00:00:00Z')
        self.assertTrue(merge_candidate(record, 'telecom', candidate, '2026-10-03T00:00:00Z'))
        self.assertEqual(record['telecom'], '普通国际')

    def test_failure_keeps_reason_and_pending_counter(self):
        record = {'telecom': 'CN2'}
        candidate = {'route': '普通国际', 'confidence': 'high'}
        merge_candidate(record, 'telecom', candidate, '2026-10-01T00:00:00Z')
        merge_candidate(record, 'telecom',
                        {'route': None, 'reason': '中国侧证据不足，最长未响应 5 跳'},
                        '2026-10-02T00:00:00Z')
        meta = record['carrier_meta']['telecom']
        self.assertEqual(meta['status'], 'failed')
        self.assertEqual(meta['reason'], '中国侧证据不足，最长未响应 5 跳')
        self.assertEqual(meta['pending_count'], 1)

    def test_route_path_is_dropped_from_records(self):
        record = {'telecom': 'CN2',
                  'carrier_meta': {'telecom': {'route_path': 'AS4134 ×3 → AS4809'}}}
        merge_candidate(record, 'telecom', {'route': 'CN2', 'confidence': 'high'},
                        '2026-10-03T00:00:00Z')
        self.assertNotIn('route_path', record['carrier_meta']['telecom'])

    def test_retry_probes_the_same_target_and_merges(self):
        # 初次低置信（境内无证据 + 中间跳大面积不响应），重探必须打同一个 hostname。
        calls = []
        first = [(1, '8.8.8.8', '美国', 12345), (5, '9.9.9.9', '美国', 12346)]
        second = [(1, '8.8.8.8', '美国', 12345), (3, '7.7.7.7', '日本', 12347),
                  (5, '9.9.9.9', '美国', 12346)]

        def fake(host):
            calls.append(host)
            return True, _trace(second if len(calls) > 1 else first), ''

        original = returnroute.run_probe
        returnroute.run_probe = fake
        try:
            ev, err = returnroute.probe_carrier('telecom', 'zj-ct-v4.ip.zstaticcdn.com', '183.131.7.1')
        finally:
            returnroute.run_probe = original
        self.assertEqual(calls, ['zj-ct-v4.ip.zstaticcdn.com'] * 2)
        self.assertNotEqual(ev.get('retry_target'), 'fallback')
        self.assertEqual(err, '')
        # 两次采样按 TTL 取并集：第二次补齐的 TTL=3 跳应出现在合并结果里。
        self.assertEqual(ev['max_ttl'], 5)
        self.assertEqual(sorted(h['ttl'] for h in ev['public_hops']), [1, 3, 5])

    def test_fallback_target_is_used_only_when_first_probe_yields_nothing(self):
        calls = []

        def fake(host):
            calls.append(host)
            if host == '183.131.7.1':
                return True, _trace([(1, '183.131.7.1', '中国', 4134)]), ''
            return False, None, 'timeout>55s'

        original = returnroute.run_probe
        returnroute.run_probe = fake
        try:
            ev, err = returnroute.probe_carrier('telecom', 'zj-ct-v4.ip.zstaticcdn.com', '183.131.7.1')
        finally:
            returnroute.run_probe = original
        self.assertEqual(calls, ['zj-ct-v4.ip.zstaticcdn.com', '183.131.7.1'])
        self.assertEqual(ev['retry_target'], 'fallback')
        self.assertEqual(ev['dest_ip'], '183.131.7.1')
        self.assertEqual(err, '')

    def test_analyse_ignores_null_ttl_hops(self):
        ev = returnroute.analyse([_hop(None, '1.1.1.1', country='美国', asn=1),
                                  _hop(1, '8.8.8.8', country='美国', asn=2)])
        self.assertIsNotNone(ev)
        self.assertEqual(ev['max_ttl'], 1)

    def test_forward_failed_or_domestic_only_task_not_accepted(self):
        self.assertIsNone(forward.summarize({'success': False, 'data': {'hops': [{'asn': 'AS4809'}]}}, 'telecom'))
        self.assertIsNone(forward.summarize({'success': True, 'data': {'hops': [{'asn': 'AS4134'}, {'asn': 'AS136190'}]}}, 'telecom'))
        result = forward.summarize({'success': True, 'data': {'hops': [{'asn': 'AS4134'}, {'asn': 'AS4809'}, {'asn': 'AS21859'}]}}, 'telecom')
        self.assertEqual(result['route_type'], 'CN2')

class ShellRouteProtocolTests(unittest.TestCase):
    def helper(self, directory):
        installer = Path(__file__).parent.parent / 'public' / 'install.sh'
        source = installer.read_text().split("<<'ROUTE_PY'\n", 1)[1].split('\nROUTE_PY', 1)[0]
        for old, new in (
            ('/var/lib/cfsm-return-route/zhejiang.json', str(directory / 'v4.json')),
            ('/var/lib/cfsm-return-route/zhejiang-v6.json', str(directory / 'v6.json')),
            ('/var/lib/cfsm-forward-route/routes.json', str(directory / 'forward.json')),
        ):
            source = source.replace(old, new)
        output = subprocess.check_output([sys.executable, '-c', source], text=True)
        return json.loads('{' + output.strip() + '}')

    def test_shell_reads_all_route_fields_without_code_patches(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            (directory / 'v4.json').write_text('{"telecom":"CN2"}')
            (directory / 'v6.json').write_text('{"mobile":"CMIN2"}')
            (directory / 'forward.json').write_text('{"ipv4":{"unicom":"9929"}}')
            result = self.helper(directory)
            self.assertEqual(result['return_route']['telecom'], 'CN2')
            self.assertEqual(result['return_route_ipv6']['mobile'], 'CMIN2')
            self.assertEqual(result['forward_routes']['ipv4']['unicom'], '9929')

    def test_shell_omits_missing_malformed_empty_and_oversized_reports(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            self.assertEqual(self.helper(directory), {})
            (directory / 'v4.json').write_text('broken')
            (directory / 'v6.json').write_text('[]')
            (directory / 'forward.json').write_text('{}')
            self.assertEqual(self.helper(directory), {})
            (directory / 'v4.json').write_text(json.dumps({'telecom': 'x' * 65536}))
            self.assertEqual(self.helper(directory), {})

if __name__ == '__main__':
    unittest.main()
