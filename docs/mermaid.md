Figure 1 — System overview
---
config:
  theme: mc
---
flowchart TB
    Client(["Mobile Money Client"])

    Client -->|HTTP POST /predict| RDA
    RDA -->|Accept / Decline| Client

    subgraph S1 ["Service 1: Real-Time Detection"]
        RDA["Real-Time Detection Agent"]
        ONNX["XGBoost Model via ONNX Runtime"]
        RDA --> ONNX
    end

    Redis[("Redis Feature Cache")]

    RDA <-->|Feature lookup| Redis
    RDA -->|Async publish| Kafka

    Kafka[["Apache Kafka Event Bus"]]

    subgraph S2 ["Service 2: Pattern Analysis"]
        PAA["Pattern Analysis Agent"]
        Graph["Graph Analytics & Velocity Metrics"]
        PAA --> Graph
    end

    subgraph S3 ["Service 3: Model Learning"]
        MLA["Model Learning Agent"]
        Drift["Concept Drift Detection"]
        Train["XGBoost Retraining"]
        Conv["ONNX Export"]
        MLA --> Drift --> Train --> Conv
    end

    subgraph S4 ["Service 4: Fraud Investigation  ✦ New"]
        FIA["Fraud Investigation Agent"]
        LLM["Fine-tuned Phi-3-mini via LoRA"]
        FIA --> LLM
    end

    Kafka --> PAA
    Kafka --> MLA
    Kafka -->|transactions.blocked| FIA

    Graph -->|Refresh features| Redis
    Conv -->|Push versioned model| Registry
    LLM -->|Store investigation reports| PG
    MLA -->|Query labeled data| PG
    PAA -->|Store graph metadata| PG
    Registry -->|Hot-swap model| RDA

    Registry[("Model Registry - MinIO")]
    PG[("PostgreSQL 14")]

    style S4 fill:#FAECE7,stroke:#993C1D,stroke-width:2px,color:#4A1B0C
    style FIA fill:#FAECE7,stroke:#D85A30,stroke-width:1px,color:#4A1B0C
    style LLM fill:#F5C4B3,stroke:#D85A30,stroke-width:1px,color:#4A1B0C

Figure 2

flowchart TB
    Client([Mobile Money Client])
    
    Client -->|"POST /v1/predict"| Parse["<b>Step 1: Schema Validation</b><br/>Fastify + ajv validator<br/>ReDoS protection<br/><b>~0.1 ms</b>"]
    
    Parse -->|"Valid"| Redis["<b>Step 2: Redis Lookup</b><br/>Feature cache retrieval<br/><b>~0.5 ms</b>"]
    Parse -->|"Invalid Schema"| Reject400["HTTP 400<br/>Bad Request<br/>Malformed payload"]
    
    Redis -->|"Success"| Assemble["<b>Step 3: Feature Assembly</b><br/>Vector construction<br/><b>~0.05 ms</b>"]
    Redis -->|"Timeout/Error"| CB_Redis{"Circuit Breaker:<br/>Redis Failure"}
    
    CB_Redis -->|"Fallback"| DefaultFeatures["Load Default Features<br/>Historical averages<br/>Degraded mode"]
    DefaultFeatures --> Assemble
    
    Assemble --> Inference["<b>Step 4: ONNX Inference</b><br/>XGBoost prediction<br/><b>0.01 ms p50, 0.05 ms p99</b>"]
    
    Inference -->|"Success"| Threshold{"<b>Step 5: Threshold</b><br/>fraud_prob >= 0.65?<br/><b><1µs</b>"}
    Inference -->|"Model Failure"| CB_Model{"Circuit Breaker:<br/>Model Failure"}
    
    CB_Model -->|"Policy: Fail Closed"| FailClosed["<b>FAIL CLOSED</b><br/>Decline transaction<br/>Log alert"]
    
    Threshold -->|"Yes"| DeclineResponse["<b>Step 6: DECLINE</b><br/>fraud: true<br/>also publish to<br/>transactions.blocked<br/><b>~0.1 ms</b>"]
    Threshold -->|"No"| AcceptResponse["<b>Step 6: ACCEPT</b><br/>fraud: false<br/><b>~0.1 ms</b>"]
    
    DeclineResponse --> Client
    AcceptResponse --> Client
    FailClosed --> Client
    Reject400 --> Client
    
    Inference -.->|"Async Non-blocking"| KafkaPublish["Kafka Producer<br/>Circuit breaker: 3 retries<br/>Then log to disk"]
    
    subgraph Resilience ["<b>Fault Tolerance Mechanisms</b>"]
        CB_Redis
        CB_Model
        DefaultFeatures
        FailClosed
    end
    
    subgraph HappyPath ["<b>Happy Path: ~1.2 ms p50, ~4 ms p99 (measured E2E)</b>"]
        Parse
        Redis
        Assemble
        Inference
        Threshold
        AcceptResponse
    end
    
    style Parse fill:#bbdefb,stroke:#1976d2,stroke-width:2px
    style Redis fill:#c8e6c9,stroke:#388e3c,stroke-width:2px
    style Assemble fill:#ffe0b2,stroke:#f57c00,stroke-width:2px
    style Inference fill:#f8bbd0,stroke:#c2185b,stroke-width:3px
    style Threshold fill:#e1bee7,stroke:#7b1fa2,stroke-width:2px
    style DeclineResponse fill:#ffcdd2,stroke:#d32f2f,stroke-width:2px
    style AcceptResponse fill:#c8e6c9,stroke:#388e3c,stroke-width:2px
    style FailClosed fill:#ff6f00,stroke:#e65100,stroke-width:3px
    style Reject400 fill:#ffccbc,stroke:#bf360c,stroke-width:2px
    style CB_Redis fill:#fff59d,stroke:#f57f17,stroke-width:2px,stroke-dasharray: 5 5
    style CB_Model fill:#fff59d,stroke:#f57f17,stroke-width:2px,stroke-dasharray: 5 5
    style DefaultFeatures fill:#ffe082,stroke:#f9a825,stroke-width:2px
    style KafkaPublish fill:#fff9c4,stroke:#f9a825,stroke-width:1px,stroke-dasharray: 5 5
    style Client fill:#e0e0e0,stroke:#424242,stroke-width:2px
    style Resilience fill:#fff,stroke:#ff6f00,stroke-width:3px,stroke-dasharray: 5 5
    style HappyPath fill:#fff,stroke:#1976d2,stroke-width:3px,stroke-dasharray: 5 5




