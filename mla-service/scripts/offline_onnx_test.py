"""
Run the deployed ONNX model with the EXACT feature snapshot that RDA
captured in decisionAuditLog. If the model returns a high score here
but RDA returns 0.13, the bug is in RDA's inference path. If both are
~0.13, the bug is in the model (e.g. converter dropped something).
"""

import json
import sys
from pathlib import Path

import numpy as np
import onnxruntime as ort

MODEL = Path(__file__).resolve().parent.parent.parent / "models" / "fraud_model.onnx"
CATALOG = Path(__file__).resolve().parent.parent.parent / "models" / "feature-catalog.v1.json"


def main():
    with open(CATALOG) as f:
        cat = json.load(f)
    feature_names = [feat["name"] for feat in cat["features"]]

    # Build a fraud vector matching the trainer's idea of fraud:
    # amount=850000, account_age_days=1, is_authenticated=0, ip_is_vpn=1
    # ip_country_mismatch=0 (matches what RDA computed)
    fraud_overrides = {
        "amount": 850000.0,
        "account_age_days": 1.0,
        "is_authenticated": 0.0,
        "channel_code": 4.0,
        "currency_code": 0.0,
        "ip_is_vpn": 1.0,
        "device_is_trusted": 0.0,
        "session_to_txn_seconds": 1.0,
        "ip_country_mismatch": 0.0,
        "transaction_type_code": 0.0,
        "is_inflow": 0.0,
    }
    legit_overrides = {
        "amount": 42.5,
        "account_age_days": 700.0,
        "is_authenticated": 1.0,
        "channel_code": 2.0,
        "currency_code": 0.0,
        "ip_is_vpn": 0.0,
        "device_is_trusted": 1.0,
        "session_to_txn_seconds": 60.0,
        "ip_country_mismatch": 0.0,
        "transaction_type_code": 0.0,
        "is_inflow": 0.0,
    }

    sess = ort.InferenceSession(str(MODEL))
    in_name = sess.get_inputs()[0].name
    out_names = [o.name for o in sess.get_outputs()]
    print(f"Model loaded: {MODEL}")
    print(f"  input: {sess.get_inputs()[0].shape}, output names: {out_names}")

    for label, overrides in [("legit", legit_overrides), ("fraud", fraud_overrides)]:
        vec = np.zeros((1, 64), dtype=np.float32)
        for k, v in overrides.items():
            if k in feature_names:
                vec[0, feature_names.index(k)] = float(v)
        outs = sess.run(out_names, {in_name: vec})
        # XGBoost-via-ONNX commonly returns [label, probabilities]
        print(f"\n[{label}]")
        for name, out in zip(out_names, outs):
            try:
                print(f"  {name}: {out}")
            except Exception:
                print(f"  {name}: <unprintable>")


if __name__ == "__main__":
    main()
