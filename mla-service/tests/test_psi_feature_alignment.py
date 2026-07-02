"""
PSI monitoring only works when the consumer's feature names align with
the baseline distributions, which are keyed by catalogue feature name.
The pre-fix consumer fed a hardcoded dict of fields the TransactionEvent
does not carry (velocity_*, pagerank), defaulted to 0 — poisoning the
windows with fabricated constants under names the baseline partly
didn't recognise.
"""

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from src.consumer.kafka_consumer import PSI_FEATURE_FIELDS, extract_psi_features

CATALOG_PATH = os.path.join(
    os.path.dirname(__file__), '..', '..', 'models', 'feature-catalog.v1.json'
)


class TestPsiFeatureAlignment:

    def test_psi_fields_exist_in_feature_catalog(self):
        with open(CATALOG_PATH) as f:
            catalog_names = {feature['name'] for feature in json.load(f)['features']}

        for field in PSI_FEATURE_FIELDS:
            assert field in catalog_names, f"'{field}' is not a catalogue feature name"

    def test_absent_fields_are_omitted_not_defaulted(self):
        features = extract_psi_features({'amount': 5000})

        assert features == {'amount': 5000.0}
        assert 'account_age_days' not in features
        assert 'session_to_txn_seconds' not in features

    def test_present_fields_are_coerced_to_float(self):
        features = extract_psi_features({
            'amount': '2500.50',
            'account_age_days': 120,
            'session_to_txn_seconds': 4.2,
        })

        assert features == {
            'amount': 2500.5,
            'account_age_days': 120.0,
            'session_to_txn_seconds': 4.2,
        }

    def test_unparseable_values_are_skipped(self):
        features = extract_psi_features({'amount': 'not-a-number', 'account_age_days': 30})

        assert features == {'account_age_days': 30.0}