Figure 3

flowchart TB
    Start([Transaction Completed]) -->|"Published to Kafka"| Topic{{"Kafka Topic:<br/>transactions.completed<br/>12 partitions"}}
    
    Topic -->|"Consumer Group 1<br/>6 partitions each"| PAA1["Pattern Analysis Agent<br/>Replica 1"]
    Topic -->|"Consumer Group 1<br/>6 partitions each"| PAA2["Pattern Analysis Agent<br/>Replica 2"]
    
    Topic -->|"Consumer Group 2<br/>All partitions"| MLA["Model Learning Agent<br/>Single Instance"]
    
    subgraph "Pattern Analysis Processing (200-500ms)"
        PAA1 --> G1["Update Transaction Graph<br/>Add nodes & edges"]
        PAA2 --> G2["Update Transaction Graph<br/>Add nodes & edges"]
        
        G1 --> Compute1["Compute Network Features<br/>• PageRank centrality<br/>• Clustering coefficients"]
        G2 --> Compute2["Compute Network Features<br/>• PageRank centrality<br/>• Clustering coefficients"]
        
        Compute1 --> Velocity1["Calculate Velocity Metrics<br/>• 1h, 24h, 7d windows"]
        Compute2 --> Velocity2["Calculate Velocity Metrics<br/>• 1h, 24h, 7d windows"]
        
        Velocity1 --> Redis1[("(Redis Update<br/>Feature Cache)")]
        Velocity2 --> Redis2[("(Redis Update<br/>Feature Cache)")]
        
        Velocity1 --> DB1[("(PostgreSQL Write<br/>Graph Metadata)")]
        Velocity2 --> DB2[("(PostgreSQL Write<br/>Graph Metadata)")]
    end
    
    subgraph "Model Learning (Periodic)"
        MLA --> Monitor["Continuous Drift Monitoring<br/>• PSI & F1-score"]
        
        Monitor -->|"F1 < 92% OR PSI > 0.25"| Trigger{"Drift<br/>Detected?"}
        
        Trigger -->|"Yes"| Query["Query Training Data<br/>PostgreSQL: 500k rows"]
        Trigger -->|"No"| Monitor
        
        Query --> Train["Train New Model<br/>XGBoost + SMOTE<br/>~28 s on CPU (683k IEEE-CIS rows)"]
        
        Train --> Validate["A/B Testing<br/>New vs Current"]
        
        Validate -->|"McNemar p<0.05<br/>AND ΔF1≥0.01"| Export["Export to ONNX<br/>+ scaler.npz + metadata.json<br/>Version: v{major}.{minor}"]
        Validate -->|"Not significant"| Discard["Discard New Model"]
        
        Export --> Registry["Model Registry<br/>MinIO S3"]
        
        Registry --> Metadata[("(PostgreSQL:<br/>Log Training Run)")]
    end
    
    Redis1 -.->|"Features for"| RDA["Real-Time Detection Agent"]
    Redis2 -.->|"Features for"| RDA
    Registry -.->|"Models for"| RDA
    
    style Topic fill:#ffffcc,stroke:#333,stroke-width:2px
    style PAA1 fill:#99ccff,stroke:#333,stroke-width:2px
    style PAA2 fill:#99ccff,stroke:#333,stroke-width:2px
    style MLA fill:#cc99ff,stroke:#333,stroke-width:2px
    style Train fill:#ff99cc,stroke:#333,stroke-width:3px
    style Registry fill:#ffcc99,stroke:#333,stroke-width:2px
    style Redis1 fill:#c8e6c9,stroke:#388e3c
    style Redis2 fill:#c8e6c9,stroke:#388e3c
    style DB1 fill:#cccccc,stroke:#333
    style DB2 fill:#cccccc,stroke:#333
    style RDA fill:#ff9999,stroke:#333,stroke-width:2px
    style Monitor fill:#fff9c4,stroke:#f57f17,stroke-width:2px
    style Trigger fill:#ffeb3b,stroke:#f57f17,stroke-width:2px