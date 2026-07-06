"""Read-only observation of PAA state for Track 4.

Reads the same Redis keys RDA reads (features:{userId}) plus the
graphMetadata Postgres table PAA maintains. Observation only -- nothing
is written. Both stores are documented inter-service interfaces, not
private internals, but note in the report that adopters cannot see
community IDs through any public HTTP API.
"""

import subprocess

REDIS_FIELDS = ["graph_community_id", "graph_pagerank", "graph_in_degree",
                "graph_out_degree", "graph_clustering_coef", "velocity_1h"]


def _compose_exec(args, timeout=20):
    return subprocess.run(["docker", "compose", "exec", "-T"] + args,
                          capture_output=True, text=True, timeout=timeout).stdout


def redis_features(user_ids):
    cmds = "\n".join(f"HMGET features:{u} {' '.join(REDIS_FIELDS)}" for u in user_ids)
    out = subprocess.run(
        ["docker", "compose", "exec", "-T", "redis", "redis-cli"],
        input=cmds, capture_output=True, text=True, timeout=20).stdout
    lines = out.splitlines()
    result = {}
    per_user = len(REDIS_FIELDS)
    for i, u in enumerate(user_ids):
        chunk = lines[i * per_user:(i + 1) * per_user]
        vals = {}
        for field, raw in zip(REDIS_FIELDS, chunk):
            raw = raw.strip().strip('"')
            vals[field] = None if raw in ("", "(nil)") else raw
        result[u] = vals
    return result


def pg_community(user_ids):
    ids = ",".join(f"'{u}'" for u in user_ids)
    sql = (f'SELECT "userId", "communityId", pagerank, "inDegree", "outDegree" '
           f'FROM "graphMetadata" WHERE "userId" IN ({ids});')
    out = _compose_exec(["postgres", "psql", "-U", "postgres", "-d", "fraud_db",
                         "-tA", "-F", "|", "-c", sql])
    result = {}
    for line in out.splitlines():
        parts = line.strip().split("|")
        if len(parts) == 5:
            result[parts[0]] = {"communityId": parts[1], "pagerank": parts[2],
                                "inDegree": parts[3], "outDegree": parts[4]}
    return result
