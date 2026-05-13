import Graph from "graphology";
import pagerank from "graphology-metrics/centrality/pagerank";
import louvain from "graphology-communities-louvain";
import appConfig from "@config/app.config";
import { createServiceLogger, TraceContext } from "@utils/service-logger";
import { metricsService } from "@utils/metrics";
import { TransactionEvent, NetworkFeatures } from "./types";

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
  private readonly maxNodes: number;
  private readonly pagerankDamping: number;
  private readonly updateInterval: number;

  constructor() {
    this.graph = new Graph<NodeAttributes, EdgeAttributes>({ type: "directed", multi: false });
    this.maxNodes = appConfig.paa.maxGraphNodes;
    this.pagerankDamping = appConfig.paa.pagerankDamping;
    this.updateInterval = appConfig.paa.graphUpdateInterval;
  }

  addTransaction(event: TransactionEvent): void {
    const { sender_id, receiver_id, amount, timestamp, transaction_type } = event;

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
        this.pruneOldNodes();
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
    }
  }

  private shouldUpdatePagerank(): boolean {
    const timeSinceLastUpdate = Date.now() - this.lastPagerankUpdate;
    const transactionsSinceLastUpdate = this.transactionCount % 100;
    return timeSinceLastUpdate > this.updateInterval || transactionsSinceLastUpdate === 0;
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

  private pruneOldNodes(): void {
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const nodesToRemove: string[] = [];

    this.graph.forEachNode((node, attrs) => {
      if (attrs.lastSeen < thirtyDaysAgo) {
        nodesToRemove.push(node);
      }
    });

    nodesToRemove
      .sort((a, b) => {
        const attrsA = this.graph.getNodeAttributes(a);
        const attrsB = this.graph.getNodeAttributes(b);
        return attrsA.lastSeen - attrsB.lastSeen;
      })
      .slice(0, Math.floor(this.maxNodes * 0.1))
      .forEach((node) => {
        this.graph.dropNode(node);
      });

    log.info("pruneOldNodes", "Pruned old nodes from graph", { nodesRemoved: nodesToRemove.length });
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
