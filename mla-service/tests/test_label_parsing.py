"""
`fraud_label = t.get('fraud_label') or t.get('fraudLabel')` collapses a
legitimate False/0 label through the `or` to the camelCase key and then
to None, so the label is discarded as "not yet labelled". Only fraud=True
labels would ever reach the drift window — F1 computed over a single
class, which `check_drift` then reports as 1.0 (no drift).
"""

from src.consumer.kafka_consumer import _first_present, extract_psi_features


class TestFirstPresent:
    def test_preserves_a_false_label(self):
        assert _first_present({"fraud_label": False}, "fraud_label", "fraudLabel") is False

    def test_preserves_a_zero_label(self):
        assert _first_present({"fraud_label": 0}, "fraud_label", "fraudLabel") == 0

    def test_preserves_a_true_label(self):
        assert _first_present({"fraud_label": True}, "fraud_label", "fraudLabel") is True

    def test_falls_through_to_the_camel_case_key(self):
        assert _first_present({"fraudLabel": False}, "fraud_label", "fraudLabel") is False

    def test_returns_none_when_genuinely_unlabelled(self):
        assert _first_present({"transaction_id": "t"}, "fraud_label", "fraudLabel") is None

    def test_prefers_the_first_key_when_both_are_present(self):
        payload = {"fraud_label": False, "fraudLabel": True}
        assert _first_present(payload, "fraud_label", "fraudLabel") is False

    def test_explicit_null_is_treated_as_unlabelled(self):
        assert _first_present({"fraud_label": None}, "fraud_label", "fraudLabel") is None

    def test_zero_probability_survives(self):
        assert (
            _first_present({"fraud_probability": 0.0}, "fraud_probability", "fraudProbability")
            == 0.0
        )


class TestPsiFeatureExtraction:
    def test_omits_absent_fields_rather_than_defaulting_them(self):
        assert extract_psi_features({"amount": 100}) == {"amount": 100.0}

    def test_keeps_a_genuine_zero(self):
        features = extract_psi_features({"amount": 0, "account_age_days": 0})
        assert features["amount"] == 0.0
        assert features["account_age_days"] == 0.0
