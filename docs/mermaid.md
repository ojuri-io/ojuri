Figure 1 — System overview
---
config:
  theme: mc
---
flowchart TB
    Client(["Server-side caller<br/>(PSP, wallet, gateway)"])
    Operator(["Operator / Analyst"])

    Client -->|"POST /v1/predict<br/>X-Api-Key + Idempotency-Key"| RDA
    RDA -->|"ACCEPT / DECLINE / REVIEW<br/>reason codes + audit_id"| Client

    Operator -->|HTTPS| UI

    subgraph FE ["Sentinel Dashboard (Vite + React)"]
        UI["Review queue · Rules · Models<br/>Features catalogue · Audit log<br/>Investigations · Users / Roles"]
    end

    UI -.->|"JWT  /v1/admin/*"| RDA
    UI -.->|"/v1/reports*"| FIA

    subgraph S1 ["Real-Time Detection Agent (RDA)"]
        RDA["Fastify HTTP API"]
        Rules["Rules Engine<br/>PRE / POST · hot-reload 30s"]
        Builder["Feature Builder<br/>catalogue-driven 64 + N dims"]
        ONNX["ONNX Runtime<br/>XGBoost · segment thresholds"]
        Reasons["Reason Codes"]
        Audit["Decision Audit"]
        RDA --> Rules --> Builder --> ONNX --> Reasons --> Audit
    end

    subgraph S2 ["Pattern Analysis Agent (PAA)"]
        PAA["Kafka consumer"]
        Graph["Transaction graph<br/>+ velocity windows"]
        PAA --> Graph
    end

    subgraph S3 ["Model Learning Agent (MLA)"]
        MLA["Drift monitor<br/>F1 + PSI"]
        Train["XGBoost + SMOTE<br/>McNemar A/B"]
        Conv["ONNX export<br/>+ feature_schema_version"]
        MLA --> Train --> Conv
    end

    subgraph S4 ["Fraud Investigation Agent (FIA)"]
        FIA["HTTP API + Kafka consumer"]
        LLM["Phi-3-mini-4k-instruct (LoRA)<br/>rule-based fallback"]
        FIA --> LLM
    end

    Redis[("Redis<br/>features:{senderId}")]
    Kafka[["Apache Kafka"]]
    PG[("PostgreSQL — fraud_db")]
    Models[("models/versions/&lt;v&gt;/<br/>filesystem registry<br/>shared bind-mount")]

    Builder <-->|"hgetall (catalogue-named keys)"| Redis
    RDA -->|"transactions.completed<br/>(keyed by sender_id)"| Kafka
    RDA -->|"transactions.blocked<br/>(keyed by transaction_id, DECLINE only)"| Kafka
    Audit -->|decisionAuditLog| PG

    Kafka -->|"transactions.completed"| PAA
    Kafka -->|"transactions.completed"| MLA
    Kafka -->|"transactions.blocked"| FIA

    Graph -->|"catalogue-named keys"| Redis
    Graph -->|"graphMetadata · velocitySnapshots"| PG

    MLA <-->|"COALESCE(groundTruthFraud, fraudLabel)"| PG
    Conv -->|"write {model.onnx, meta.json, scaler.npz}"| Models
    Conv -->|"POST /v1/admin/models &rarr; ACTIVE"| RDA
    Models -.->|"onActiveChange &rarr; hot-swap session"| ONNX

    LLM -->|"investigationReports (UNIQUE on transactionId)"| PG

    UI -->|"reviewer override (Accept / Decline)"| RDA
    Audit -->|"groundTruthFraud<br/>(closes the training loop)"| PG

    RDA -->|"HMAC-signed POST<br/>decision.created · decision.overridden · model.activated"| Subs([Subscriber endpoints])

    style FE fill:#E8F0FA,stroke:#1F4E8C,stroke-width:1px,color:#0F2C52
    style S4 fill:#FAECE7,stroke:#993C1D,stroke-width:2px,color:#4A1B0C
    style FIA fill:#FAECE7,stroke:#D85A30,stroke-width:1px,color:#4A1B0C
    style LLM fill:#F5C4B3,stroke:#D85A30,stroke-width:1px,color:#4A1B0C
    style Models fill:#FFF4D1,stroke:#8B6914,stroke-width:1px,color:#5C4500

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