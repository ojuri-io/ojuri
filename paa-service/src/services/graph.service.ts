import Graph from "graphology";
import pagerank from "graphology-metrics/centrality/pagerank";
import louvain from "graphology-communities-louvain";
import appConfig from "@config/app.config";
import { createServiceLogger, TraceContext } from "@utils/service-logger";
import { metricsService } from "@utils/metrics";
import { TransactionEvent, NetworkFeatures, NodeSnapshot, EdgeSnapshot } from "./types";

const log = createServiceLogger("GraphService");

interface NodeAttributes {
  firstSeen: number;
  lastSeen: number;
  transactionCount: number;
  totalAmount: number;
  pagerank?: number;
  clusteringCoef?: number;
  communityId?: number;
}

interface EdgeAttributes {
  weight: number;
  totalAmount: number;
  lastTransaction: number;
  firstTransaction: number;
  transactionTypes: Set<string>;
}

class GraphService {
  private graph: Graph<NodeAttributes, EdgeAttributes>;
  private transactionCount: number = 0;
  private lastPagerankUpdate: number = 0;
  private maxEventTimestamp: number = 0;
  private dirtyTriangleCount: number = 0;
  private readonly maxNodes: number;
  private readonly pagerankDamping: number;
  private readonly updateInterval: number;
  private readonly triangleRecomputeMinIntervalMs: number;
  private readonly pruneAgeMs = 30 * 24 * 60 * 60 * 1000;
  private readonly pruneIntervalMs = 60 * 60 * 1000;

  constructor() {
    this.graph = new Graph<NodeAttributes, EdgeAttributes>({ type: "directed", multi: false });
    this.maxNodes = appConfig.paa.maxGraphNodes;
    this.pagerankDamping = appConfig.paa.pagerankDamping;
    this.updateInterval = appConfig.paa.graphUpdateInterval;
    this.triangleRecomputeMinIntervalMs = appConfig.paa.triangleRecomputeMinIntervalMs;
    this.startScheduledPrune();
  }

  addTransaction(event: TransactionEvent): void {
    const { sender_id, receiver_id, amount, timestamp, transaction_type } = event;

    if (timestamp > this.maxEventTimestamp) {
      this.maxEventTimestamp = timestamp;
    }

    this.ensureNode(sender_id, timestamp);
    this.ensureNode(receiver_id, timestamp);
    this.updateNodeStats(sender_id, amount, timestamp);
    this.addOrUpdateEdge(sender_id, receiver_id, amount, timestamp, transaction_type);

    this.transactionCount++;

    if (this.shouldUpdatePagerank()) {
      this.computeNetworkMetrics();
    }

    metricsService.updateGraphSize(this.graph.order, this.graph.size);
  }

  private ensureNode(nodeId: string, timestamp: number): void {
    if (!this.graph.hasNode(nodeId)) {
      if (this.graph.order >= this.maxNodes) {
        this.pruneOldNodes({ capDriven: true });
      }

      this.graph.addNode(nodeId, {
        firstSeen: timestamp,
        lastSeen: timestamp,
        transactionCount: 0,
        totalAmount: 0,
      });
    }
  }

  private updateNodeStats(nodeId: string, amount: number, timestamp: number): void {
    const attrs = this.graph.getNodeAttributes(nodeId);
    this.graph.setNodeAttribute(nodeId, "lastSeen", timestamp);
    this.graph.setNodeAttribute(nodeId, "transactionCount", attrs.transactionCount + 1);
    this.graph.setNodeAttribute(nodeId, "totalAmount", attrs.totalAmount + amount);
  }

  private addOrUpdateEdge(
    sender: string,
    receiver: string,
    amount: number,
    timestamp: number,
    transactionType: string
  ): void {
    if (this.graph.hasEdge(sender, receiver)) {
      const attrs = this.graph.getEdgeAttributes(sender, receiver);
      this.graph.setEdgeAttribute(sender, receiver, "weight", attrs.weight + 1);
      this.graph.setEdgeAttribute(sender, receiver, "totalAmount", attrs.totalAmount + amount);
      this.graph.setEdgeAttribute(sender, receiver, "lastTransaction", timestamp);
      attrs.transactionTypes.add(transactionType);
    } else {
      this.graph.addEdge(sender, receiver, {
        weight: 1,
        totalAmount: amount,
        lastTransaction: timestamp,
        firstTransaction: timestamp,
        transactionTypes: new Set([transactionType]),
      });
      if (this.closesDirectedTriangle(sender, receiver)) {
        this.dirtyTriangleCount++;
      }
    }
  }

