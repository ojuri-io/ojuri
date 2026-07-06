"""Regenerate metrics.json from an existing raw.jsonl.gz (post-hoc analysis
after metric definitions change; raw records are never modified).

Usage: python3 harness/recompute.py results/<scenario>"""

import gzip
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from harness import metrics


def main():
    out_dir = sys.argv[1]
    with gzip.open(os.path.join(out_dir, "raw.jsonl.gz"), "rt") as f:
        records = [json.loads(line) for line in f]
    result = metrics.compute(records)
    with open(os.path.join(out_dir, "metrics.json"), "w") as f:
        json.dump(result, f, indent=2)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
