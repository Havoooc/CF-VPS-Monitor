import importlib.util
import unittest
from pathlib import Path
from cfsm_route_core import route_type, merge_candidate

spec = importlib.util.spec_from_file_location('forward', Path(__file__).with_name('cfsm-forward-route-update.py'))
forward = importlib.util.module_from_spec(spec)
spec.loader.exec_module(forward)

class RoutePolicyTests(unittest.TestCase):
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

    def test_downgrade_requires_two_observations_and_failure_resets(self):
        record = {'telecom': 'CN2'}
        candidate = {'route': '普通国际', 'confidence': 'high'}
        self.assertFalse(merge_candidate(record, 'telecom', candidate, '2026-10-01T00:00:00Z'))
        self.assertFalse(merge_candidate(record, 'telecom', candidate, '2026-10-01T12:00:00Z'))
        merge_candidate(record, 'telecom', None, '2026-10-02T00:00:00Z')
        self.assertFalse(merge_candidate(record, 'telecom', candidate, '2026-10-03T00:00:00Z'))
        self.assertTrue(merge_candidate(record, 'telecom', candidate, '2026-10-04T00:00:00Z'))

    def test_forward_failed_or_domestic_only_task_not_accepted(self):
        self.assertIsNone(forward.summarize({'success': False, 'data': {'hops': [{'asn': 'AS4809'}]}}, 'telecom'))
        self.assertIsNone(forward.summarize({'success': True, 'data': {'hops': [{'asn': 'AS4134'}, {'asn': 'AS136190'}]}}, 'telecom'))
        result = forward.summarize({'success': True, 'data': {'hops': [{'asn': 'AS4134'}, {'asn': 'AS4809'}, {'asn': 'AS21859'}]}}, 'telecom')
        self.assertEqual(result['route_type'], 'CN2')

if __name__ == '__main__':
    unittest.main()