  // Detects a fresh directed 3-cycle through the newly-added edge A→B.
  // The cycle exists iff some node C has both B→C and C→A. Walking
  // B's out-neighbors is bounded by B's out-degree, which is small
  // for typical accounts and capped by graph order in pathological
  // cases. Early-exits on the first match — we only need to know
  // *if* a triangle exists, not enumerate them.
  private closesDirectedTriangle(a: string, b: string): boolean {
    let found = false;
    this.graph.forEachOutNeighbor(b, (c) => {
      if (found) return;
      if (c !== a && this.graph.hasEdge(c, a)) {
        found = true;
      }
    });
    return found;
  }

  private shouldUpdatePagerank(): boolean {
    const now = Date.now();
    const timeSinceLastUpdate = now - this.lastPagerankUpdate;

    if (timeSinceLastUpdate > this.updateInterval) return true;
    if (this.transactionCount > 0 && this.transactionCount % 100 === 0) return true;

    if (
      this.dirtyTriangleCount > 0 &&
      timeSinceLastUpdate >= this.triangleRecomputeMinIntervalMs
    ) {
      return true;
    }

    return false;
  }

  computeNetworkMetrics(): void {
    if (this.graph.order === 0) return;

    const startTime = Date.now();

    try {
      const pagerankScores = pagerank(this.graph, {
        alpha: this.pagerankDamping,
        maxIterations: 100,
        tolerance: 1e-6,
        getEdgeWeight: (_, attrs) => attrs.weight || 1,
      });

      this.graph.forEachNode((node) => {
        this.graph.setNodeAttribute(node, "pagerank", pagerankScores[node] || 0);
      });

      this.graph.forEachNode((node) => {
        try {
          const coef = this.calculateLocalClusteringCoefficient(node);
          this.graph.setNodeAttribute(node, "clusteringCoef", coef);
        } catch {
          this.graph.setNodeAttribute(node, "clusteringCoef", 0);
        }
      });

      const communities = louvain(this.graph);
      this.graph.forEachNode((node) => {
        this.graph.setNodeAttribute(node, "communityId", communities[node] || 0);
      });

      this.lastPagerankUpdate = Date.now();
      this.dirtyTriangleCount = 0;
      const computeTime = Date.now() - startTime;

      metricsService.recordPagerankComputeTime(computeTime);

      log.success("computeNetworkMetrics", "Network metrics computed", {
        nodes: this.graph.order,
        edges: this.graph.size,
        computeTimeMs: computeTime,
      });
    } catch (err) {
      log.error("computeNetworkMetrics", "Failed to compute network metrics", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private calculateLocalClusteringCoefficient(node: string): number {
    const neighbors = this.graph.neighbors(node);
    const k = neighbors.length;

    if (k < 2) return 0;

    let triangles = 0;
    for (let i = 0; i < neighbors.length; i++) {
      for (let j = i + 1; j < neighbors.length; j++) {
        if (
          this.graph.hasEdge(neighbors[i], neighbors[j]) ||
          this.graph.hasEdge(neighbors[j], neighbors[i])
        ) {
          triangles++;
        }
      }
    }

    const possibleTriangles = (k * (k - 1)) / 2;
    return triangles / possibleTriangles;
  }

  getNodeSnapshot(userId: string): NodeSnapshot | null {
    if (!this.graph.hasNode(userId)) return null;
    const attrs = this.graph.getNodeAttributes(userId);
    const features = this.getNetworkFeatures(userId);
    return {
      ...features,
      firstSeen: attrs.firstSeen,
      lastSeen: attrs.lastSeen,
      transactionCount: attrs.transactionCount,
      totalAmount: attrs.totalAmount,
    };
  }

  getEdgeSnapshot(sender: string, receiver: string): EdgeSnapshot | null {
    if (!this.graph.hasEdge(sender, receiver)) return null;
    const attrs = this.graph.getEdgeAttributes(sender, receiver);
    return {
      senderId: sender,
      receiverId: receiver,
      weight: attrs.weight,
      totalAmount: attrs.totalAmount,
      firstTransaction: attrs.firstTransaction,
      lastTransaction: attrs.lastTransaction,
      transactionTypes: Array.from(attrs.transactionTypes),
    };
  }

  // Bulk hydration entry point used by PAA at boot. Re-creates the
  // edge structure (with attributes) without going through the normal
  // metric-recompute path; the caller is expected to run
  // computeNetworkMetrics() once at the end.
  hydrateEdges(edges: EdgeSnapshot[]): void {
    for (const e of edges) {
      if (!this.graph.hasNode(e.senderId)) {
        this.graph.addNode(e.senderId, {
          firstSeen: e.firstTransaction,
          lastSeen: e.lastTransaction,
          transactionCount: 0,
          totalAmount: 0,
        });
      }
      if (!this.graph.hasNode(e.receiverId)) {
        this.graph.addNode(e.receiverId, {
          firstSeen: e.firstTransaction,
          lastSeen: e.lastTransaction,
          transactionCount: 0,
          totalAmount: 0,
        });
      }
      if (!this.graph.hasEdge(e.senderId, e.receiverId)) {
        this.graph.addEdge(e.senderId, e.receiverId, {
          weight: e.weight,
          totalAmount: e.totalAmount,
          firstTransaction: e.firstTransaction,
          lastTransaction: e.lastTransaction,
          transactionTypes: new Set(e.transactionTypes),
        });
      }
      if (e.lastTransaction > this.maxEventTimestamp) {
        this.maxEventTimestamp = e.lastTransaction;
      }
    }
  }

  hydrateNodeState(nodes: Array<{ userId: string } & Partial<{ firstSeen: number; lastSeen: number; transactionCount: number; totalAmount: number }>>): void {
    for (const n of nodes) {
      if (!this.graph.hasNode(n.userId)) continue;
      const attrs = this.graph.getNodeAttributes(n.userId);
      if (n.firstSeen !== undefined && (attrs.firstSeen === 0 || n.firstSeen < attrs.firstSeen)) {
        this.graph.setNodeAttribute(n.userId, "firstSeen", n.firstSeen);
      }
      if (n.lastSeen !== undefined && n.lastSeen > attrs.lastSeen) {
        this.graph.setNodeAttribute(n.userId, "lastSeen", n.lastSeen);
      }
      if (n.transactionCount !== undefined) {
        this.graph.setNodeAttribute(n.userId, "transactionCount", n.transactionCount);
      }
      if (n.totalAmount !== undefined) {
        this.graph.setNodeAttribute(n.userId, "totalAmount", n.totalAmount);
      }
    }
  }

  getNetworkFeatures(userId: string): NetworkFeatures {
    if (!this.graph.hasNode(userId)) {
      return {
        pagerank: 0,
        clusteringCoef: 0,
        communityId: 0,
        degreeCentrality: 0,
        inDegree: 0,
        outDegree: 0,
      };
    }

    const attrs = this.graph.getNodeAttributes(userId);
    const inDegree = this.graph.inDegree(userId);
    const outDegree = this.graph.outDegree(userId);
    const maxDegree = Math.max(this.graph.order - 1, 1);

    return {
      pagerank: attrs.pagerank || 0,
      clusteringCoef: attrs.clusteringCoef || 0,
      communityId: attrs.communityId || 0,
      degreeCentrality: (inDegree + outDegree) / (2 * maxDegree),
      inDegree,
      outDegree,
    };
  }

  private pruneOldNodes(opts: { capDriven: boolean } = { capDriven: false }): void {
    if (this.maxEventTimestamp === 0) return;

    const cutoff = this.maxEventTimestamp - this.pruneAgeMs;
    const nodesToRemove: string[] = [];

    this.graph.forEachNode((node, attrs) => {
      if (attrs.lastSeen < cutoff) {
        nodesToRemove.push(node);
      }
    });

    const ordered = nodesToRemove.sort((a, b) => {
      return this.graph.getNodeAttributes(a).lastSeen - this.graph.getNodeAttributes(b).lastSeen;
    });

    // Cap-driven prunes only drop the oldest 10% to free room; the
    // scheduled prune drops everything past the cutoff because it's
    // bounded by traffic shape, not graph size.
    const toDrop = opts.capDriven ? ordered.slice(0, Math.floor(this.maxNodes * 0.1)) : ordered;

    for (const node of toDrop) {
      this.graph.dropNode(node);
    }

    if (toDrop.length > 0) {
      log.info("pruneOldNodes", "Pruned old nodes from graph", {
        nodesRemoved: toDrop.length,
        eligible: nodesToRemove.length,
        cutoff,
        capDriven: opts.capDriven,
      });
    }
  }

  private startScheduledPrune(): void {
    setInterval(() => {
      this.pruneOldNodes();
    }, this.pruneIntervalMs);
  }

  getStats(): { nodes: number; edges: number; transactionCount: number } {
    return {
      nodes: this.graph.order,
      edges: this.graph.size,
      transactionCount: this.transactionCount,
    };
  }
}

export const graphService = new GraphService();
export default GraphService;
